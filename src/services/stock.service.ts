import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  type BranchStockHistoryRow,
  type BranchStockSummaryResult,
  type BranchStockSummaryRow,
  type StockFigures,
  type StockMovementType,
  type StockRow,
} from '../shared';

/**
 * Derived stock tracking (no cron). We keep a running balance per
 * (branch_id, product_id) in `stock` and append every movement to `stock_history`.
 * The Stock page reconstructs Opening/New/Sold/Balance from these on read.
 *
 * ─── Where the transactions live ─────────────────────────────────────────────
 * The read-validate-write cores are Postgres functions (migration 12), called via
 * .rpc(). PostgREST gives every call its own transaction, so validate-then-write
 * split across two supabase-js calls could not hold `select ... for update`
 * between them — which is exactly the multi-cashier race the SQL-function
 * transaction exists to close.
 *
 * Idempotency is the UNIQUE (ref_id, product_id, type) on stock_history: a retry
 * that reuses the same refId is a true no-op. Negative balances remain allowed
 * (oversell is flagged in the UI, never blocked) EXCEPT on the sale and
 * branch-return paths, which reject overdrawing.
 *
 * See migration 04's header — it is the authority on both invariants.
 */

interface MovementInput {
  branchId: string;
  productId: string;
  productName: string;
  delta: number; // signed
  type: StockMovementType;
  refId: string;
}

/** Apply one signed movement. Returns the post-movement balance. */
export async function applyStockMovement(input: MovementInput): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('apply_stock_movement', {
    p_branch_id: input.branchId,
    p_product_id: input.productId,
    p_product_name: input.productName,
    p_delta: input.delta,
    p_type: input.type,
    p_ref_id: input.refId,
    p_business_date: businessDateStr(),
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * The absolute figures an admin correction may target. Omitted = leave alone.
 *
 * `balance` and `adjustment` are the SAME degree of freedom seen from two ends —
 * adjustment is the residual in `opening + new − sold − returned + adjustment =
 * balance`, so fixing one fixes the other. Send one or the other, never both;
 * apply_stock_correction returns `overdetermined` if you do (migration 78).
 *
 * `adjustment` is the only signed target: a correction can go either way, and
 * `{ adjustment: 0 }` is how a correction is cleared.
 */
export interface StockCorrectionTargets {
  /**
   * Correctable as of migration 79. Its movement is dated to the PREVIOUS
   * business day, because opening is yesterday's closing and a movement on today
   * cannot shift it (balance and today's net move together). Refused with
   * `day_closed` if that previous day has been formally closed.
   */
  opening?: number;
  newQty?: number;
  sold?: number;
  returned?: number;
  balance?: number;
  adjustment?: number;
}

/** Thrown when an Opening correction would restate an already-closed day. */
export class DayClosedError extends Error {
  status = 409;
  constructor(public businessDate: string) {
    super(`${businessDate} has been closed, so its closing balance can no longer be corrected.`);
    this.name = 'DayClosedError';
  }
}

/** Thrown when both `balance` and `adjustment` are targeted in one correction. */
export class OverdeterminedCorrectionError extends Error {
  status = 400;
  constructor() {
    super('Set either Balance or Adjustment, not both — each one determines the other.');
    this.name = 'OverdeterminedCorrectionError';
  }
}

export interface StockCorrectionResult {
  applied: boolean;
  before: StockFigures;
  after: StockFigures;
  movements: { type: StockMovementType; delta: number }[];
}

/** Thrown when a correction would drive the branch balance below zero. */
export class NegativeBalanceError extends Error {
  status = 409;
  constructor(public balance: number) {
    super(`That correction would leave a balance of ${balance}.`);
    this.name = 'NegativeBalanceError';
  }
}

const figures = (raw: Record<string, unknown>): StockFigures => ({
  opening: Number(raw['opening'] ?? 0),
  newQty: Number(raw['newQty'] ?? 0),
  sold: Number(raw['sold'] ?? 0),
  returned: Number(raw['returned'] ?? 0),
  adjustment: Number(raw['adjustment'] ?? 0),
  balance: Number(raw['balance'] ?? 0),
});

/**
 * Apply an admin stock correction (Help Desk → Support Center) for one product in
 * one branch. The caller supplies ABSOLUTE targets for New / Sold / Returned /
 * Balance; `apply_stock_correction` (migration 33) sizes each compensating movement
 * against the LIVE figures under a row lock — never against the ticket's snapshot,
 * which was taken when the query was raised and may be hours stale. Opening is not
 * correctable (it is the previous day's closing — see the migration header).
 *
 * Targets that already match write nothing, so a resubmit is a true no-op.
 */
export async function applyStockCorrection(params: {
  branchId: string;
  productId: string;
  productName: string;
  targets: StockCorrectionTargets;
  ticketId: string;
  businessDate?: string;
}): Promise<StockCorrectionResult> {
  const { data, error } = await supabaseAdmin.rpc('apply_stock_correction', {
    p_branch_id: params.branchId,
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_targets: params.targets,
    p_ticket_id: params.ticketId,
    p_business_date: params.businessDate ?? businessDateStr(),
  });
  if (error) throw error;

  const result = data as {
    status: 'ok' | 'negative_balance' | 'overdetermined' | 'day_closed';
    balance?: number;
    businessDate?: string;
    applied?: boolean;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    movements?: { type: StockMovementType; delta: number | string }[];
  };

  if (result.status === 'overdetermined') {
    throw new OverdeterminedCorrectionError();
  }
  if (result.status === 'day_closed') {
    throw new DayClosedError(String(result.businessDate ?? 'That day'));
  }
  if (result.status === 'negative_balance') {
    throw new NegativeBalanceError(Number(result.balance ?? 0));
  }

  return {
    applied: Boolean(result.applied),
    before: figures(result.before ?? {}),
    after: figures(result.after ?? {}),
    movements: (result.movements ?? []).map((m) => ({ type: m.type, delta: Number(m.delta) })),
  };
}

/**
 * Reconstruct the per-product Opening/New/Sold/Returned/Adjustment/Balance rows for
 * a branch on a given business date.
 *
 * ─── The balance is DERIVED, never read live for a past day ────────────────
 * `stock.balance` is a live running total with no per-day snapshot behind it, so
 * a past day's closing balance has to be walked back out of the ledger — the
 * same walk `computeBranchStockHistory` does, and it has to agree with it:
 *
 *   closing[d] = live balance − (net of every movement dated AFTER d)
 *   opening[d] = closing[d] − net[d]
 *
 * This function used to put `stock.balance` straight into every row's Balance
 * whatever date was asked for, so the page printed TODAY's stock on every past
 * day — and derived Opening off that figure, putting both ends of the row out.
 * For `date = today` the walk is a no-op (nothing is dated after today), so the
 * daily-closing snapshot and the closing report, which only ever ask for the day
 * being closed, are unaffected.
 *
 * ─── Which products appear ─────────────────────────────────────────────────
 * Every active product, plus any INACTIVE one that still holds stock or moved
 * that day. A discontinued product's units are physically on the shelf and are
 * inside `stock.balance`; dropping them is what made this page's Balance total
 * disagree with the dashboard's Remaining Stock, which prices the whole
 * catalogue (see `computeBranchStockHistory`). An inactive product with nothing
 * left and no movement that day stays hidden, so the table does not fill up with
 * dead catalogue.
 */
export async function computeStockRows(branchId: string, date: string = businessDateStr()): Promise<StockRow[]> {
  const today = businessDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UnreachableStockDateError(`"${date}" is not a YYYY-MM-DD business date.`);
  }
  if (date > today) {
    throw new UnreachableStockDateError(`${date} has not happened yet — the ledger only reaches ${today}.`);
  }
  // Same ceiling as the history walk: the balance is derived from today's
  // figure, so reaching further back means reading more of the ledger than the
  // cap below allows. Refused with a reason rather than answered wrongly.
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) + 1;
  if (span > 365) {
    throw new UnreachableStockDateError(
      `${date} is more than a year back; stock is derived from today's balance and only reaches 365 days.`,
    );
  }

  // Everything from the requested day FORWARD: the day itself supplies the
  // columns, everything after it is what has to be unwound to get back to that
  // day's closing balance. The date filter is a real indexed predicate
  // (stock_history_branch_date_idx). Asking for today reads one day, as before.
  const [products, stock, history] = await Promise.all([
    supabaseAdmin.from('products').select('id, name, stock_code, is_active'),
    supabaseAdmin.from('stock').select('product_id, balance').eq('branch_id', branchId),
    supabaseAdmin
      .from('stock_history')
      .select('product_id, business_date, type, delta')
      .eq('branch_id', branchId)
      .gte('business_date', date)
      .order('business_date', { ascending: true })
      .range(0, HISTORY_ROW_CAP - 1),
  ]);
  if (products.error) throw products.error;
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const movements = (history.data ?? []) as
    { product_id: string; business_date: string; type: string; delta: number | string }[];
  // A truncated read would leave part of the unwind missing and quietly shift
  // every balance. There is no partial answer worth giving here.
  if (movements.length >= HISTORY_ROW_CAP) {
    throw new UnreachableStockDateError(
      `Too much stock movement since ${date} to derive that day's balances in one read.`,
    );
  }

  const balanceByProduct = new Map<string, number>();
  for (const s of (stock.data ?? []) as { product_id: string; balance: number | string }[]) {
    balanceByProduct.set(s.product_id, Number(s.balance ?? 0));
  }

  const netOnDay = new Map<string, number>();
  const netAfter = new Map<string, number>();
  const newQty = new Map<string, number>();
  const sold = new Map<string, number>();
  const returned = new Map<string, number>();
  const adjustment = new Map<string, number>();
  for (const h of movements) {
    const delta = Number(h.delta ?? 0);
    if (h.business_date > date) {
      netAfter.set(h.product_id, (netAfter.get(h.product_id) ?? 0) + delta);
      continue;
    }
    netOnDay.set(h.product_id, (netOnDay.get(h.product_id) ?? 0) + delta);
    if (h.type === 'production') newQty.set(h.product_id, (newQty.get(h.product_id) ?? 0) + delta);
    // Sold and returned are stored as negative deltas; report them positive.
    if (h.type === 'sale') sold.set(h.product_id, (sold.get(h.product_id) ?? 0) - delta);
    if (h.type === 'return') returned.set(h.product_id, (returned.get(h.product_id) ?? 0) - delta);
    // Corrections (admin stock fix, sale edit) stay SIGNED — the sign is the
    // information. Reported so the row still reconciles:
    // opening + new − sold − returned + adjustment = balance.
    if (h.type === 'adjustment') adjustment.set(h.product_id, (adjustment.get(h.product_id) ?? 0) + delta);
  }

  return ((products.data ?? []) as { id: string; name: string; stock_code: string; is_active: boolean }[])
    .map((p) => {
      // Closing balance FOR THIS DAY: today's live figure with everything that
      // happened after it taken back off.
      const balance = (balanceByProduct.get(p.id) ?? 0) - (netAfter.get(p.id) ?? 0);
      return {
        productId: p.id,
        productName: p.name,
        stockCode: p.stock_code,
        isActive: p.is_active,
        opening: balance - (netOnDay.get(p.id) ?? 0), // balance at start of the business day
        newQty: newQty.get(p.id) ?? 0,
        sold: sold.get(p.id) ?? 0,
        returned: returned.get(p.id) ?? 0,
        adjustment: adjustment.get(p.id) ?? 0,
        balance,
      };
    })
    .filter((r) => r.isActive || r.balance !== 0 || r.opening !== 0
      || r.newQty !== 0 || r.sold !== 0 || r.returned !== 0 || r.adjustment !== 0)
    .sort((a, b) => b.balance - a.balance || a.productName.localeCompare(b.productName));
}

/**
 * Per-DAY totals for a branch's stock ledger — Branch Dashboard → Branch Stock
 * History. Where `computeStockRows` is one day across every product, this is one
 * product-set across every day: Previous / New / Sold / Returned / Adjustment /
 * Remaining, in units and in money.
 *
 * ─── How the openings are reconstructed ─────────────────────────────────────
 * `stock.balance` is a LIVE running total with no per-day snapshot behind it, so
 * a past day's figures have to be walked backwards out of the ledger exactly the
 * way `computeStockRows` derives one day's opening. Starting from today's balance
 * and stepping back through each date's net movement:
 *
 *   closing[today] = balance          opening[d] = closing[d] − net[d]
 *   closing[d − 1] = opening[d]
 *
 * A date with no movements carries the balance through unchanged, which is why
 * the loop runs over the full calendar range and not just the dates present in
 * the ledger. This only holds while the walk starts at TODAY — hence no `to`
 * parameter: the range always ends on the current business date.
 *
 * ─── Valuation ──────────────────────────────────────────────────────────────
 * Every quantity is priced at the product's current `products.price`, sold
 * included. See `BranchStockHistoryRow` for why that is not the day's takings.
 * Products are read WITHOUT the `is_active` filter `computeStockRows` applies —
 * a discontinued product still has history and still sits in the balance, and
 * dropping it here would leave the amounts short of the quantities.
 */
export interface BranchStockHistoryResult {
  branchId: string;
  from: string;
  to: string;
  rows: BranchStockHistoryRow[];
  /** True when ROW_CAP truncated the ledger read and `from` was pulled forward. */
  capped: boolean;
}

/**
 * Ceiling on the ledger rows one history read will pull. Reached only by a branch
 * with a very wide window and a very large catalogue; the read is ordered newest
 * first so the cap costs the OLDEST days, and `from` is moved past the partial
 * day rather than reporting a half-summed one.
 */
const HISTORY_ROW_CAP = 20_000;

/** Add `n` days to a 'YYYY-MM-DD' string. Local to this module; the shared helper is private. */
function shiftDate(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function computeBranchStockHistory(
  branchId: string,
  days: number,
  today: string = businessDateStr(),
): Promise<BranchStockHistoryResult> {
  const span = Math.max(1, Math.min(365, Math.floor(days)));
  let from = shiftDate(today, -(span - 1));

  const [products, stock, history] = await Promise.all([
    supabaseAdmin.from('products').select('id, price'),
    supabaseAdmin.from('stock').select('product_id, balance').eq('branch_id', branchId),
    supabaseAdmin
      .from('stock_history')
      .select('product_id, business_date, type, delta')
      .eq('branch_id', branchId)
      .gte('business_date', from)
      .order('business_date', { ascending: false })
      .range(0, HISTORY_ROW_CAP - 1),
  ]);
  if (products.error) throw products.error;
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const priceByProduct = new Map<string, number>();
  for (const p of (products.data ?? []) as { id: string; price: number | string }[]) {
    priceByProduct.set(p.id, Number(p.price ?? 0));
  }
  const price = (productId: string) => priceByProduct.get(productId) ?? 0;

  const rows = (history.data ?? []) as {
    product_id: string;
    business_date: string;
    type: string;
    delta: number | string;
  }[];

  // The cap drops the oldest rows, so the oldest date that survived may be only
  // partly here. Discard it rather than publish a day that is missing movements.
  const capped = rows.length >= HISTORY_ROW_CAP;
  const oldestFetched = rows.length > 0 ? rows[rows.length - 1]!.business_date : from;
  const cutoff = capped ? shiftDate(oldestFetched, 1) : from;
  if (capped) from = cutoff;

  // Live total, in units and in money — this is `closing` for TODAY.
  let closingQty = 0;
  let closingAmount = 0;
  for (const s of (stock.data ?? []) as { product_id: string; balance: number | string }[]) {
    const bal = Number(s.balance ?? 0);
    closingQty += bal;
    closingAmount += bal * price(s.product_id);
  }

  type DayTotals = {
    netQty: number; netAmount: number;
    newQty: number; newAmount: number;
    soldQty: number; soldAmount: number;
    returnedQty: number; returnedAmount: number;
    adjustmentQty: number; adjustmentAmount: number;
  };
  const blank = (): DayTotals => ({
    netQty: 0, netAmount: 0,
    newQty: 0, newAmount: 0,
    soldQty: 0, soldAmount: 0,
    returnedQty: 0, returnedAmount: 0,
    adjustmentQty: 0, adjustmentAmount: 0,
  });

  const byDate = new Map<string, DayTotals>();
  for (const h of rows) {
    const delta = Number(h.delta ?? 0);
    const value = delta * price(h.product_id);
    const day = byDate.get(h.business_date) ?? blank();
    day.netQty += delta;
    day.netAmount += value;
    if (h.type === 'production') { day.newQty += delta; day.newAmount += value; }
    // Sales and returns are stored as negative deltas; reported positive, as on
    // the Stock page.
    if (h.type === 'sale') { day.soldQty -= delta; day.soldAmount -= value; }
    if (h.type === 'return') { day.returnedQty -= delta; day.returnedAmount -= value; }
    // Corrections stay SIGNED — the direction is the information, and it is what
    // makes opening + new − sold − returned + adjustment = balance hold.
    if (h.type === 'adjustment') { day.adjustmentQty += delta; day.adjustmentAmount += value; }
    byDate.set(h.business_date, day);
  }

  // Walk today → `from`, newest first, carrying the balance backwards.
  const out: BranchStockHistoryRow[] = [];
  for (let date = today; date >= from; date = shiftDate(date, -1)) {
    const day = byDate.get(date) ?? blank();
    const openingQty = closingQty - day.netQty;
    const openingAmount = closingAmount - day.netAmount;

    out.push({
      date,
      openingQty,
      openingAmount,
      newQty: day.newQty,
      newAmount: day.newAmount,
      soldQty: day.soldQty,
      soldAmount: day.soldAmount,
      returnedQty: day.returnedQty,
      returnedAmount: day.returnedAmount,
      adjustmentQty: day.adjustmentQty,
      adjustmentAmount: day.adjustmentAmount,
      balanceQty: closingQty,
      balanceAmount: closingAmount,
    });

    // Yesterday's closing IS today's opening.
    closingQty = openingQty;
    closingAmount = openingAmount;
  }

  return { branchId, from, to: today, rows: out, capped };
}

/** Thrown when a stock-history day is asked for outside the range that can be derived. */
export class UnreachableStockDateError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UnreachableStockDateError';
  }
}

/**
 * ONE business day of a branch's stock ledger — the Branch Daily Stock statement.
 *
 * A thin pick off `computeBranchStockHistory`, not a cheaper query: the opening
 * balance for any past day can only be reached by walking today's live balance
 * backwards through every day since, so asking for the 3rd costs the same read as
 * asking for the last N days. Exposed anyway so the page states a date rather
 * than computing a span, and so the 365-day limit is refused here with a reason
 * instead of silently answering about the wrong day.
 */
export async function computeBranchStockDay(
  branchId: string,
  date: string,
  today: string = businessDateStr(),
): Promise<BranchStockHistoryRow> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UnreachableStockDateError(`"${date}" is not a YYYY-MM-DD business date.`);
  }
  if (date > today) {
    throw new UnreachableStockDateError(`${date} has not happened yet — the ledger only reaches ${today}.`);
  }

  // Inclusive span from the requested day to today, which is exactly how many
  // days the backwards walk has to cover.
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) + 1;
  if (span > 365) {
    throw new UnreachableStockDateError(
      `${date} is more than a year back; stock history is derived from today's balance and only reaches 365 days.`,
    );
  }

  const { rows, from, capped } = await computeBranchStockHistory(branchId, span, today);
  // The walk emits today first and the requested day last.
  const row = rows[rows.length - 1];
  if (!row || row.date !== date) {
    throw new UnreachableStockDateError(
      capped
        ? `Too much stock history to reach ${date} in one read; it currently reaches back to ${from}.`
        : `No stock ledger available for ${date}.`,
    );
  }
  return row;
}

/**
 * HARD-DELETE one product's stock in one branch: the `stock` row and every
 * `stock_history` row behind it.
 *
 * Reached only from Admin → Branch Stock with `mode: 'purge'`, and deliberately
 * NOT the default there. It is the one stock operation in the codebase that is
 * not a movement: everything else — sales, returns, production, admin
 * corrections — appends to the append-only ledger, so the figures can always be
 * reconstructed. This removes the rows the reconstruction reads.
 *
 * What that costs, said plainly, because the endpoint cannot un-say it:
 *
 * - Opening is derived (`balance − the day's net movements`), so deleting the
 *   history of a product that has already traded restates every past day for it.
 * - A daily-closing snapshot taken before the purge keeps the old figures, and
 *   will now disagree with anything recomputed from the ledger.
 * - Orders are NOT touched. A sale whose stock movement is purged still exists
 *   in `orders` / `order_items`; only its effect on stock is gone.
 *
 * It exists because an admin sometimes needs a product mis-seeded into the wrong
 * branch to be genuinely absent rather than sitting at zero forever. Use `zero`
 * for anything that really happened.
 */
export async function purgeBranchStock(
  branchId: string,
  productId: string,
): Promise<{ historyDeleted: number; stockDeleted: boolean }> {
  // History first: the `stock` row is the thing the UI reads, so if the second
  // delete fails the product still shows and the inconsistency is visible rather
  // than a balance with no ledger behind it.
  const { data: history, error: histErr } = await supabaseAdmin
    .from('stock_history')
    .delete()
    .eq('branch_id', branchId)
    .eq('product_id', productId)
    .select('id');
  if (histErr) throw histErr;

  const { data: stock, error: stockErr } = await supabaseAdmin
    .from('stock')
    .delete()
    .eq('branch_id', branchId)
    .eq('product_id', productId)
    .select('product_id');
  if (stockErr) throw stockErr;

  return { historyDeleted: (history ?? []).length, stockDeleted: (stock ?? []).length > 0 };
}

/**
 * The derived figures for ONE product in one branch on one business date — the
 * single-product form of `computeStockRows`, for callers (the Support Center's stock
 * reference) that need one product rather than the whole catalogue. Same
 * definitions, so the admin sees exactly what the branch's Stock page shows.
 */
export async function getProductStockFigures(
  branchId: string,
  productId: string,
  date: string = businessDateStr(),
): Promise<StockFigures> {
  const [stock, history] = await Promise.all([
    supabaseAdmin.from('stock').select('balance').eq('branch_id', branchId).eq('product_id', productId).maybeSingle(),
    supabaseAdmin
      .from('stock_history')
      .select('type, delta')
      .eq('branch_id', branchId)
      .eq('product_id', productId)
      .eq('business_date', date),
  ]);
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const balance = Number(stock.data?.balance ?? 0);
  let newQty = 0, sold = 0, returned = 0, adjustment = 0, net = 0;
  for (const h of (history.data ?? []) as { type: string; delta: number | string }[]) {
    const delta = Number(h.delta ?? 0);
    net += delta;
    if (h.type === 'production') newQty += delta;
    if (h.type === 'sale') sold -= delta;
    if (h.type === 'return') returned -= delta;
    if (h.type === 'adjustment') adjustment += delta;
  }

  return { opening: balance - net, newQty, sold, returned, adjustment, balance };
}

/** Approved production adds stock. `qty` is positive; recorded as a positive delta. */
export function applyProductionToStock(i: { branchId: string; productId: string; productName: string; qty: number; refId: string }) {
  return applyStockMovement({ ...i, delta: Math.abs(i.qty), type: 'production' });
}

export interface StockShortfall {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}

/** Thrown by the validated paths when a product lacks stock. No writes happen. */
export class InsufficientStockError extends Error {
  status = 409;
  constructor(public shortfalls: StockShortfall[]) {
    super('Insufficient stock');
    this.name = 'InsufficientStockError';
  }
}

/** Post-sale balances per product, with the pre-sale value, for low-stock detection. */
export interface SaleBalance {
  productName: string;
  before: number;
  after: number;
}

/**
 * Branch-initiated return: validate + decrement in ONE transaction. The balance is
 * re-read under a row lock and the return is refused (InsufficientStockError) if it
 * exceeds the available balance — so a return can never drive a branch negative.
 */
export async function commitBranchReturn(params: {
  branchId: string;
  productId: string;
  productName: string;
  qty: number;
  refId: string;
  /**
   * The day the movement belongs to. Defaults to the day the request arrived,
   * which is right for a browser at the counter; the mobile app passes the day
   * it captured, already bounded and closure-checked by
   * `resolveClientBusinessDate`.
   */
  businessDate?: string;
}): Promise<{ before: number; after: number }> {
  const { data, error } = await supabaseAdmin.rpc('commit_branch_return', {
    p_branch_id: params.branchId,
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_qty: params.qty,
    p_ref_id: params.refId,
    p_business_date: params.businessDate ?? businessDateStr(),
  });
  if (error) throw error;

  const result = data as
    | { status: 'ok'; before: number; after: number }
    | { status: 'insufficient'; requested: number; available: number };

  if (result.status === 'insufficient') {
    throw new InsufficientStockError([
      {
        productId: params.productId,
        productName: params.productName,
        requested: Number(result.requested),
        available: Number(result.available),
      },
    ]);
  }

  return { before: Number(result.before), after: Number(result.after) };
}

/** An order line as persisted to order_items. */
export interface SaleItem {
  productId: string;
  productName: string;
  categoryId?: string | null;
  categoryName?: string | null;
  unitPrice: number;
  qty: number;
  discount?: number;
  lineTotal: number;
}

/**
 * Atomically validate stock, write the order + its line items, decrement branch
 * balances and append `stock_history` — all inside ONE transaction (migration 12's
 * commit_sale). This closes the multi-user race: two cashiers selling the last
 * units can't both succeed, because every stock row is locked (in product_id
 * order, to avoid deadlock between overlapping orders) before validation.
 *
 * Duplicate product lines are kept verbatim in order_items but aggregated for
 * stock — one balance write and one ledger row per product.
 *
 * Throws `InsufficientStockError` with nothing persisted if validation fails.
 *
 * NOTE: the caller does not supply the id — Postgres generates the order id, so
 * it is returned instead.
 */
export async function commitSaleTransaction(params: {
  order: Record<string, unknown>;
  items: SaleItem[];
  branchId: string;
  /**
   * The day the sale belongs to. Defaults to the day the request arrived — the
   * mobile app passes the day it was rung up, so a sale made at 9pm offline and
   * synced at 7am is not filed against the following morning. Already bounded
   * and closure-checked by `resolveClientBusinessDate` before it reaches here.
   */
  businessDate?: string;
}): Promise<{ orderId: string; balances: Map<string, SaleBalance> }> {
  const { data, error } = await supabaseAdmin.rpc('commit_sale', {
    p_order: params.order,
    p_items: params.items,
    p_branch_id: params.branchId,
    p_business_date: params.businessDate ?? businessDateStr(),
  });
  if (error) throw error;

  const result = data as
    | { status: 'ok'; orderId: string; balances: Record<string, { productName: string; before: number; after: number }> }
    | { status: 'insufficient'; shortfalls: StockShortfall[] };

  if (result.status === 'insufficient') {
    throw new InsufficientStockError(
      result.shortfalls.map((s) => ({
        productId: s.productId,
        productName: s.productName,
        requested: Number(s.requested),
        available: Number(s.available),
      })),
    );
  }

  const balances = new Map<string, SaleBalance>();
  for (const [productId, b] of Object.entries(result.balances ?? {})) {
    balances.set(productId, {
      productName: b.productName,
      before: Number(b.before),
      after: Number(b.after),
    });
  }
  return { orderId: result.orderId, balances };
}

/** Persist a blocked-sale audit trail (one row per offending product). Best-effort. */
export async function logBlockedSale(input: {
  branchId: string;
  branchName: string;
  userId: string;
  userName: string;
  shortfalls: StockShortfall[];
}): Promise<void> {
  if (input.shortfalls.length === 0) return;

  // Written outside the failed sale's transaction on purpose (migration 04): the
  // sale rolls back, this must not.
  const { error } = await supabaseAdmin.from('stock_audit_log').insert(
    input.shortfalls.map((s) => ({
      branch_id: input.branchId,
      branch_name: input.branchName,
      user_id: input.userId,
      user_name: input.userName,
      product_id: s.productId,
      product_name: s.productName,
      requested_qty: s.requested,
      available_qty: s.available,
      reason: s.available <= 0 ? 'Out of Stock' : 'Insufficient Stock',
      business_date: businessDateStr(),
    })),
  );
  if (error) throw error;
}

/**
 * Every branch's stock movement over one window, one row per branch — the
 * "All branches" view on Admin → Branch Stock.
 *
 * Deliberately built ON TOP of `computeBranchStockHistory` rather than as a
 * second query that groups by branch_id. The arithmetic behind these figures is
 * genuinely fiddly — opening is derived by walking the balance backwards through
 * the day's movements, sales and returns are stored negative but reported
 * positive, corrections stay signed, and the row-cap has to shorten the window
 * rather than publish a partial day. A second implementation would drift from
 * the first, and the two views would disagree about the same branch on the same
 * day with no way to tell which was right.
 *
 * The cost is one ledger read per branch instead of one overall. That is the
 * right trade at this scale — a bakery has a handful of shops, not thousands —
 * and the reads run concurrently. If the branch count ever grows enough for this
 * to hurt, the fix is a single grouped query feeding BOTH functions, not a
 * divergent copy of the maths.
 *
 * Inactive branches are excluded: a closed shop's last balance is history, and
 * listing it beside trading shops invites reading it as stock on a shelf.
 */
export async function computeAllBranchesStockSummary(
  days: number,
  today: string = businessDateStr(),
): Promise<BranchStockSummaryResult> {
  const { data, error } = await supabaseAdmin
    .from('branches')
    .select('id, name')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;

  const branches = (data ?? []) as { id: string; name: string }[];
  if (branches.length === 0) return { from: today, to: today, rows: [], capped: false };

  const histories = await Promise.all(
    branches.map((b) => computeBranchStockHistory(b.id, days, today)),
  );

  const rows: BranchStockSummaryRow[] = branches.map((branch, i) => {
    const history = histories[i]!;
    // Newest first (computeBranchStockHistory walks today → from), so today is
    // the head and the window's first day is the tail.
    const newest = history.rows[0];
    const oldest = history.rows[history.rows.length - 1];

    const summed = history.rows.reduce(
      (acc, r) => ({
        newQty: acc.newQty + r.newQty,
        newAmount: acc.newAmount + r.newAmount,
        soldQty: acc.soldQty + r.soldQty,
        soldAmount: acc.soldAmount + r.soldAmount,
        returnedQty: acc.returnedQty + r.returnedQty,
        returnedAmount: acc.returnedAmount + r.returnedAmount,
        adjustmentQty: acc.adjustmentQty + r.adjustmentQty,
        adjustmentAmount: acc.adjustmentAmount + r.adjustmentAmount,
      }),
      { newQty: 0, newAmount: 0, soldQty: 0, soldAmount: 0, returnedQty: 0, returnedAmount: 0, adjustmentQty: 0, adjustmentAmount: 0 },
    );

    return {
      branchId: branch.id,
      branchName: branch.name,
      // The window's opening, not a sum of daily openings — see the type's note.
      openingQty: oldest?.openingQty ?? 0,
      openingAmount: oldest?.openingAmount ?? 0,
      ...summed,
      balanceQty: newest?.balanceQty ?? 0,
      balanceAmount: newest?.balanceAmount ?? 0,
      from: history.from,
      capped: history.capped,
    };
  });

  // The widest window every row shares. A capped branch shortens its own row
  // only, so this reports the latest start among them — the date from which
  // every figure on screen is comparable.
  const from = rows.reduce((latest, r) => (r.from > latest ? r.from : latest), rows[0]!.from);

  return { from, to: today, rows, capped: rows.some((r) => r.capped) };
}
