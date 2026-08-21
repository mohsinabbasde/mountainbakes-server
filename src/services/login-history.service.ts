import { supabaseAdmin } from '../config/supabase';
import { businessDateStr, businessDaysAgoStr, type LoginSession, type LoginSessionState } from '../shared';
import { rowToApi } from '../utils/case';
import { lookupIp } from './geoip.service';

/**
 * Login History — opening, keeping and reading sessions.
 *
 * The client drives all three because it has to: the app is a static export
 * that signs in to Supabase from the browser, so the API is never in the request
 * path of a login and cannot observe one. Everything identifying still comes off
 * the verified JWT here, never off the body.
 *
 * See the header of migration 20260822000085 for the table's own reasoning.
 */

/**
 * Silence after which an un-ended session is read as expired.
 *
 * The client pings on its existing 2-minute refresh tick, so this is five missed
 * pings. Generous on purpose: a laptop that sleeps for four minutes, a phone
 * that backgrounds the tab and a spell of bad signal are all ordinary, and
 * calling any of them "logged out" would make the duration column lie in the
 * direction that matters least — nobody is harmed by a session that reads five
 * minutes longer than it was, and a session chopped into fragments every time a
 * screen locked would be useless.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** Row shape as stored, before `rowToApi`. */
interface SessionRow {
  id: string;
  user_id: string | null;
  last_seen_at: string;
  ended_at: string | null;
}

/**
 * Fill in the two fields the table does not store.
 *
 * Duration is `coalesce(ended, last seen) − login` — for a signed-out session
 * that is exact, and for one that simply went quiet it is the last moment the
 * tab was known to be open, which is the most that can honestly be claimed.
 * Clamped at zero because clock skew between the dyno and Postgres could
 * otherwise produce a negative.
 */
function derive(row: Record<string, unknown>): { state: LoginSessionState; durationMs: number } {
  const loginAt = Date.parse(String(row['loginAt']));
  const lastSeen = Date.parse(String(row['lastSeenAt']));
  const endedAtRaw = row['endedAt'];
  const endedAt = endedAtRaw ? Date.parse(String(endedAtRaw)) : null;

  const finish = endedAt ?? lastSeen;
  const durationMs = Number.isFinite(loginAt) && Number.isFinite(finish) ? Math.max(0, finish - loginAt) : 0;

  const state: LoginSessionState = endedAt
    ? 'ended'
    : Date.now() - lastSeen > STALE_AFTER_MS
      ? 'expired'
      : 'active';

  return { state, durationMs };
}

function toApi(row: unknown): LoginSession {
  const { businessDate, ...rest } = rowToApi<Record<string, unknown>>(row);
  const base = { ...rest, date: businessDate } as Record<string, unknown>;
  return { ...base, ...derive(base) } as unknown as LoginSession;
}

/**
 * Open a session, or resume the one this browser already holds.
 *
 * RESUME IS THE INTERESTING HALF. Without it every page reload would be a new
 * login: the client re-runs its start call on mount, and the history would fill
 * with one-second sessions. So the client offers back the id it was given, and
 * it is honoured only when the session is genuinely still this user's and still
 * live. A resumed session is also PINGED, not merely accepted — a reload is
 * proof the tab is open, and the session should not expire because the user
 * happened to reload just before the next tick.
 *
 * The ownership check is the security-relevant part: `user_id` must match the
 * caller's. Without it, one account could pass another's session id and extend —
 * or, on end, close — somebody else's row.
 */
export async function startSession(params: {
  userId: string;
  email: string;
  name: string;
  role: string;
  branchId: string | null;
  branchName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  resumeSessionId?: string | undefined;
}): Promise<LoginSession> {
  if (params.resumeSessionId) {
    const { data, error } = await supabaseAdmin
      .from('login_sessions')
      .select('id, user_id, last_seen_at, ended_at')
      .eq('id', params.resumeSessionId)
      .maybeSingle();
    if (error) throw error;

    const existing = data as SessionRow | null;
    const live =
      existing &&
      existing.user_id === params.userId &&
      !existing.ended_at &&
      Date.now() - Date.parse(existing.last_seen_at) <= STALE_AFTER_MS;

    if (live) {
      const resumed = await touchSession(existing.id, params.userId);
      if (resumed) return resumed;
      // Fell through: the row was closed between the two reads. Open a new one.
    }
  }

  // Resolved BEFORE the insert so the row is written complete, and awaited
  // rather than fired off afterwards because there is no second write to attach
  // it to. `lookupIp` cannot throw and is capped at ~2.8s, so the worst case is
  // a login that takes an extra moment to record — never one that fails to be.
  const geo = await lookupIp(params.ipAddress);

  const { data, error } = await supabaseAdmin
    .from('login_sessions')
    .insert({
      user_id: params.userId,
      user_email: params.email,
      user_name: params.name,
      user_role: params.role,
      branch_id: params.branchId,
      branch_name: params.branchName,
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
      country: geo.country,
      country_code: geo.countryCode,
      city: geo.city,
      region: geo.region,
      business_date: businessDateStr(),
    })
    .select('*')
    .single();
  if (error) throw error;

  return toApi(data);
}

/**
 * Bump `last_seen_at`. Returns null if there was no live session to bump.
 *
 * Guarded on `user_id` and on `ended_at is null` in the UPDATE itself rather
 * than read-then-write: a ping racing a sign-out must not resurrect a session
 * that has just been closed, and a predicate in the statement is the only way to
 * decide that atomically from here.
 */
export async function touchSession(sessionId: string, userId: string): Promise<LoginSession | null> {
  const { data, error } = await supabaseAdmin
    .from('login_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('ended_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data ? toApi(data) : null;
}

/**
 * Close a session on an explicit sign-out.
 *
 * `end_reason` is always 'logout' here — 'expired' exists in the check
 * constraint for a sweeper that does not exist yet, and is never written by this
 * path. Idempotent through the same `ended_at is null` predicate: signing out
 * twice, or a retry, leaves the first end time standing rather than stretching
 * the session to the second call.
 */
export async function endSession(sessionId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('login_sessions')
    .update({ ended_at: now, last_seen_at: now, end_reason: 'logout' })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('ended_at', null);
  if (error) throw error;
}

/**
 * The history, newest first.
 *
 * `userId` null means every user — the caller decides that, and only a super
 * admin is allowed to pass it (see the route). Everyone else is pinned to their
 * own id, which is what makes this table safe to put on every dashboard.
 */
export async function listSessions(opts: {
  userId: string | null;
  days: number;
  limit: number;
}): Promise<LoginSession[]> {
  let q = supabaseAdmin
    .from('login_sessions')
    .select('*')
    .gte('business_date', businessDaysAgoStr(opts.days - 1))
    .order('login_at', { ascending: false })
    .range(0, opts.limit - 1);

  if (opts.userId) q = q.eq('user_id', opts.userId);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(toApi);
}
