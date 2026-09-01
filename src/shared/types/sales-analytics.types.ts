/**
 * Daily Sales analytics — the shape `/api/sales-analytics` returns.
 *
 * Deliberately separate from `report.types.ts` rather than another field on
 * `ReportSummary`. That type is a monthly management report computed in Node
 * over whole orders and their line items; this one is a dashboard card that
 * redraws on every date-range change and is aggregated in Postgres (migration
 * 100). Folding them together would tie a graph's refresh to the cost of the
 * report, and the two do not even agree on what a transaction is — see
 * `totalTransactions` below.
 *
 * MONEY RULES, once, so every field here reads the same way:
 *   - `cancelled` orders are excluded from everything.
 *   - `staff` sales (unpaid — the goods left the counter, no money came in) are
 *     excluded from every money figure and every count, and reported on their
 *     own as `staffTotal` / `staffCount`.
 * The payment-method rows therefore sum exactly to `totalSales`.
 */

/** One point on the graph. Dense: a day with no sales is a zero, not a gap. */
export interface SalesAnalyticsDay {
  /** Business date, `YYYY-MM-DD`. The stored one, not derived from `createdAt`. */
  date: string;
  sales: number;
  transactions: number;
}

export interface SalesAnalyticsPaymentMethod {
  /** The stored `payment_method` value — render it through `PAYMENT_METHOD_LABELS`. */
  method: string;
  total: number;
  count: number;
}

export interface SalesAnalyticsProduct {
  /** Empty when the product has since been deleted; the name snapshot survives. */
  productId: string;
  productName: string;
  categoryName: string;
  qty: number;
  sales: number;
}

/**
 * Current window against the one of equal length immediately before it.
 *
 * Equal length and immediately preceding, NOT "the same span of last month" —
 * a 15-day month-to-date compares against the previous 15 days, so the two
 * windows always contain the same number of trading opportunities. A calendar
 * comparison would put 15 days against 31 and report a collapse.
 */
export interface SalesAnalyticsComparison {
  from: string;
  to: string;
  sales: number;
  transactions: number;
  /** Current − previous. Signed. */
  changeAmount: number;
  /**
   * NULL when the previous window took nothing.
   *
   * A percentage against zero is either infinite or a fabricated "100%", and
   * both read as a real measurement. The UI must say "no sales in the previous
   * period" instead of printing a number.
   */
  changePct: number | null;
  /**
   * `stable` covers a change too small to be worth a verdict (under
   * `SALES_TREND_STABLE_PCT`). Without the dead band a 0.4% drift renders as a
   * red arrow and a branch manager goes looking for a cause that is not there.
   */
  direction: 'up' | 'down' | 'stable';
}

export interface SalesAnalytics {
  /** The window as requested, business dates. */
  from: string;
  /**
   * `to`, clamped to the current business date.
   *
   * "This Month" runs to month end, and the days that have not happened yet are
   * not zero-sales days — they would flatten the graph and halve the average.
   * Everything in this payload is computed over `from … effectiveTo`.
   */
  effectiveTo: string;
  /** Resolved SERVER-side from the JWT. Null means consolidated across branches. */
  branchId: string | null;
  branchName: string | null;
  totalSales: number;
  /** Paid, non-cancelled orders in the window. Excludes staff sales. */
  totalTransactions: number;
  /** Today's business date, regardless of the selected window. */
  todaySales: number;
  todayTransactions: number;
  /** `totalSales` over every day in the window, trading or not. */
  averageDailySales: number;
  /** Null when nothing sold in the window. */
  highestDay: SalesAnalyticsDay | null;
  /**
   * The worst day the branch actually TRADED — days with no sales are skipped,
   * not reported as the minimum. The day series is dense, so any window holding
   * a closure would otherwise always answer Rs.0 and hide the figure this exists
   * to give. Null when nothing sold in the window, same as `highestDay`.
   */
  lowestDay: SalesAnalyticsDay | null;
  /** Unpaid staff sales in the window — excluded from every figure above. */
  staffTotal: number;
  staffCount: number;
  daily: SalesAnalyticsDay[];
  paymentMethods: SalesAnalyticsPaymentMethod[];
  topProducts: SalesAnalyticsProduct[];
  /** Null when the caller did not ask for a comparison. */
  comparison: SalesAnalyticsComparison | null;
}

/**
 * Below this much movement the period-on-period verdict is `stable`.
 *
 * Shared so the API's `direction` and anything the client says about it cannot
 * disagree about where "flat" ends.
 */
export const SALES_TREND_STABLE_PCT = 2;

/** How many products the Top Selling Products table may rank. */
export const SALES_TOP_PRODUCT_LIMITS = [5, 10] as const;
export type SalesTopProductLimit = (typeof SALES_TOP_PRODUCT_LIMITS)[number];

/** Widest window the API will aggregate in one request. */
export const SALES_ANALYTICS_MAX_DAYS = 366;
