import type { UserRole } from './user.types';

/**
 * Login History — one signed-in session.
 *
 * Reported by the client, because the app is a static export that signs in to
 * Supabase directly and the API never sees a login. See the header of migration
 * 20260822000085 for the full shape of that arrangement.
 */

/**
 * How a session stands right now.
 *
 * `expired` is not a stored value on the row — it is what a session with no
 * recent ping is called when it is read. The distinction from `ended` is worth
 * keeping: `ended` means the user signed out, `expired` means the tab went
 * quiet, which is what closing a laptop looks like.
 */
export type LoginSessionState = 'active' | 'ended' | 'expired';

export interface LoginSession {
  id: string;

  // Identity, denormalised onto the row. `userId` goes null if the account is
  // deleted; the email stays, because it is what the history is read by.
  userId: string | null;
  userEmail: string;
  userName: string;
  userRole: UserRole | null;
  branchId: string | null;
  branchName: string | null;

  // Device context. Everything here originates in a header and is evidence for a
  // person to read, never an input to a decision.
  ipAddress: string | null;
  userAgent: string | null;

  // Resolved from the IP once, when the session opened. Null whenever the lookup
  // was skipped, refused or timed out — which is a normal outcome, not an error.
  country: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;

  loginAt: string;      // ISO UTC
  lastSeenAt: string;   // ISO UTC — bumped by every ping
  endedAt: string | null;
  endReason: 'logout' | 'expired' | null;

  /** Business date of the login, 'YYYY-MM-DD' (Karachi). */
  date: string;

  // ── Derived server-side, so every client agrees ──
  /** See LoginSessionState. Computed on read from lastSeenAt. */
  state: LoginSessionState;
  /** `coalesce(endedAt, lastSeenAt) - loginAt`, in milliseconds. Never stored. */
  durationMs: number;
}
