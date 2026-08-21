import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { StartLoginSessionSchema, LoginSessionIdSchema } from '../shared';
import { clientIp } from '../services/geofence.service';
import { startSession, touchSession, endSession, listSessions } from '../services/login-history.service';

export const router = Router();

/**
 * Login History.
 *
 * EVERY endpoint is authenticated, including the one that records a login —
 * which sounds circular and is not. The browser signs in to Supabase first and
 * already holds a verified JWT by the time it calls `/start`; this router's job
 * is to write down a login that has already happened, not to perform one. That
 * is what lets the identity on the row come off the token instead of the body:
 * no account can record a session for anybody else.
 *
 * The client sends only ids. Email, name, role and branch come from the JWT; IP
 * and user agent from the request headers.
 */
router.use(authenticate);

/**
 * How far back the list reaches, and how many rows it may return.
 *
 * The table is unpaginated on the client, so the cap is what keeps it finite.
 * An admin looking at every user burns through rows far faster than a user
 * looking at their own, which is why the ceiling is a row count rather than only
 * a window — 90 days of one person's logins is a couple of hundred rows, 90 days
 * of everybody's could be thousands.
 */
const DEFAULT_DAYS = 90;
const MAX_ROWS = 500;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

// POST /api/login-history/start — record a sign-in, or resume this browser's session.
router.post('/start', validate(StartLoginSessionSchema), async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const { resumeSessionId } = req.body as { resumeSessionId?: string };

    // display_name is not in the JWT, and the history is read by people who know
    // staff by name. One extra read, on a new session only — a resumed session
    // returns from `startSession` before this matters.
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('display_name')
      .eq('id', user.uid)
      .maybeSingle();

    const headers = req.headers as unknown as Record<string, unknown>;
    const session = await startSession({
      userId: user.uid,
      email: user.email,
      name: (profile as { display_name?: string } | null)?.display_name || user.email,
      role: user.role,
      branchId: user.branchId,
      branchName: user.branchName,
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
    next(err);
  }
});

// POST /api/login-history/ping — the open tab is still open.
router.post('/ping', validate(LoginSessionIdSchema), async (req: AuthRequest, res, next) => {
  try {
    const { sessionId } = req.body as { sessionId: string };
    const session = await touchSession(sessionId, req.user!.uid);

    // 404 rather than an error: the session was closed, expired, or belongs to
    // someone else. The client's move is the same in every case — drop the id it
    // is holding and open a fresh session — so it is told plainly rather than
    // being handed three outcomes to tell apart.
    if (!session) { res.status(404).json({ error: 'No live session with that id' }); return; }
    res.json(session);
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

/**
 * GET /api/login-history — the table.
 *
 * SCOPE IS DECIDED HERE, and it is the whole privacy story: only a super admin
 * sees other people's sessions. Every other role — branch, production and all
 * four finance roles alike — is pinned to its own `uid`, whatever it asks for.
 * The `userId` query parameter is honoured for an admin and ignored for
 * everyone else rather than rejected, because a non-admin has no way to send it
 * except by tampering, and there is nothing to explain to them.
 */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const isAdmin = user.role === 'super_admin';

    const scopeUserId = isAdmin ? ((req.query['userId'] as string | undefined) ?? null) : user.uid;
    const days = clampInt(req.query['days'], DEFAULT_DAYS, 1, 365);
    const limit = clampInt(req.query['limit'], MAX_ROWS, 1, MAX_ROWS);

    const sessions = await listSessions({ userId: scopeUserId, days, limit });
    res.json({ sessions, total: sessions.length, scope: scopeUserId ? 'self' : 'all' });
  } catch (err) {
    next(err);
  }
});
