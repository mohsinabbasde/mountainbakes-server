/**
 * Login identity resolver — the one place that decides what a Login History
 * row may say about WHO signed in and WITH WHAT.
 *
 * Pure functions, no I/O, no Supabase import. That is deliberate: the two rules
 * here are the security-relevant part of Login History, and keeping them free
 * of a database client is what lets `scripts/verify-login-identity.ts` run
 * them against the documented cases without an environment.
 *
 * WHAT A WEBSITE CAN AND CANNOT KNOW. Chrome shows "Signed in as
 * arifsiksavi@gmail.com" in its own profile menu; a web page has no API for
 * that — no cookie it may read, no header it is sent, nothing in `navigator`.
 * The only account this server can honestly write down is the one the person
 * AUTHENTICATED TO US with, which Supabase Auth reports on the verified token as
 * an identity with a provider name and a provider-verified email. So:
 *
 *   provider  = 'google'    → browser_email = that Google identity's email
 *   provider  = 'password'  → browser_email = null   ("Not recorded")
 *
 * and never anything read from a request body, a user agent or a guess. A
 * linked-but-unused Google identity is ALSO null: the person typed a password
 * this time, and "has a Google account on file" is not "signed in with Google".
 */

/** Everything the authenticated token says that this resolver cares about. */
export interface AuthenticatedPrincipal {
  /** Supabase auth user id — `sub` on the token. */
  uid: string;
  /** The Mountain Bakes account address off the verified token. */
  email: string;
  /**
   * The token's `amr` methods, newest first — 'oauth', 'password', 'otp',
   * 'magiclink', ... Empty when the claim is absent.
   */
  authMethods: string[];
  /**
   * The verified email of the Google identity on this account, or null. Read
   * off `getUser().identities` by `middleware/auth.ts`; never off a body.
   */
  googleEmail: string | null;
}

/** How the session was opened. 'unknown' when the token carries no `amr`. */
export type LoginProvider = 'google' | 'password' | 'otp' | 'magiclink' | 'unknown';

/**
 * The identity a Login History row records. Mirrors the shape the product
 * asked for — `auth_user_id`, `mountain_bakes_id`, `provider`,
 * `provider_email`, `browser_email` — in this codebase's camelCase.
 */
export interface LoginIdentity {
  authUserId: string;
  /** `MBU-000002` — from `users.user_code`; null when the profile has none. */
  mountainBakesId: string | null;
  provider: LoginProvider;
  /**
   * The address the identity provider vouched for. For Google, the Google
   * account; for a password login, the Mountain Bakes account itself, since
   * that is the address the password was checked against.
   */
  providerEmail: string | null;
  /**
   * The Google account the session was signed in WITH, or null. This — and
   * only this — is what the "Browser email" column shows.
   */
  browserEmail: string | null;
}

/**
 * Which provider opened THIS session.
 *
 * `amr` lists methods newest first, but a refreshed token keeps the original
 * entry, so the whole list is searched: 'oauth' anywhere means the session was
 * born from an OAuth callback (sign-in OR the identity-link flow — GoTrue
 * issues both with the `oauth` method). Mapped to 'google' only when the
 * account actually carries a verified Google identity; an OAuth session with
 * no such identity is a provider this app does not know, and is reported as
 * 'unknown' rather than guessed at.
 */
export function providerOf(principal: Pick<AuthenticatedPrincipal, 'authMethods' | 'googleEmail'>): LoginProvider {
  const methods = principal.authMethods.map((m) => m.toLowerCase());
  if (methods.includes('oauth')) return principal.googleEmail ? 'google' : 'unknown';
  if (methods.includes('password')) return 'password';
  if (methods.includes('otp')) return 'otp';
  if (methods.includes('magiclink')) return 'magiclink';
  return 'unknown';
}

/**
 * Resolve what a new session row may record about the caller.
 *
 * `mountainBakesId` is passed in rather than looked up: the resolver stays
 * pure, and the route already reads the profile for the display name.
 */
export function resolveLoginIdentity(
  principal: AuthenticatedPrincipal,
  mountainBakesId: string | null,
): LoginIdentity {
  const provider = providerOf(principal);
  const google = provider === 'google' ? principal.googleEmail : null;
  return {
    authUserId: principal.uid,
    mountainBakesId,
    provider,
    providerEmail: google ?? (provider === 'password' ? principal.email || null : null),
    browserEmail: google,
  };
}

/**
 * The second rule: may an existing row be RESUMED by this request, or has the
 * browser re-authenticated since it was written?
 *
 * WHY THIS EXISTS. The client offers back the session id it holds on every
 * dashboard mount, so a reload continues the row instead of adding one. That
 * used to be honoured on three tests — same user, not ended, seen within the
 * stale window — and none of them noticed a NEW GoTrue session. The concrete
 * failure: sign in with a password, click "Connect Google account", come back
 * from Google. GoTrue has just issued a fresh session (method `oauth`, Google
 * identity attached); the page reloads; the client offers the OLD id; the
 * server resumes the password row; Browser email stays "Not recorded" — for a
 * browser that has, at that very moment, authenticated with Google. The same
 * hole let a Google sign-in that followed a password session within ten
 * minutes inherit the earlier row.
 *
 * So a fourth test: the row's `auth_session_id` must be the caller's. When it
 * is not, the old row is over — the browser has a different session now — and
 * the honest record is two rows: the first ended with reason 'reauth', the
 * second opened with whatever identity the new token carries.
 *
 * Rows from before migration 98 have no `auth_session_id`; a token from an
 * older GoTrue has no `session_id` claim. Two nulls are treated as a match so
 * neither case opens a fresh row on every reload; a null on ONE side is a
 * mismatch, because that is precisely a session that changed shape underneath
 * the row.
 */
export type ResumeVerdict = 'resume' | 'reauthenticated' | 'not_resumable';

export function resumeVerdict(
  existing: {
    user_id: string | null;
    ended_at: string | null;
    last_seen_at: string;
    auth_session_id: string | null;
  } | null,
  caller: { userId: string; authSessionId: string | null },
  staleAfterMs: number,
  now = Date.now(),
): ResumeVerdict {
  if (!existing) return 'not_resumable';
  if (existing.user_id !== caller.userId) return 'not_resumable';
  if (existing.ended_at) return 'not_resumable';
  if (now - Date.parse(existing.last_seen_at) > staleAfterMs) return 'not_resumable';
  return (existing.auth_session_id ?? null) === (caller.authSessionId ?? null) ? 'resume' : 'reauthenticated';
}
