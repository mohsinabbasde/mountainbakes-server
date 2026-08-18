import { supabaseAdmin } from '../config/supabase';
import { businessDateStr, type StockFigures, type StockMovementType, type StockRow } from '../shared';

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
 * a branch on a given business date. Opening = current balance − the day's net
 * movements, matching the derived-stock model. Shared by the Stock page and the
 * daily-closing snapshot so they can never diverge.
 */
export async function computeStockRows(branchId: string, date: string = businessDateStr()): Promise<StockRow[]> {
  // The date filter is a real indexed predicate now
  // (stock_history_branch_date_idx), rather than fetching a branch's entire
  // history and filtering in memory.
  const [products, stock, history] = await Promise.all([
    supabaseAdmin.from('products').select('id, name, stock_code').eq('is_active', true),
    supabaseAdmin.from('stock').select('product_id, balance').eq('branch_id', branchId),
    supabaseAdmin
      .from('stock_history')
      .select('product_id, type, delta')
      .eq('branch_id', branchId)
      .eq('business_date', date),
  ]);
  if (products.error) throw products.error;
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const balanceByProduct = new Map<string, number>();
  for (const s of (stock.data ?? []) as { product_id: string; balance: number | string }[]) {
    balanceByProduct.set(s.product_id, Number(s.balance ?? 0));
  }

  const net = new Map<string, number>();
  const newQty = new Map<string, number>();
  const sold = new Map<string, number>();
  const returned = new Map<string, number>();
  const adjustment = new Map<string, number>();
  for (const h of (history.data ?? []) as { product_id: string; type: string; delta: number | string }[]) {
    const delta = Number(h.delta ?? 0);
    net.set(h.product_id, (net.get(h.product_id) ?? 0) + delta);
    if (h.type === 'production') newQty.set(h.product_id, (newQty.get(h.product_id) ?? 0) + delta);
    // Sold and returned are stored as negative deltas; report them positive.
    if (h.type === 'sale') sold.set(h.product_id, (sold.get(h.product_id) ?? 0) - delta);
    if (h.type === 'return') returned.set(h.product_id, (returned.get(h.product_id) ?? 0) - delta);
    // Corrections (admin stock fix, sale edit) stay SIGNED — the sign is the
    // information. Reported so the row still reconciles:
    // opening + new − sold − returned + adjustment = balance.
    if (h.type === 'adjustment') adjustment.set(h.product_id, (adjustment.get(h.product_id) ?? 0) + delta);
  }

  return ((products.data ?? []) as { id: string; name: string; stock_code: string }[])
    .map((p) => {
      const balance = balanceByProduct.get(p.id) ?? 0;
      return {
        productId: p.id,
        productName: p.name,
        stockCode: p.stock_code,
        opening: balance - (net.get(p.id) ?? 0), // balance at start of the business day
        newQty: newQty.get(p.id) ?? 0,
        sold: sold.get(p.id) ?? 0,
        returned: returned.get(p.id) ?? 0,
        adjustment: adjustment.get(p.id) ?? 0,
        balance,
      };
    })
    .sort((a, b) => b.balance - a.balance || a.productName.localeCompare(b.productName));
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
