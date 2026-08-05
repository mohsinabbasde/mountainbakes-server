import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import {
  canAccessFinance,
  FinanceLoginLookupSchema,
  ForgotPasswordSchema,
  StrongPasswordSchema,
} from '../shared';
import { logAudit } from '../services/audit.service';

export const router = Router();

// ─── Finance User ID → email (PUBLIC — the user is signing in) ────────────────
//
// The Finance login asks for a "Finance User ID", which the brief is explicit
// about: accounts staff are issued an ID, not an email address. Supabase Auth
// only understands email/password, so the ID has to be resolved before the
// browser can sign in — and resolving it needs the `users` table, which no
// browser may read. Hence a public endpoint on this API rather than a client
// lookup.
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

    const { data, error } = await supabaseAdmin
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
// Admin accounts only. Returns { allowed: true } so the client may then trigger
// Supabase's built-in reset email; non-admin / unknown emails get a 403 with a
// fixed message (we never confirm whether a non-admin email exists).
router.post('/forgot-password', async (req, res, next) => {
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
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('role')
        .eq('email', parsed.data.email)
        .maybeSingle();
      role = error ? undefined : (data?.role ?? undefined);
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

    res.json({ allowed: true });
  } catch (err) {
    next(err);
  }
});

// ─── Change own password (any authenticated user) ─────────────────────────────
// Used by the forced "Change Password" screen. Clears the must-change flag.
router.post('/change-password', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ newPassword: StrongPasswordSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password does not meet the requirements', details: parsed.error.errors });
      return;
    }

    const uid = req.user!.uid;

    // Set the new password and clear mustChangePassword, preserving the other
    // app_metadata claims (role / branch).
    const { data: current, error: getErr } = await supabaseAdmin.auth.admin.getUserById(uid);
    if (getErr || !current.user) throw getErr ?? new Error('User not found');

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
      password: parsed.data.newPassword,
      app_metadata: { ...(current.user.app_metadata ?? {}), mustChangePassword: false },
    });
    if (updErr) throw updErr;

    // Mirror the cleared flag onto the users row. Deliberately best-effort: the
    // password has already been changed in Auth by this point, so a failure here
    // must not fail the request. app_metadata (above) is what the app actually
    // gates on; this row is the reporting copy. The supabase-js client returns
    // errors rather than throwing, so the error is discarded explicitly.
    // updated_at is maintained by the users_touch trigger — do not set it here.
    await supabaseAdmin
      .from('users')
      .update({ must_change_password: false })
      .eq('id', uid);

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

// Set app_metadata claims (role + branch) on a Supabase Auth user
router.post('/set-custom-claims', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { uid, role, branchId, branchName } = req.body as {
      uid: string;
      role: string;
      branchId: string | null;
      branchName: string | null;
    };

    if (!uid || !role) {
      res.status(400).json({ error: 'uid and role are required' });
      return;
    }

    const { data: current, error: getErr } = await supabaseAdmin.auth.admin.getUserById(uid);
    if (getErr || !current.user) throw getErr ?? new Error('User not found');

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
      app_metadata: {
        ...(current.user.app_metadata ?? {}),
        role,
        branchId: branchId ?? null,
        branchName: branchName ?? null,
      },
    });
    if (updErr) throw updErr;

    res.json({ success: true, message: 'Custom claims set successfully' });
  } catch (err) {
    next(err);
  }
});

// Get current user info from token
router.get('/me', authenticate, async (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

// Reset user password (admin only)
router.post('/reset-password', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { uid, newPassword } = req.body as { uid: string; newPassword: string };
    const { error } = await supabaseAdmin.auth.admin.updateUserById(uid, { password: newPassword });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
