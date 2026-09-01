import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { USER_ROLES, type UserRole } from '../shared';

/**
 * Revoked GoTrue sessions this process has already seen.
 *
 * WHY THIS CACHE EXISTS AT ALL. The check below runs on EVERY authenticated
 * request in the app, and an uncached version would add a database round-trip to
 * each one — a real cost paid on every screen to catch a condition that is rare
 * by construction. So the answer is remembered, asymmetrically:
 *
 *   * A revocation is remembered FOREVER (until the process restarts). It cannot
 *     be undone — `revoke_auth_session` deletes the GoTrue row and there is no
 *     un-revoke — so a cached `true` can never go stale in the dangerous
 *     direction.
 *   * "Not revoked" is remembered for one minute only, and that TTL is the
 *     enforcement lag: a session revoked by an admin keeps working for at most a
 *     minute after its next cached negative, against the up-to-an-hour window
 *     that existed when the access token's own lifetime was the only bound.
 *
 * BOUNDED. The negative map is capped and cleared wholesale rather than evicted
 * entry by entry; the cost of a cold cache is one extra query per live session,
 * which is not worth an LRU to avoid. The revoked set is not capped because its
 * membership is the number of sessions an admin has ever ended on this dyno,
 * which is small and self-limiting.
 *
 * PER-PROCESS, like `utils/cache.ts` and for the same reason: the deploy is a
 * single dyno. On a horizontally scaled API each instance would learn about a
 * revocation independently, within its own TTL — still bounded, still far better
 * than a token lifetime, and worth swapping for Redis if that day comes.
 */
const revokedSessions = new Set<string>();
const notRevokedUntil = new Map<string, number>();
const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_CACHE_MAX = 2_000;

/**
 * Has an admin signed this GoTrue session out?
 *
 * FAILS OPEN, deliberately and in exactly one direction: a database error
 * answers "not revoked". This runs in front of every request in the app, so a
 * transient failure here that failed CLOSED would sign the entire company out of
 * a working system to enforce a revocation that has probably not happened. The
 * revocation still stands at GoTrue — the session row is deleted, so the browser
 * dies at its next token refresh regardless of this check — and this is the
 * faster of two mechanisms, not the only one.
 */
async function isRevoked(authSessionId: string | null): Promise<boolean> {
  if (!authSessionId) return false;
  if (revokedSessions.has(authSessionId)) return true;

  const fresh = notRevokedUntil.get(authSessionId);
  if (fresh !== undefined && fresh > Date.now()) return false;

  const { data, error } = await supabaseAdmin
    .from('login_sessions')
    .select('id')
    .eq('auth_session_id', authSessionId)
    .not('revoked_at', 'is', null)
    .limit(1);

  if (error) {
    console.error('[auth] revocation check failed', error.message);
    return false;
  }

  if ((data?.length ?? 0) > 0) {
    revokedSessions.add(authSessionId);
    notRevokedUntil.delete(authSessionId);
    return true;
  }

  if (notRevokedUntil.size >= NEGATIVE_CACHE_MAX) notRevokedUntil.clear();
  notRevokedUntil.set(authSessionId, Date.now() + NEGATIVE_TTL_MS);
  return false;
}

/**
 * Driven off the shared USER_ROLES list rather than a literal copy. The literal
 * version had to be remembered when the four Finance Ledger roles were added in
 * migration 51 — and forgetting it fails CLOSED but silently: a correctly
 * provisioned finance account gets "Account has no role assigned" and nothing in
 * the logs points at this line.
 */
const VALID_ROLES = new Set<UserRole>(USER_ROLES);

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email: string;
    role: UserRole;
    branchId: string | null;
    branchName: string | null;
    /**
     * The GoTrue session this token belongs to (`session_id` claim).
     *
     * Login History records it so an admin can later revoke THIS browser rather
     * than every browser the account owns, and the ping uses it to notice that
     * the session it is pinging for has been revoked underneath it.
     *
     * Null when the claim is absent — a token minted by an older GoTrue, or one
     * issued for a flow that has no session behind it. Callers must treat that
     * as "this session cannot be revoked", never as "revoke everything".
     */
    authSessionId: string | null;
  };
}

/**
 * Read the `session_id` claim out of an access token.
 *
 * DECODING, NOT VERIFYING — and that is only safe because of where it is called:
 * strictly after `supabaseAdmin.auth.getUser(token)` has already verified the
 * signature and expiry against Supabase. At that point the payload is known
 * authentic and pulling one more claim out of it is free, where a second
 * round-trip to learn it would not be. Calling this anywhere else, on a token
 * that has not been through `getUser`, would be trusting a string the caller
 * wrote.
 *
 * `getUser` does not return the session id itself, which is the whole reason
 * this exists.
 *
 * Every failure returns null. A malformed segment, a payload that is not JSON, a
 * claim that is not a string: all of them mean "no session id", and none of them
 * may throw — a token that verified must not then be rejected because an
 * optional claim was unreadable.
 */
function sessionIdFromToken(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { session_id?: unknown };
    return typeof claims.session_id === 'string' && claims.session_id ? claims.session_id : null;
  } catch {
    return null;
  }
}

/**
 * Verify the caller's Supabase access token (sent as `Authorization: Bearer <jwt>`)
 * and attach the resolved identity to `req.user`.
 *
 * Role / branch come from the user's `app_metadata` (server-controlled claims that
 * Supabase embeds in the JWT).
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  const meta = (data.user.app_metadata ?? {}) as {
    role?: UserRole;
    branchId?: string | null;
    branchName?: string | null;
  };

  // Fail CLOSED. A Supabase account with no (or an unrecognized) `role` claim gets
  // no access at all — never a default role. Accounts are provisioned by
  // POST /api/users, which always sets the claim; anything reaching here without
  // one is either a self-signup or a misprovisioned user, and must be rejected.
  if (!meta.role || !VALID_ROLES.has(meta.role)) {
    res.status(403).json({ error: 'Forbidden: Account has no role assigned' });
    return;
  }

  // Safe here and nowhere earlier: `getUser` above has already verified this
  // exact token. See sessionIdFromToken.
  const authSessionId = sessionIdFromToken(token);

  /*
   * A session an admin has ended does not get to keep working.
   *
   * WHY THIS IS NEEDED WHEN THE GoTrue SESSION IS ALREADY DELETED. A Supabase
   * ACCESS token is stateless: it carries its own signature and expiry, and
   * `getUser` above accepts it on those alone. Deleting the session behind it
   * kills the REFRESH — the browser cannot mint another token — but the one it
   * is holding stays valid until it lapses, up to an hour later. Without this
   * check, "sign this device out" means "sign it out within the hour", which is
   * not what the button says and not what an admin acting on a suspected
   * compromise needs.
   *
   * THE THIRD OF THREE MECHANISMS, and the only one that covers every request:
   *
   *   1. `revoke_auth_session` deletes the GoTrue session — permanent, but
   *      invisible until a refresh falls due.
   *   2. The Login History ping answers 403 and the client signs itself out —
   *      fast, but only for a client that keeps pinging and chooses to obey.
   *   3. This — every protected endpoint, regardless of what the client does.
   *
   * A tampered client that stops pinging defeats (2) and is stopped here.
   *
   * ANSWERED WITH THE SAME `session_revoked` CODE the ping uses, so the frontend
   * has one revocation path rather than two: `apiCall` lifts `body.details` onto
   * its error, the client recognises the code and tears the session down. 401
   * rather than 403 because the credential itself is no longer good — which is
   * also what makes the frontend's existing refresh-and-retry do the right thing
   * and give up.
   */
  if (await isRevoked(authSessionId)) {
    res.status(401).json({
      error: 'This session was signed out by an administrator',
      details: { code: 'session_revoked' },
    });
    return;
  }

  req.user = {
    uid: data.user.id,
    email: data.user.email ?? '',
    role: meta.role,
    branchId: meta.branchId ?? null,
    branchName: meta.branchName ?? null,
    authSessionId,
  };
  next();
}
