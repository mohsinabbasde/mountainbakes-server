import type { UserRole } from './user.types';

/**
 * Login History and Active Sessions — one signed-in session.
 *
 * Reported by the client, because the app is a static export that signs in to
 * Supabase directly and the API never sees a login. See the header of migration
 * 20260822000085 for the shape of that arrangement, and 20260901000098 for what
 * was added to make an admin able to act on it rather than only read it.
 *
 * EVERYTHING IDENTIFYING IS SERVER-DERIVED. `userCode`, `userEmail`, `userRole`,
 * `branchId`, `authSessionId` come off the verified access token or off a lookup
 * keyed by it; IP and user agent come off request headers; country, city, region
 * and timezone come off an IP lookup the server performs. Nothing in this
 * interface is ever taken from a request body — see the note in the schemas file.
 */

/**
 * How a session stands right now.
 *
 * Three of these four are DERIVED ON READ, not stored:
 *
 *   active   — pinged recently and not closed
 *   ended    — the user signed out (the spec's LOGGED_OUT)
 *   expired  — no ping for long enough; the tab was closed, not signed out
 *   revoked  — an admin ended it
 *
 * `expired` in particular cannot be a stored value: moving a row into it would
 * need a sweeper, and every scheduler in this app is switched off, so the column
 * would be wrong for exactly the sessions it exists to describe.
 *
 * Note what is NOT here: `suspicious`. A suspicious session is still an active
 * one, and making suspicion a state would drop it out of the Active Sessions
 * list — the screen an admin opens because of it. It is `isSuspicious` below.
 */
export type LoginSessionState = 'active' | 'ended' | 'expired' | 'revoked';

/** Coarse device class, parsed from the user agent at insert. */
export type LoginDeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';

export interface LoginSession {
  id: string;

  // ── Identity, denormalised onto the row ──
  // `userId` goes null if the account is deleted; the code and email stay,
  // because after that delete they are the only handles that read like a person.
  userId: string | null;
  /** Mountain Bakes staff ID, `MBU-000125`. Null only for a pre-migration-98 row. */
  userCode: string | null;
  /**
   * The activated account — the address the session actually authenticated as,
   * read off the verified token, never off a form.
   *
   * MAY ARRIVE MASKED (`u***@example.com`). The API decides per caller: an admin
   * reading the detail view gets the real address, every other reader gets it
   * masked. So this field is for display only — never compare two of them, and
   * never use one as a key. `userCode` is the key.
   */
  userEmail: string;
  /** True when `userEmail` above was masked before it was sent. */
  emailMasked: boolean;
  userName: string;
  userRole: UserRole | null;
  branchId: string | null;
  branchName: string | null;

  /**
   * The GoTrue session behind this row (the token's `session_id` claim).
   *
   * The handle revocation acts on, and the only thing that makes "sign out this
   * session" mean anything. Null for a session opened before migration 98, which
   * is why the API reports such a row as un-revocable rather than pretending.
   */
  authSessionId: string | null;

  // ── Device context ──
  // Everything here originates in a header. It is evidence for a person to read,
  // never an input to a decision, and a user agent is a self-declaration that
  // routinely lies (Edge claims to be Chrome, which claims to be Safari).
  ipAddress: string | null;
  userAgent: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: LoginDeviceType | null;

  // ── Location, resolved from the IP once, when the session opened ──
  // Null whenever the lookup was skipped, refused or timed out — a normal
  // outcome, not an error. Approximate by nature: a VPN, a mobile carrier or a
  // stale geolocation database will each put a session in the wrong city.
  country: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  /** IANA zone of where the IP resolves, e.g. 'Asia/Karachi'. Not the browser's own. */
  timezone: string | null;

  loginAt: string;      // ISO UTC
  lastSeenAt: string;   // ISO UTC — bumped by every ping
  endedAt: string | null;
  endReason: 'logout' | 'expired' | 'revoked' | null;

  // ── Revocation ──
  // Kept apart from endedAt because "the user left" and "an admin removed them"
  // are different facts, and the audit trail exists for the second one.
  revokedAt: string | null;
  revokedByName: string | null;
  revokeReason: string | null;

  // ── Suspicion ──
  /** Worth a look. NEVER "this account is compromised" — see the detector's own note. */
  isSuspicious: boolean;
  /** Prose written for a person, not a code to branch on. */
  suspiciousReason: string | null;

  /** Business date of the login, 'YYYY-MM-DD' (Karachi). */
  date: string;

  // ── Derived server-side, so every client agrees ──
  /** See LoginSessionState. Computed on read from endedAt / revokedAt / lastSeenAt. */
  state: LoginSessionState;
  /** `coalesce(endedAt, lastSeenAt) - loginAt`, in milliseconds. Never stored. */
  durationMs: number;
  /**
   * Whether an admin could actually end this session.
   *
   * False for a session that is already over, and false for one with no
   * `authSessionId` — a pre-migration-98 row cannot be revoked at GoTrue, and
   * offering a button that would only relabel our own bookkeeping would be a
   * lie. The UI reads this instead of re-deriving the rule.
   */
  canRevoke: boolean;
}

/**
 * One page of login history.
 *
 * Paged server-side, unlike the dashboard card it grew out of, which fetched a
 * capped 500 rows and filtered them in the browser. `total` is the count of rows
 * MATCHING THE FILTER, not the table size, so the pager can be honest about how
 * many pages there are.
 */
export interface LoginHistoryPage {
  sessions: LoginSession[];
  total: number;
  page: number;
  pageSize: number;
  /** 'all' when an admin is looking at everybody, 'self' when scoped to one uid. */
  scope: 'all' | 'self';
}

/**
 * Every live session for one account, grouped.
 *
 * The grouping is the feature. A flat list of active sessions answers "who is
 * online"; grouping by account answers "is anybody signed in from three
 * countries at once", which is the question this screen exists for.
 */
export interface ActiveSessionGroup {
  userId: string | null;
  userCode: string | null;
  userName: string;
  /** Masked unless the caller may see it — see LoginSession.userEmail. */
  userEmail: string;
  emailMasked: boolean;
  userRole: UserRole | null;
  branchName: string | null;

  sessions: LoginSession[];
  sessionCount: number;

  /** Distinct countries currently live for this account, e.g. ['Pakistan', 'United Arab Emirates']. */
  countries: string[];
  /**
   * More than one country live at once.
   *
   * A WARNING, NOT A VERDICT. A staff member on a VPN, on a roaming SIM, or
   * behind a carrier-grade NAT whose exit node moved will trip this while doing
   * nothing wrong, and IP geolocation is regularly wrong by a whole country. It
   * means "review these sessions", and nothing in the app blocks anybody on it.
   */
  multiCountry: boolean;
  /** Any live session flagged by the detector. */
  hasSuspicious: boolean;
  /** Most recent `lastSeenAt` across the group — what the list sorts on. */
  lastSeenAt: string;
}

export interface ActiveSessionsResponse {
  groups: ActiveSessionGroup[];
  /** Live sessions across every group. */
  totalSessions: number;
  /** Accounts with at least one live session. */
  totalUsers: number;
  /** Accounts live in more than one country right now. */
  multiCountryUsers: number;
  scope: 'all' | 'self';
}

/** What a revoke call reports back. */
export interface RevokeSessionResult {
  /** Sessions marked revoked in `login_sessions`. */
  revoked: number;
  /**
   * GoTrue sessions actually deleted.
   *
   * Can legitimately be lower than `revoked`: a session whose GoTrue row had
   * already expired is still marked revoked here, and there was nothing left to
   * delete. Reported separately rather than folded in, so "we ended 3 of the 3"
   * and "we ended our record of 3 and GoTrue had already dropped 1" do not look
   * identical.
   */
  authSessionsEnded: number;
}

/** Filters the history list accepts. Every one of them is applied in SQL. */
export interface LoginHistoryFilters {
  userId?: string | null;
  /** Matches `user_code`, `user_name` or — for a caller allowed to see it — `user_email`. */
  search?: string | null;
  state?: LoginSessionState | null;
  country?: string | null;
  /** Business dates, inclusive, 'YYYY-MM-DD'. */
  from?: string | null;
  to?: string | null;
  suspiciousOnly?: boolean;
}
