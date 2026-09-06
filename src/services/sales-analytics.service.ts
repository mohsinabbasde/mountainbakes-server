import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  SALES_ANALYTICS_MAX_DAYS,
  SALES_TREND_STABLE_PCT,
  type SalesAnalytics,
  type SalesAnalyticsComparison,
  type SalesAnalyticsDay,
  type SalesAnalyticsPaymentMethod,
  type SalesAnalyticsProduct,
} from '../shared';

/**
 * Daily Sales analytics.
 *
 * Every figure comes back from ONE call to `public.sales_analytics` (migration
 * 100), which does the group-bys in Postgres and returns only what the card
 * draws. Nothing here re-aggregates: this module validates the window, decides
 * the comparison period, and names the fields.
 *
 * **This service depends on migration 100 being applied.** That is the same
 * contract migration 84 (`idempotency_keys`) has with the middleware that uses
 * it — `db push` before the deploy. `callAnalytics` below turns the specific
 * "function does not exist" failure into a sentence that says so, rather than a
 * masked 500 that reads like the API is down.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Add `n` days to a 'YYYY-MM-DD' string. UTC-based, so no local-DST surprises. */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count between two 'YYYY-MM-DD' strings. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * A date string the caller supplied, checked for shape AND for being a real day.
 *
 * The regex alone accepts 2026-02-31, which Postgres rejects with a 22008 that
 * surfaces as an opaque 500. Round-tripping through Date catches it here, where
 * the message can name the parameter.
 */
function parseDate(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s)) throw badRequest(`${field} must be a date in YYYY-MM-DD form`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${field} is not a real date`);
  }
  return s;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Raw shape of the jsonb the RPC returns. Everything is re-coerced below. */
interface AnalyticsRow {
  totalSales: unknown;
  totalTransactions: unknown;
  todaySales: unknown;
  todayTransactions: unknown;
  staffTotal: unknown;
  staffCount: unknown;
  dayCount: unknown;
  daily: { date: string; sales: unknown; transactions: unknown }[] | null;
  highestDay: { date: string; sales: unknown; transactions: unknown } | null;
  lowestDay: { date: string; sales: unknown; transactions: unknown } | null;
  paymentMethods: { method: string; total: unknown; count: unknown }[] | null;
  topProducts: {
    productId: string;
    productName: string;
    categoryName: string;
    qty: unknown;
    sales: unknown;
  }[] | null;
  previousSales: unknown;
  previousTransactions: unknown;
}

export interface SalesAnalyticsParams {
  from: string;
  to: string;
  /** ALREADY RESOLVED by the caller against the JWT — never a raw query param. */
  branchId: string | null;
  branchName: string | null;
  topLimit: number;
  compare: boolean;
}

/** Validated, clamped window plus the comparison period it implies. */
export interface ResolvedWindow {
  from: string;
  effectiveTo: string;
  /** Days in `from … effectiveTo`, inclusive. 0 when the window is entirely future. */
  dayCount: number;
  prevFrom: string | null;
  prevTo: string | null;
}

/**
 * Validate the requested window and work out what it should actually cover.
 *
 * Two adjustments, both of which change the numbers and so are made in one
 * visible place:
 *
 *  - `to` is clamped to the current business date. "This Month" and "Last 30
 *    Days" name windows that run past today, and the days that have not
 *    happened are not zero-sales days — counted as such they flatten the graph
 *    and halve the daily average.
 *  - The comparison window is the same NUMBER OF DAYS immediately before
 *    `from`, not the same calendar span of the previous month. Month-to-date on
 *    the 15th otherwise compares fifteen days against thirty-one and reports a
 *    collapse that never happened.
 */
export function resolveWindow(fromInput: unknown, toInput: unknown, compare: boolean): ResolvedWindow {
  const from = parseDate(fromInput, 'from');
  const to = parseDate(toInput, 'to');
  if (from > to) throw badRequest('from must not be after to');
  if (daysBetween(from, to) > SALES_ANALYTICS_MAX_DAYS) {
    throw badRequest(`Range too wide — ${SALES_ANALYTICS_MAX_DAYS} days maximum`);
  }

  const today = businessDateStr();
  const effectiveTo = to > today ? today : to;

  // A window that starts in the future has no days at all. Report it honestly
  // rather than letting `daysBetween` return a negative and divide by it.
  const dayCount = effectiveTo < from ? 0 : daysBetween(from, effectiveTo);

  let prevFrom: string | null = null;
  let prevTo: string | null = null;
  if (compare && dayCount > 0) {
    prevTo = addDays(from, -1);
    prevFrom = addDays(prevTo, -(dayCount - 1));
  }

  return { from, effectiveTo, dayCount, prevFrom, prevTo };
}

async function callAnalytics(
  window: ResolvedWindow,
  branchId: string | null,
  topLimit: number,
): Promise<AnalyticsRow> {
  const { data, error } = await supabaseAdmin.rpc('sales_analytics', {
    p_from: window.from,
    p_to: window.effectiveTo,
    p_branch_id: branchId,
    p_top_limit: topLimit,
    p_prev_from: window.prevFrom,
    p_prev_to: window.prevTo,
    p_today: businessDateStr(),
  });

  if (error) {
    // PostgREST answers an unknown function with PGRST202; Postgres itself with
    // 42883. Either one here means exactly one thing, and saying it plainly is
    // the difference between a five-minute fix and an afternoon in the logs.
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw Object.assign(
        new Error(
          'Sales analytics is unavailable: database migration 100 (sales_analytics) ' +
            'has not been applied. Run `npx supabase db push --linked`.',
        ),
        { status: 503 },
      );
    }
    throw error;
  }

  return (data ?? {}) as unknown as AnalyticsRow;
}

function comparisonFrom(row: AnalyticsRow, window: ResolvedWindow, totalSales: number): SalesAnalyticsComparison | null {
  if (!window.prevFrom || !window.prevTo) return null;

  const previous = num(row.previousSales);
  const changeAmount = totalSales - previous;

  // No percentage against a zero base. "+100%" and "+∞%" are both fabrications,
  // and each reads exactly like a measurement; the client says "no sales in the
  // previous period" instead.
  const changePct = previous > 0 ? (changeAmount / previous) * 100 : null;

  const direction: SalesAnalyticsComparison['direction'] =
    changePct === null
      ? (changeAmount > 0 ? 'up' : 'stable')
      : Math.abs(changePct) < SALES_TREND_STABLE_PCT
        ? 'stable'
        : changePct > 0
          ? 'up'
          : 'down';

  return {
    from: window.prevFrom,
    to: window.prevTo,
    sales: previous,
    transactions: num(row.previousTransactions),
    changeAmount,
    changePct: changePct === null ? null : Math.round(changePct * 10) / 10,
    direction,
  };
}

export async function getSalesAnalytics(params: SalesAnalyticsParams): Promise<SalesAnalytics> {
  const window = resolveWindow(params.from, params.to, params.compare);

  // Nothing to aggregate over a window that has not started. Skip the round trip
  // and answer with the same shape, so every consumer has one empty case.
  if (window.dayCount === 0) {
    return {
      from: window.from,
      effectiveTo: window.effectiveTo,
      branchId: params.branchId,
      branchName: params.branchName,
      totalSales: 0,
      totalTransactions: 0,
      todaySales: 0,
      todayTransactions: 0,
      averageDailySales: 0,
      highestDay: null,
      lowestDay: null,
      staffTotal: 0,
      staffCount: 0,
      daily: [],
      paymentMethods: [],
      topProducts: [],
      comparison: null,
    };
  }

  const row = await callAnalytics(window, params.branchId, params.topLimit);

  const totalSales = num(row.totalSales);
  // The SQL's own day count, not `window.dayCount` — they are the same number by
  // construction, and reading it back from the same query that produced the
  // total is what keeps the average consistent with its numerator if the window
  // logic ever changes on one side only.
  const dayCount = num(row.dayCount) || window.dayCount;

  const daily: SalesAnalyticsDay[] = (row.daily ?? []).map((d) => ({
    date: d.date,
    sales: num(d.sales),
    transactions: num(d.transactions),
  }));

  const paymentMethods: SalesAnalyticsPaymentMethod[] = (row.paymentMethods ?? []).map((p) => ({
    method: p.method,
    total: num(p.total),
    count: num(p.count),
  }));

  const topProducts: SalesAnalyticsProduct[] = (row.topProducts ?? []).map((p) => ({
    productId: p.productId ?? '',
    productName: p.productName,
    categoryName: p.categoryName ?? '',
    qty: num(p.qty),
    sales: num(p.sales),
  }));

  return {
    from: window.from,
    effectiveTo: window.effectiveTo,
    branchId: params.branchId,
    branchName: params.branchName,
    totalSales,
    totalTransactions: num(row.totalTransactions),
    todaySales: num(row.todaySales),
    todayTransactions: num(row.todayTransactions),
    averageDailySales: dayCount > 0 ? totalSales / dayCount : 0,
    highestDay: row.highestDay
      ? {
          date: row.highestDay.date,
          sales: num(row.highestDay.sales),
          transactions: num(row.highestDay.transactions),
        }
      : null,
    lowestDay: row.lowestDay
      ? {
          date: row.lowestDay.date,
          sales: num(row.lowestDay.sales),
          transactions: num(row.lowestDay.transactions),
        }
      : null,
    staffTotal: num(row.staffTotal),
    staffCount: num(row.staffCount),
    daily,
    paymentMethods,
    topProducts,
    comparison: comparisonFrom(row, window, totalSales),
  };
}
