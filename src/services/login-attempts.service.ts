import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  type LoginAttempt,
  type LoginAttemptFilters,
  type LoginAttemptReason,
  type LoginAttemptsPage,
} from '../shared';
import { rowToApi } from '../utils/case';
import { parseUserAgent } from '../utils/userAgent';
import { lookupIp } from './geoip.service';

/**
 * Failed sign-ins — recording them, and reading them back.
 *
 * WHY THIS EXISTS SEPARATELY FROM login-history.service.ts. A failed attempt has
 * no session, no Mountain Bakes account and no authenticated identity: the whole
 * point is that authentication did not happen. Every function in the session
 * service starts from a verified token, and none of them could be reused here
 * without being taught to run without one — which is exactly the kind of
 * "sometimes authenticated" code path that ends up trusting a body it should
 * not. Two modules, two postures.
 *
 * THE RECORD IS CLIENT-REPORTED AND THEREFORE FORGEABLE. The app is a static
 * export that authenticates against Supabase directly, so the API never observes
 * the failure; the browser posts it, from an endpoint that by definition cannot
 * require a token. Anybody who can reach the API can write rows here describing
 * attempts that never happened. That is a real limitation, and it is why nothing
 * in this app acts on these rows: they are evidence a person reads. A forgeable
 * table wired to a lockout would be a denial-of-service tool with an admin
 * screen attached.
 *
 * WHAT IS NEVER STORED: the password. Not the value, not a hash, not its length,
 * not a similarity score. No function here takes one and no column could hold
 * one.
 *
 * WHAT IS NEVER RESOLVED: the address to an account. Mapping a typed address to
 * a `users` row is the email-as-identity mistake the rest of this feature is
 * built to avoid, and it would turn the admin screen into a confirmation of
 * which addresses are real accounts. The row says what was typed. Whether that
 * is anybody is a question an admin answers in Users, deliberately.
 */

/** Every column the API reads back. Written out for the reason COLUMNS is in the session service. */
const COLUMNS = `
  id, email, reason, ip_address, user_agent, browser, browser_version, os, os_version,
  device_type, country, country_code, city, region, timezone, location_source,
  attempted_at, business_date
`;

function toApi(row: unknown): LoginAttempt {
  const { businessDate, ...rest } = rowToApi<Record<string, unknown>>(row);
  return { ...rest, date: businessDate } as unknown as LoginAttempt;
}

/**
 * Write down one refused sign-in.
 *
 * NEVER THROWS TO ITS CALLER'S DETRIMENT — the route awaits it, but a failure
 * here is answered with 204 anyway (see the route), because the person on the
 * other end is already looking at a login error and a second one about the
 * bookkeeping would be noise about a problem they cannot act on.
 *
 * THE GEO LOOKUP IS DELIBERATELY PERFORMED. It costs one provider call per
 * failed attempt, which sounds like an invitation to burn a quota — and would
 * be, without the strict rate limit the route puts in front of this and the
 * per-IP cache inside `lookupIp`. It is worth the call: "six failures from three
 * countries in ten minutes" is the entire reason to keep this table, and without
 * the country the rows say almost nothing.
 */
export async function recordAttempt(params: {
  email: string;
  reason: LoginAttemptReason;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  // Lower-cased so the same address typed two ways groups into one, and capped
  // at the column's documented width. Addresses are case-insensitive in every
  // practical sense and Supabase treats them so.
  const email = params.email.trim().toLowerCase().slice(0, 255);

  const geo = await lookupIp(params.ipAddress);
  const device = parseUserAgent(params.userAgent);

  const { error } = await supabaseAdmin.from('login_attempts').insert({
    email,
    reason: params.reason,
    ip_address: params.ipAddress,
    user_agent: params.userAgent,
    browser: device.browser,
    browser_version: device.browserVersion,
    os: device.os,
    os_version: device.osVersion,
    device_type: device.deviceType,
    country: geo.country,
    country_code: geo.countryCode,
    city: geo.city,
    region: geo.region,
    timezone: geo.timezone,
    location_source: geo.source,
    business_date: businessDateStr(),
  });
  if (error) throw error;
}

/**
 * The failed attempts, newest first, one page at a time.
 *
 * PAGED AND FILTERED IN SQL for the reason the history list is: this table grows
 * without an upper bound — it is fed by whoever mistypes a password, and by
 * anybody probing the login form — so a client-side filter over a capped fetch
 * would silently start truncating exactly when the table became interesting.
 *
 * `search` matches the ADDRESS ONLY. There is nothing else on the row a person
 * would search for, and widening it to the user agent would let a search for a
 * name return rows because a browser build number happened to contain it.
 */
export async function listAttempts(opts: {
  filters: LoginAttemptFilters;
  page: number;
  pageSize: number;
}): Promise<LoginAttemptsPage> {
  const { filters } = opts;

  let q = supabaseAdmin
    .from('login_attempts')
    .select(COLUMNS, { count: 'exact' })
    .order('attempted_at', { ascending: false });

  if (filters.reason) q = q.eq('reason', filters.reason);
  if (filters.country) q = q.eq('country', filters.country);
  if (filters.from) q = q.gte('business_date', filters.from);
  if (filters.to) q = q.lte('business_date', filters.to);

  if (filters.search) {
    // Same treatment the session search gets: `%` and `_` are `ilike`
    // wildcards, and the rest are PostgREST filter-language punctuation. A term
    // containing any of them would quietly change which rows matched rather than
    // failing, which is the worst way for a filter to be wrong.
    const term = filters.search.replace(/[,()%_\\*"']/g, ' ').trim();
    if (term) q = q.ilike('email', `%${term}%`);
  }

  const from = (opts.page - 1) * opts.pageSize;
  const { data, error, count } = await q.range(from, from + opts.pageSize - 1);
  if (error) throw error;

  return {
    attempts: (data ?? []).map(toApi),
    total: count ?? 0,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

/**
 * How many failures this address has collected recently — the number the
 * Security screen shows next to a burst.
 *
 * A COUNT, NOT A VERDICT, and not consulted by anything that decides. It exists
 * so an admin scanning the list can tell one fat-fingered password from forty
 * attempts in an hour without counting rows by eye. Because the underlying rows
 * are forgeable (see the module note), a high number is a prompt to look, never
 * proof of an attack.
 */
export async function countRecentFailures(email: string, hours = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('email', email.trim().toLowerCase())
    .gte('attempted_at', since);
  if (error) throw error;
  return count ?? 0;
}
