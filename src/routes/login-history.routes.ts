import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/requireRole';
import {
  StartLoginSessionSchema,
  LoginSessionIdSchema,
  LoginHistoryQuerySchema,
  RevokeSessionSchema,
  RevokeAllSessionsSchema,
  type LoginHistoryFilters,
} from '../shared';
import { clientIp } from '../services/geofence.service';
import { resolveAdminName } from '../services/audit.service';
import {
  SessionRevokedError,
  startSession,
  touchSession,
  endSession,
  listSessions,
  listActiveSessions,
  listCountries,
  getSession,
  revokeSession,
  revokeAllOtherSessions,
} from '../services/login-history.service';

export const router = Router();

/**
 * Login History & Active Sessions.
 *
 * EVERY endpoint is authenticated, including the one that records a login —
 * which sounds circular and is not. The browser signs in to Supabase first and
 * already holds a verified JWT by the time it calls `/start`; this router's job
 * is to write down a login that has already happened, not to perform one. That
 * is what lets the identity on the row come off the token instead of the body:
 * no account can record a session for anybody else.
 *
 * The client sends only ids. Staff code, email, name, role and branch come from
 * the JWT or from a lookup keyed by it; IP and user agent from the request
 * headers; country, city and timezone from a server-side IP lookup. Nothing
 * identifying is ever read out of a request body — see the schemas file.
 *
 * TWO PRIVILEGE LEVELS, and the line between them is drawn here rather than in
 * any service:
 *
 *   * The three client endpoints (`/start`, `/ping`, `/end`) are open to every
 *     signed-in account and act ONLY on the caller's own session.
 *   * Everything else is scoped: a super admin sees and acts on every account,
 *     everyone else is pinned to their own `uid` whatever they ask for.
 *
 * A `userId` query parameter is honoured for an admin and ignored for everyone
 * else rather than rejected, because a non-admin has no way to send one except
 * by tampering, and there is nothing to explain to them.
 */
router.use(authenticate);

/** Who may see other people's sessions, and unmasked email addresses. */
function isSecurityAdmin(role: string): boolean {
  return role === 'super_admin';
}

// ---------------------------------------------------------------------------
// The client-driven half — every signed-in account, own session only
// ---------------------------------------------------------------------------

// POST /api/login-history/start — record a sign-in, or resume this browser's session.
router.post('/start', validate(StartLoginSessionSchema), async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const { resumeSessionId } = req.body as { resumeSessionId?: string };

    // display_name and user_code are not in the JWT, and the history is read by
    // people who know staff by name and quote them by code. One extra read, on a
    // new session only — a resumed session returns from `startSession` before
    // this matters.
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('display_name, user_code')
      .eq('id', user.uid)
      .maybeSingle();
    const p = profile as { display_name?: string; user_code?: string } | null;

    const headers = req.headers as unknown as Record<string, unknown>;
    const session = await startSession({
      userId: user.uid,
      email: user.email,
      name: p?.display_name || user.email,
      role: user.role,
      userCode: p?.user_code ?? null,
      branchId: user.branchId,
      branchName: user.branchName,
      authSessionId: user.authSessionId,
      ipAddress: clientIp(headers, req.ip),
      userAgent: typeof headers['user-agent'] === 'string' ? (headers['user-agent'] as string) : null,
      resumeSessionId,
    });

    // Fire-and-forget, and deliberately not awaited: `users.last_login_at` has
    // existed since the core migration with nothing ever writing it, and this is
    // the first thing in a position to. A failure here must not fail the session
    // record, which is the column that actually matters.
    void supabaseAdmin
      .from('users')
      .update({ last_login_at: session.loginAt })
      .eq('id', user.uid)
      .then(({ error }) => { if (error) console.error('[login-history] last_login_at', error.message); });

    res.status(201).json(session);
  } catch (err) {
    // A revoked browser reloading. Answered with the same shape as the ping
    // below so the client has one revocation path, not two.
    if (err instanceof SessionRevokedError) {
      res.status(403).json({ error: err.message, details: { code: 'session_revoked' } });
      return;
    }
    next(err);
  }
});

/**
 * POST /api/login-history/ping — the open tab is still open.
 *
 * ALSO THE REVOCATION KILL-SWITCH, which is why its three outcomes are three
 * different status codes rather than one. A Supabase access token is stateless
 * and cannot be withdrawn once issued, so deleting the GoTrue session only stops
 * the browser at its next token refresh — up to an hour later. This endpoint is
 * what closes that window: the tab is already pinging every two minutes, and a
 * 403 here tells it to sign itself out now.
 */
router.post('/ping', validate(LoginSessionIdSchema), async (req: AuthRequest, res, next) => {
  try {
    const { sessionId } = req.body as { sessionId: string };
    const outcome = await touchSession(sessionId, req.user!.uid);

    if (outcome.status === 'revoked') {
      // A machine-readable code alongside the message: the client must sign out
      // on this and open a fresh session on the 404 below, and telling the two
      // apart by matching prose would break the day somebody reworded it.
      //
      // Carried under `details` rather than as a top-level field because that is
      // the only place the frontend's `apiCall` keeps — it lifts `body.details`
      // onto `ApiError.details` and discards everything else on the body, so a
      // sibling `code` would arrive nowhere. The array shape of `details` is
      // reserved for Zod field errors, which is why this is an object.
      res.status(403).json({
        error: 'This session was signed out by an administrator',
        details: { code: 'session_revoked' },
      });
      return;
    }

    // 404 rather than an error: the session was closed, expired, or belongs to
    // someone else. The client's move is the same in every case — drop the id it
    // is holding and open a fresh session — so it is told plainly rather than
    // being handed three outcomes to tell apart.
    if (outcome.status === 'gone') { res.status(404).json({ error: 'No live session with that id' }); return; }

    res.json(outcome.session);
  } catch (err) {
    next(err);
  }
});

// POST /api/login-history/end — an explicit sign-out.
router.post('/end', validate(LoginSessionIdSchema), async (req: AuthRequest, res, next) => {
  try {
    // No 404 on a miss. This runs while the user is signing out and there is
    // nothing they could do about a failure; a session that was already closed
    // or already expired is a fine outcome, not an error to report into a screen
    // that is about to be replaced by the login page.
    await endSession((req.body as { sessionId: string }).sessionId, req.user!.uid);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/login-history — the history, filtered and paged.
 *
 * SCOPE IS DECIDED HERE, and it is the whole privacy story: only a super admin
 * sees other people's sessions, and only a super admin sees an unmasked email
 * address. Every other role — branch, production and all four finance roles
 * alike — is pinned to its own `uid`, whatever it asks for.
 *
 * ADDRESSES ARE MASKED IN THIS LIST FOR EVERYONE, admin included. That looks
 * over-careful and is not: the list is opened on shared shop-floor tablets by
 * people looking for a device, a place or a time, and the staff code already
 * answers "which account is this". The full address is shown by the detail
 * endpoint, to an admin, on a deliberate click. What the admin flag buys HERE is
 * only the ability to SEARCH by address — finding a row is a different privilege
 * from having every row's address on screen.
 */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const admin = isSecurityAdmin(user.role);

    const parsed = LoginHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    const q = parsed.data;

    const filters: LoginHistoryFilters = {
      userId: admin ? (q.userId ?? null) : user.uid,
      search: q.search ?? null,
      state: q.state ?? null,
      country: q.country ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      suspiciousOnly: q.suspiciousOnly === 'true',
    };

    res.json(await listSessions({ filters, page: q.page, pageSize: q.pageSize, searchEmail: admin }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/login-history/countries — the values the country filter offers.
 *
 * Its own endpoint rather than a field on the list response, because the list is
 * paged: deriving the dropdown from the current page would give a filter whose
 * options changed every time you used it.
 */
router.get('/countries', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    res.json({ countries: await listCountries(isSecurityAdmin(user.role) ? null : user.uid) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/login-history/active — everything live right now, grouped by account.
 *
 * ADMIN ONLY, unlike the history. The history scoped to a non-admin is a useful,
 * harmless thing to put on their dashboard; a live roster of who else is signed
 * in and from where is not something a branch or production account has any use
 * for, and the group shape is built for the admin question ("is this account
 * live in three countries at once") rather than a personal one.
 */
router.get('/active', requireRole('super_admin'), async (_req: AuthRequest, res, next) => {
  try {
    res.json(await listActiveSessions({ userId: null }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/login-history/:id — one session in full.
 *
 * LAST of the GETs on purpose. `:id` is a wildcard that matches `countries` and
 * `active` just as happily as a UUID, and Express takes the first route that
 * matches — so both literal paths are registered above this one. Moving this
 * higher turns them into 404s from `getSession`, which is a confusing way to
 * lose two endpoints.
 *
 * The endpoint that reveals the activated account, so it is the one that checks
 * hardest. A non-admin may open only their OWN session, which is enforced by
 * comparing the loaded row's `user_id` — not by trusting a query parameter — and
 * answered with 404 rather than 403 on a mismatch, so the endpoint cannot be
 * used to confirm that a session id exists.
 */
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const admin = isSecurityAdmin(user.role);
    const session = await getSession(String(req.params['id']), admin);

    if (!admin && session.userId !== user.uid) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Ending somebody else's session — super admin only
// ---------------------------------------------------------------------------

/**
 * POST /api/login-history/:id/revoke — sign out one session.
 *
 * Super admin only, and audited. The service does the two things that make this
 * real — deletes the GoTrue session so the refresh token dies, and marks the row
 * so the target's next ping signs it out — and reports both counts back, which
 * the UI shows rather than rounding into "done": "ended 1 of 1" and "our record
 * closed, the authentication session had already lapsed" are different outcomes
 * and an admin acting on a suspected compromise should be able to tell them
 * apart.
 */
router.post(
  '/:id/revoke',
  requireRole('super_admin'),
  validate(RevokeSessionSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const user = req.user!;
      const { reason } = req.body as { reason?: string };
      const result = await revokeSession(
        String(req.params['id']),
        { id: user.uid, name: await resolveAdminName(user.uid, user.email) },
        reason ?? null,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/login-history/revoke-all — sign out every session for one account.
 *
 * THE ADMIN'S OWN BROWSER IS SPARED WHEN THEY CLEAR THEIR OWN ACCOUNT, and that
 * is decided HERE from the verified token rather than trusted from the body. An
 * admin who signs out every session on their own account and is thereby signed
 * out themselves is locked out in the middle of whatever prompted the action —
 * so the caller's own `session_id` claim is passed through as the one to keep,
 * and a client that forgets to ask for it is protected anyway.
 *
 * `keepSessionId` remains for the explicit case and is honoured only when it
 * belongs to the account being cleared (checked in the service), so passing
 * somebody else's id spares nothing rather than reaching across accounts.
 *
 * A collection-level path rather than `/:id/...`, because it acts on an ACCOUNT
 * and not on one session — the spared session is an exception it carries, not
 * the thing it operates on.
 */
router.post(
  '/revoke-all',
  requireRole('super_admin'),
  validate(RevokeAllSessionsSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const user = req.user!;
      const { userId, keepSessionId, reason } = req.body as {
        userId: string;
        keepSessionId?: string;
        reason?: string;
      };
      const result = await revokeAllOtherSessions(
        userId,
        {
          sessionId: keepSessionId ?? null,
          // Only when clearing their OWN account. Passing it while clearing
          // somebody else's would spare a session that cannot be in the target
          // set anyway, and would read as though it could.
          authSessionId: userId === user.uid ? user.authSessionId : null,
        },
        { id: user.uid, name: await resolveAdminName(user.uid, user.email) },
        reason ?? null,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);
