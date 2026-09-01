import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { USER_ROLES, type UserRole } from '../shared';

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

  req.user = {
    uid: data.user.id,
    email: data.user.email ?? '',
    role: meta.role,
    branchId: meta.branchId ?? null,
    branchName: meta.branchName ?? null,
    // Safe here and nowhere earlier: `getUser` above has already verified this
    // exact token. See sessionIdFromToken.
    authSessionId: sessionIdFromToken(token),
  };
  next();
}
