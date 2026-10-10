import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import {
  canAccessFinance,
  FinanceLoginLookupSchema,
  ForgotPasswordSchema,
  StrongPasswordSchema,
} from '../shared';
import { logAudit } from '../services/audit.service';
import {
  RESET_TOKEN_TTL_MINUTES,
  changeOwnPassword,
  createPasswordResetToken,
  endSession,
  refreshSession,
  resetPasswordWithToken,
  signIn,
} from '../services/auth/auth.service';
import { sendPasswordResetEmail } from '../services/mailer';

const db = dbFor('auth');

export const router = Router();

/**
 * The address a request came from, for counting attempts against.
 *
 * The app does not set `trust proxy`, so `req.ip` is the hosting router, the
 * same for everyone. The router appends the address it actually received the
 * connection from as the LAST entry of X-Forwarded-For; anything before that
 * was supplied by the caller and can say whatever the caller likes. A limit
 * keyed on the first entry is one an attacker resets by changing a header.
 */
function callerAddress(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').map((p) => p.trim()).filter(Boolean);
  return chain[chain.length - 1] ?? req.ip ?? 'unknown';
}

// ─── Sign in, stay signed in, sign out ────────────────────────────────────────
//
// The API's own sign-in. A client posts an email (or a username) and a
// password and gets back two tokens: a short-lived access token to send as
// `Authorization: Bearer …`, and a refresh token to exchange for the next pair.
// Role and branch come back alongside, in `user`.

// Counted per address AND per account, failures only: ten wrong passwords for
// one account from one place in fifteen minutes. A shop's worth of tills behind
// one address each signing in correctly never touches it.
const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // The address is read from X-Forwarded-For on purpose (see callerAddress),
  // which the library's own checks would otherwise warn about.
  validate: false,
  keyGenerator: (req) => {
    const who = typeof req.body?.identifier === 'string' ? req.body.identifier : typeof req.body?.email === 'string' ? req.body.email : '';
    return `${callerAddress(req)}|${who.trim().toLowerCase()}`;
  },
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

const SignInSchema = z
  .object({
    // `identifier` is an email address or a username; `email` is accepted as
    // another name for it.
    identifier: z.string().trim().min(1).max(320).optional(),
    email: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(1024),
    client: z.enum(['web', 'mobile']).optional(),
  })
  .refine((d) => d.identifier || d.email);

router.post('/login', signInLimiter, async (req, res, next) => {
  try {
    const parsed = SignInSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter your email and password.' });
      return;
    }
    const session = await signIn({
      identifier: (parsed.data.identifier ?? parsed.data.email)!,
      password: parsed.data.password,
      client: parsed.data.client,
    });
    res.json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const parsed = z.object({ refreshToken: z.string().min(1).max(512) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A refresh token is required.' });
      return;
    }
    res.json(await refreshSession(parsed.data.refreshToken));
  } catch (err) {
    next(err);
  }
});

// Ends THIS device's session; the account's other devices stay signed in.
router.post('/logout', authenticate, async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.authSessionId) await endSession(req.user!.authSessionId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Finance User ID → email (PUBLIC — the user is signing in) ────────────────
//
// The Finance login asks for a "Finance User ID", which the brief is explicit
// about: accounts staff are issued an ID, not an email address. The Finance
// login screen resolves the ID to the account's email here and then signs in
// with that email.
//
// It is an account-enumeration surface, and it is treated as one:
//   * the SAME message and the same 404 for an unknown ID, a non-finance
//     account, and a deactivated one — a caller learns nothing about which;
//   * its own rate limit, far tighter than the app-wide 500/15min, because
//     guessing IDs is the only thing this endpoint can be abused for;
//   * it returns an email and NOTHING else. No name, no role, no confirmation
//     that a password will work. Knowing the address gets an attacker no
//     further than the sign-in form they were already looking at.
const financeLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

router.post('/finance-lookup', financeLookupLimiter, async (req, res, next) => {
  try {
    const parsed = FinanceLoginLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter your Finance User ID.' });
      return;
    }

    const raw = parsed.data.userId.trim();
    // An email is accepted too, so an admin who only knows the address is not
    // locked out of their own module. Usernames are stored lowercase.
    const isEmail = raw.includes('@');
    const column = isEmail ? 'email' : 'username';

    const { data, error } = await db
      .from('users')
      .select('email, role, status')
      .eq(column, raw.toLowerCase())
      .maybeSingle();

    const denied = () => {
      res.status(404).json({
        error: 'No Finance account matches that User ID.',
        code: 'finance-account-not-found',
      });
    };

    if (error || !data) { denied(); return; }
    if (!canAccessFinance(data.role)) { denied(); return; }
    if (data.status !== 'active') { denied(); return; }

    res.json({ email: data.email });
  } catch (err) {
    next(err);
  }
});

// ─── Password recovery (PUBLIC — user is logged out) ──────────────────────────
// Admin accounts only; non-admin / unknown emails get a 403 with a fixed message
// (we never confirm whether a non-admin email exists).
//
// The apps send { email, deliver: true } and the API mails the reset link.
// Without `deliver` the answer is the same { allowed: true } and nothing is
// sent: the question "may this address reset?" on its own.
// Counted per caller address (see callerAddress, as for sign-in). Left
// to the library's default it would be counted per PROXY address, which is one
// bucket for everybody — and anyone could then use up the administrators'
// allowance for them.
const perAddress = (max: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => callerAddress(req),
    message: { error: 'Too many requests. Please wait a few minutes and try again.' },
  });
const forgotPasswordLimiter = perAddress(10);
const resetConfirmLimiter = perAddress(20);

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    // Role is read from the `users` table. Unknown emails resolve to undefined —
    // treated the same as a non-admin, so this endpoint never reveals whether a
    // given address exists. maybeSingle() returns null rather than erroring on
    // no match, which keeps that indistinguishable from a genuine lookup failure.
    let role: string | undefined;
    let account: { id: string; email: string; status: string } | null = null;
    try {
      const { data, error } = await db
        .from('users')
        .select('id, email, role, status')
        .eq('email', parsed.data.email)
        .maybeSingle();
      role = error ? undefined : (data?.role ?? undefined);
      account = error ? null : data;
    } catch {
      role = undefined;
    }

    if (role !== 'super_admin') {
      res.status(403).json({
        error: 'Password recovery is only available for Administrator accounts. Please contact your system administrator.',
        code: 'not-admin',
      });
      return;
    }

    if (req.body?.deliver === true && account?.status === 'active') {
      const token = await createPasswordResetToken(account.id);
      await sendPasswordResetEmail(account.email, token, RESET_TOKEN_TTL_MINUTES);
    }

    res.json({ allowed: true });
  } catch (err) {
    next(err);
  }
});

// ─── Choose a new password with the link from a reset email (PUBLIC) ──────────
router.post('/password-reset/confirm', resetConfirmLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ token: z.string().min(1).max(512), newPassword: StrongPasswordSchema }).safeParse(req.body);
    if (!parsed.success) {
      const badPassword = parsed.error.errors.some((e) => e.path[0] === 'newPassword');
      res.status(400).json(
        badPassword
          ? { error: 'Password does not meet the requirements', details: parsed.error.errors }
          : { error: 'This password reset link is invalid or has expired. Request a new one.', details: { code: 'reset_link_invalid' } },
      );
      return;
    }

    const who = await resetPasswordWithToken(parsed.data.token, parsed.data.newPassword);
    await logAudit({
      action: 'password_changed',
      adminId: who.userId,
      adminName: who.email,
      targetUserId: who.userId,
      targetUserName: who.email,
      targetUserRole: null,
      details: 'Password reset with an emailed link',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Change own password (any authenticated user) ─────────────────────────────
// Used by the forced "Change Password" screen. Clears the must-change flag, and
// signs out every other device the account is signed in on.
router.post('/change-password', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ newPassword: StrongPasswordSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password does not meet the requirements', details: parsed.error.errors });
      return;
    }

    const uid = req.user!.uid;
    // Every other device is signed out; this one keeps its session.
    await changeOwnPassword(uid, parsed.data.newPassword, req.user!.authSessionId);

    await logAudit({
      action: 'password_changed',
      adminId: uid,
      adminName: req.user!.email,
      targetUserId: uid,
      targetUserName: req.user!.email,
      targetUserRole: req.user!.role,
      details: 'User changed their own password',
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Get current user info from token
router.get('/me', authenticate, async (req: AuthRequest, res) => {
  res.json({ user: req.user });
});
