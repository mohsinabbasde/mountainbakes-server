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
 * Four of these five are DERIVED ON READ, not stored:
 *
 *   active   — pinged recently and not closed
 *   idle     — still open, but has missed a few pings
 *   ended    — the user signed out (the spec's LOGGED_OUT)
 *   expired  — no ping for long enough; the tab was closed, not signed out
 *   revoked  — an admin ended it
 *
 * `expired` in particular cannot be a stored value: moving a row into it would
 * need a sweeper, and every scheduler in this app is switched off, so the column
 * would be wrong for exactly the sessions it exists to describe. `idle` has the
 * same problem twice over, since a row would have to move into it AND back out
 * again as soon as the next ping landed.
 *
 * WHAT `idle` HONESTLY MEANS, because it is easy to over-read: the tab has gone
 * quiet, NOT that the person stepped away. The ping rides a timer and fires
 * whether or not anybody is typing, so a ping proves the tab is open and nothing
 * more — a missed one means the tab was backgrounded, the laptop slept, or the
 * signal dropped. It is the tier between "checked in a moment ago" and "gone
 * long enough to call it closed", and it is worth having precisely because
 * collapsing it into `active` makes a roster of live sessions overstate how many
 * people are actually at a screen.
 *
 * Note what is NOT here: `suspicious`. A suspicious session is still an active
 * one, and making suspicion a state would drop it out of the Active Sessions
 * list — the screen an admin opens because of it. It is `isSuspicious` below.
 */
export type LoginSessionState = 'active' | 'idle' | 'ended' | 'expired' | 'revoked';

/** Coarse device class, parsed from the user agent at insert. */
export type LoginDeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';

/**
 * Where a recorded location came from — the difference between a guess about a
 * network and an observation of a device.
 *
 * Kept as data on the row rather than as a sentence in a page header, because a
 * reader who arrives at one session detail without having read the header would
 * otherwise have no way to tell which kind of claim they are looking at. See
 * `LoginSession.locationSource`.
 */
export type LocationSource = 'IP' | 'DEVICE_GPS' | 'UNKNOWN';

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
  /**
   * Device model where the user agent carries one (mostly Android), else null.
   * A guess read from an untrusted string, like every other parsed field here.
   */
  deviceName: string | null;
  /**
   * Screen dimensions as the BROWSER reported them, e.g. '1920x1080'.
   *
   * Reported by JavaScript the page ran rather than read from a header, so it is
   * forgeable in a way even the user agent is not. It earns its place by
   * answering what a user agent cannot — which of this person's two identical
   * phones this is — and the UI labels it as reported by the device.
   */
  screenSize: string | null;

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
  /**
   * How country/city/region/latitude/longitude were obtained.
   *
   * READ THIS BEFORE PRESENTING ANY OF THEM AS A PLACE A PERSON WAS. 'IP' is a
   * commercial database's opinion about which network an address belongs to —
   * accurate to a city at best, wherever the exit node is on a VPN, and
   * routinely a whole country wrong on mobile carriers. 'DEVICE_GPS' would be a
   * consented browser fix, precise to metres; nothing writes it today.
   * 'UNKNOWN' means the lookup was skipped, refused, rate-limited or timed out.
   */
  locationSource: LocationSource;
  /**
   * Centroid of whatever `locationSource` resolved, or null.
   *
   * For source=IP this is the middle of a city or a network block — NOT where
   * anybody was standing. A map pin drawn on it without saying so is a lie the
   * data does not support.
   */
  latitude: number | null;
  longitude: number | null;

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
   * True for `idle` as well as `active` — an idle session is a live one whose
   * tab has gone quiet, and it is if anything the more likely of the two to be
   * the one somebody wants ended.
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

  // Every one of these is an EXACT match on a denormalised column, not a search.
  // They exist because an admin narrowing a list by branch, by role or by
  // browser is answering a different question from the one the search box
  // answers, and folding them into it would make each of them a substring match
  // that also hit three other columns.
  /** The branch the account belonged to AT SIGN-IN, from the row, not from `users` today. */
  branchId?: string | null;
  role?: string | null;
  city?: string | null;
  /** Browser NAME only — 'Chrome', never 'Chrome 140'. Versions would fragment the filter. */
  browser?: string | null;
  deviceType?: LoginDeviceType | null;
}

/**
 * A sign-in that did not work.
 *
 * SEPARATE FROM `LoginSession` BECAUSE IT IS A DIFFERENT FACT. There is no
 * session, no Mountain Bakes account and no authenticated identity here — the
 * whole point is that authentication did not happen. The only handle on the row
 * is the address that was TYPED, which is not the same thing as an account: it
 * may be a typo, an ex-employee's address, or one that never existed.
 *
 * REPORTED BY THE CLIENT AND THEREFORE FORGEABLE. A static-export app
 * authenticates against Supabase directly, so the API never observes the
 * failure and the browser has to post it — from an endpoint that by definition
 * cannot require a token. Treat a row here as "somebody said this happened",
 * which is enough to notice an unexplained burst and not enough to act against
 * an account automatically. Nothing in the app locks anybody out on this.
 *
 * NEVER CONTAINS CREDENTIAL MATERIAL — not the password, not a hash, not its
 * length. There is no field here that could hold one.
 */
export interface LoginAttempt {
  id: string;
  /** The address as typed, lower-cased. NOT resolved to an account — see above. */
  email: string;
  reason: LoginAttemptReason;

  ipAddress: string | null;
  userAgent: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: LoginDeviceType | null;

  country: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  locationSource: LocationSource;

  attemptedAt: string;
  /** Business date of the attempt, 'YYYY-MM-DD' (Karachi). */
  date: string;
}

/**
 * Why an attempt was refused.
 *
 * A CLOSED SET, so the column can be filtered and counted, and so that rewording
 * a message on the login screen never rewrites history. The prose an admin reads
 * is built from these codes in the UI.
 *
 * `invalid_credentials` covers a wrong address AND a wrong password, because
 * Supabase deliberately does not say which — and neither should this. Splitting
 * them would turn the failed-login screen into an account-existence oracle for
 * anybody who could read it.
 */
export type LoginAttemptReason =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'no_role'
  | 'invalid_session'
  | 'expired_token'
  | 'unknown';

export const LOGIN_ATTEMPT_REASONS = [
  'invalid_credentials',
  'account_disabled',
  'email_not_confirmed',
  'rate_limited',
  'no_role',
  'invalid_session',
  'expired_token',
  'unknown',
] as const satisfies readonly LoginAttemptReason[];

/** What each refusal is called on screen. */
export const LOGIN_ATTEMPT_REASON_LABELS: Record<LoginAttemptReason, string> = {
  invalid_credentials: 'Invalid email or password',
  account_disabled: 'Account disabled',
  email_not_confirmed: 'Email not confirmed',
  rate_limited: 'Too many attempts',
  no_role: 'No role assigned',
  invalid_session: 'Invalid session',
  expired_token: 'Expired token',
  unknown: 'Unknown',
};

/** One page of failed attempts. Paged in SQL, like the history list. */
export interface LoginAttemptsPage {
  attempts: LoginAttempt[];
  total: number;
  page: number;
  pageSize: number;
}

/** Filters the failed-attempts list accepts. Every one applied in SQL. */
export interface LoginAttemptFilters {
  /** Substring of the attempted address. */
  search?: string | null;
  reason?: LoginAttemptReason | null;
  country?: string | null;
  /** Business dates, inclusive, 'YYYY-MM-DD'. */
  from?: string | null;
  to?: string | null;
}
