import { z } from 'zod';

/**
 * Login History and Active Sessions — inputs.
 *
 * NOTE WHAT IS NOT HERE, on any schema in this file: email, user id, staff code,
 * role, branch, IP, country, city, browser, session id. Every one of them is
 * taken from the verified access token, from a lookup keyed by it, or from the
 * request headers, server-side.
 *
 * That is the whole security posture of this feature in one sentence. Accepting
 * any identifying field from a body would let an account write a login history
 * describing somebody else — and a history that can be forged is worse than none,
 * because it is believed. The one id a client may send is a session id it was
 * given, and the server checks ownership on that before honouring it.
 */

/**
 * Open a session — or carry on with the one this browser already has.
 *
 * `resumeSessionId` is what stops a page reload counting as a fresh login. The
 * client keeps the id it was given and offers it back; the server honours it
 * only if the session really belongs to the caller and is still live, and mints
 * a new one otherwise. So a stale id left in storage overnight is harmless.
 */
export const StartLoginSessionSchema = z.object({
  resumeSessionId: z.string().uuid().optional(),
  /**
   * The one piece of DEVICE detail a header cannot carry.
   *
   * It is an exception to the rule above and stays one on purpose: it is not
   * identifying, it cannot be used to attribute a session to anybody, and the
   * worst a client can do by lying is put a wrong resolution in a cell that is
   * labelled as reported by the device. The pattern is enforced so the column
   * holds a resolution and not an arbitrary 32-character string.
   */
  screenSize: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
});

/** Keep a session alive, or close it. Both carry only the id. */
export const LoginSessionIdSchema = z.object({
  sessionId: z.string().uuid(),
});

/**
 * An admin ending one session.
 *
 * The reason is optional prose that lands in the audit trail and in
 * `login_sessions.revoke_reason`. Capped rather than unbounded because it is
 * written into two tables and rendered in a dialog; 300 characters is a sentence
 * of explanation, which is what it is for.
 *
 * The session being revoked is a PATH parameter, not a body field — a
 * destructive action reads better in the URL it acts on, and it keeps this
 * schema from being reusable against the wrong session by accident.
 */
export const RevokeSessionSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

/**
 * An admin ending every OTHER session for one account.
 *
 * `keepSessionId` is optional and means "spare this one" — it is how an admin
 * clears their own other devices without ejecting the browser they are sitting
 * at. It is validated as belonging to the same target user server-side; sending
 * somebody else's id spares nothing rather than reaching across accounts.
 */
export const RevokeAllSessionsSchema = z.object({
  userId: z.string().uuid(),
  keepSessionId: z.string().uuid().optional(),
  reason: z.string().trim().max(300).optional(),
});

/**
 * The history list's filters.
 *
 * A QUERY-STRING schema, so every field arrives as a string and is coerced here
 * rather than in the handler — the alternative is each route re-parsing `page`
 * slightly differently and paging quietly disagreeing between screens.
 *
 * `pageSize` is capped at 100. The cap is not politeness: this list is the one
 * endpoint that can be asked for every account's rows at once, and an uncapped
 * page size turns it into a way to pull the whole table in a single request.
 */
export const LoginHistoryQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  state: z.enum(['active', 'idle', 'ended', 'expired', 'revoked']).optional(),
  country: z.string().trim().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  suspiciousOnly: z.enum(['true', 'false']).optional(),
  // Exact-match narrowings, each on a column denormalised onto the session row.
  // `branchId` and `role` are the branch and role the account held AT SIGN-IN,
  // which is the whole reason they are filterable here rather than by joining
  // `users` — a person who moved branch last month should still be findable
  // under the branch they were signing in for at the time.
  branchId: z.string().uuid().optional(),
  role: z.string().trim().max(40).optional(),
  city: z.string().trim().max(80).optional(),
  browser: z.string().trim().max(40).optional(),
  deviceType: z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type StartLoginSessionInput = z.infer<typeof StartLoginSessionSchema>;
export type LoginSessionIdInput = z.infer<typeof LoginSessionIdSchema>;
export type RevokeSessionInput = z.infer<typeof RevokeSessionSchema>;
export type RevokeAllSessionsInput = z.infer<typeof RevokeAllSessionsSchema>;
export type LoginHistoryQueryInput = z.infer<typeof LoginHistoryQuerySchema>;

/**
 * Record a sign-in that FAILED.
 *
 * THE ONE SCHEMA IN THIS FILE WHOSE ENDPOINT HAS NO TOKEN BEHIND IT, and it
 * could not have one: authentication is what just failed, so there is nothing
 * verified to derive anything from. That inverts the posture the rest of the
 * file describes, and the schema is written to give the inversion as little to
 * work with as possible.
 *
 * `email` IS ACCEPTED FROM THE BODY, unavoidably — it is the address that was
 * typed, and nothing else in the request knows it. It is therefore a CLAIM about
 * what somebody entered, never an identity: the API stores it as typed and never
 * resolves it to an account. Everything else on the stored row (IP, user agent,
 * resolved city, business date) still comes from the request headers or the
 * server.
 *
 * NOT VALIDATED AS AN EMAIL, deliberately. Somebody who typed their username, or
 * a stray keystroke, produced a real failed attempt and the record of it should
 * not be silently dropped because the string was not RFC-shaped. It is capped,
 * trimmed and lower-cased instead.
 *
 * THERE IS NO PASSWORD FIELD AND THERE NEVER WILL BE. Nothing about the
 * credential — not its value, not a hash, not its length — may be sent to or
 * stored by this endpoint.
 */
export const RecordLoginAttemptSchema = z.object({
  email: z.string().trim().min(1).max(255),
  reason: z
    .enum([
      'invalid_credentials',
      'account_disabled',
      'email_not_confirmed',
      'rate_limited',
      'no_role',
      'invalid_session',
      'expired_token',
      'unknown',
    ])
    // Defaulted rather than required: a client that hits an error it has no code
    // for should still be able to file the attempt, and 'unknown' is a truthful
    // answer where inventing a specific reason would not be.
    .default('unknown'),
});

/**
 * The failed-attempts list's filters.
 *
 * A query-string schema like `LoginHistoryQuerySchema`, and capped at the same
 * 100 rows a page for the same reason: this endpoint can be asked for every
 * attempt ever recorded, and an uncapped page size is a way to pull the whole
 * table — here, a table of addresses — in one request.
 */
export const LoginAttemptsQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  reason: z
    .enum([
      'invalid_credentials',
      'account_disabled',
      'email_not_confirmed',
      'rate_limited',
      'no_role',
      'invalid_session',
      'expired_token',
      'unknown',
    ])
    .optional(),
  country: z.string().trim().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type RecordLoginAttemptInput = z.infer<typeof RecordLoginAttemptSchema>;
export type LoginAttemptsQueryInput = z.infer<typeof LoginAttemptsQuerySchema>;
