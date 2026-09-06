import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  type ProductionLedgerType,
  type ProductionStockLedgerRow,
  type ProductionStockMovementType,
} from '../shared';

/**
 * The Stock Ledger (§13) — `production_stock_history` read back as the movement
 * history a human reads, rather than as the storage shape.
 *
 * ── STORED vs SYNTHESISED ────────────────────────────────────────────────────
 * Five of the nine ledger types are stored movements and map one-for-one onto a
 * `production_stock_movement_type`. The other four are computed:
 *
 *   · OPENING / CLOSING are Σ delta before / up to the day. They are arithmetic
 *     over the movements, not movements themselves. Storing them would create a
 *     second source of truth for a figure the ledger already implies, and the
 *     first bug would be the two disagreeing — the exact failure a ledger exists
 *     to prevent.
 *   · DEMAND_RESERVED is an outstanding claim on stock that has not moved.
 *     Writing it into the ledger would double-count it against the
 *     DEMAND_FULFILLED (`transfer_out`) row booked when the same goods are
 *     verified out.
 *
 * Synthesised rows carry `transactionNo: null` and `balanceAfter: null` precisely
 * so they cannot be mistaken for transactions — there is nothing to quote on a
 * query and nothing was posted.
 *
 * ── EVERY FILTER IS SERVER-SIDE ──────────────────────────────────────────────
 * The ledger grows without bound. Filtering or searching a full download in the
 * browser works on the first week and dies on the first year, so the page never
 * decides what to show — it asks.
 */

/** Stored movement type → the ledger vocabulary. Adjustment splits on sign. */
function ledgerTypeOf(type: ProductionStockMovementType, delta: number): ProductionLedgerType {
  switch (type) {
    case 'prepare':
      return 'PREPARED';
    case 'transfer_out':
      return 'DEMAND_FULFILLED';
    case 'return_in':
      return 'RETURN';
    case 'sale':
      return 'SALE';
    case 'adjustment':
      return delta >= 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
  }
}

/** The reverse map, so a `movementType` filter can be pushed into the query. */
const STORED_TYPE_FOR: Partial<Record<ProductionLedgerType, ProductionStockMovementType>> = {
  PREPARED: 'prepare',
  DEMAND_FULFILLED: 'transfer_out',
  RETURN: 'return_in',
  SALE: 'sale',
  ADJUSTMENT_IN: 'adjustment',
  ADJUSTMENT_OUT: 'adjustment',
};

export interface LedgerQuery {
  from?: string;
  to?: string;
  productId?: string;
  categoryId?: string;
  branchId?: string;
  movementType?: string;
  status?: 'posted' | 'reserved';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LedgerPage {
  rows: ProductionStockLedgerRow[];
  total: number;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Read the ledger.
 *
 * `total` is the count of STORED movements matching the filter, which is what
 * the pager walks. The synthesised OPENING / CLOSING pair is attached only when
 * the window is a single product on a single day (the product-detail view), where
 * it is the whole point — see `productDayLedger`. A paged, multi-product listing
 * deliberately has no opening row: "opening" is per product, and one at the top of
 * a mixed list would be a sum across products that means nothing.
 */
export async function getStockLedger(q: LedgerQuery): Promise<LedgerPage> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const offset = q.offset ?? 0;

  // Resolving the category to its products up front lets the movement query stay
  // a plain indexed filter — `production_stock_history` has no category column,
  // and joining products just to filter would read the whole ledger.
  let productIds: string[] | null = null;
  if (q.categoryId) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('category_id', q.categoryId);
    if (error) throw error;
    productIds = (data ?? []).map((p) => p.id as string);
    // An empty category matches no movement. Returning early avoids sending
    // PostgREST an `in.()` with no values, which is a syntax error rather than
    // the empty result it looks like it should be.
    if (productIds.length === 0) return { rows: [], total: 0, limit, offset };
  }

  // Free text spans columns the ledger holds (product name, transaction number,
  // reference) and columns it does not (product code, branch name). The ones it
  // does not are resolved to ids first, for the same reason as the category.
  let searchProductIds: string[] | null = null;
  let searchBranchIds: string[] | null = null;
  const search = q.search?.trim();
  if (search) {
    const like = `%${search}%`;
    const [prods, branches] = await Promise.all([
      supabaseAdmin.from('products').select('id').or(`stock_code.ilike.${like},name.ilike.${like}`),
      supabaseAdmin.from('branches').select('id').ilike('name', like),
    ]);
    if (prods.error) throw prods.error;
    if (branches.error) throw branches.error;
    searchProductIds = (prods.data ?? []).map((p) => p.id as string);
    searchBranchIds = (branches.data ?? []).map((b) => b.id as string);
  }

  let query = supabaseAdmin
    .from('production_stock_history')
    .select(
      `id, transaction_no, created_at, business_date, product_id, product_name, type, delta,
       balance_after, ref_id, branch_id, production_order_id, created_by, created_by_name,
       reason, remarks`,
      { count: 'exact' },
    );

  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.productId) query = query.eq('product_id', q.productId);
  if (productIds) query = query.in('product_id', productIds);
  if (q.branchId) query = query.eq('branch_id', q.branchId);

  const stored = q.movementType ? STORED_TYPE_FOR[q.movementType as ProductionLedgerType] : undefined;
  if (stored) query = query.eq('type', stored);
  // A DEMAND_RESERVED or OPENING/CLOSING filter asks for rows this table does not
  // hold. Answer honestly with nothing rather than silently ignoring the filter
  // and returning every movement, which would read as "there are no reserved rows
  // and here is everything else".
  if (q.movementType && !stored) return { rows: [], total: 0, limit, offset };
  // Likewise: every stored movement is posted, so a 'reserved' filter matches none.
  if (q.status === 'reserved') return { rows: [], total: 0, limit, offset };

  if (search) {
    const like = `%${search}%`;
    const clauses = [
      `product_name.ilike.${like}`,
      `transaction_no.ilike.${like}`,
      `ref_id.ilike.${like}`,
      `remarks.ilike.${like}`,
    ];
    if (searchProductIds?.length) clauses.push(`product_id.in.(${searchProductIds.join(',')})`);
    if (searchBranchIds?.length) clauses.push(`branch_id.in.(${searchBranchIds.join(',')})`);
    query = query.or(clauses.join(','));
  }

  const { data, error, count } = await query
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const raw = (data ?? []) as {
    id: string; transaction_no: string | null; created_at: string; business_date: string;
    product_id: string; product_name: string; type: ProductionStockMovementType; delta: number | string;
    balance_after: number | string | null; ref_id: string | null; branch_id: string | null;
    production_order_id: string | null; created_by: string | null; created_by_name: string | null;
    reason: string | null; remarks: string | null;
  }[];

  // Codes and branch names are not on the ledger; one lookup each rather than a
  // join, so the paged query above stays a single indexed read.
  const [codes, branchNames] = await Promise.all([
    stockCodesFor([...new Set(raw.map((r) => r.product_id))]),
    branchNamesFor([...new Set(raw.map((r) => r.branch_id).filter((b): b is string => !!b))]),
  ]);

  const rows: ProductionStockLedgerRow[] = raw.map((r) => {
    const delta = Number(r.delta ?? 0);
    return {
      id: r.id,
      transactionNo: r.transaction_no,
      createdAt: r.created_at,
      businessDate: r.business_date,
      productId: r.product_id,
      productName: r.product_name,
      stockCode: codes.get(r.product_id) ?? '—',
      transactionType: ledgerTypeOf(r.type, delta),
      qty: delta,
      branchId: r.branch_id,
      branchName: r.branch_id ? (branchNames.get(r.branch_id) ?? null) : null,
      productionOrderId: r.production_order_id,
      referenceId: r.ref_id,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      remarks: r.remarks ?? r.reason,
      balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
    };
  });

  return { rows, total: count ?? rows.length, limit, offset };
}

/**
 * One product, one business day, as §14 draws it: OPENING, then every movement in
 * clock order, then any outstanding reservation, then CLOSING.
 *
 * This is the view where the synthesised rows earn their place — the whole point
 * is to show how the day got from its opening figure to its balance, and the
 * arithmetic is only legible with both ends stated.
 */
export async function getProductDayLedger(
  productId: string,
  date: string = businessDateStr(),
): Promise<ProductionStockLedgerRow[]> {
  const [prior, day, product, reservations] = await Promise.all([
    supabaseAdmin
      .from('production_stock_history')
      .select('delta')
      .eq('product_id', productId)
      .lt('business_date', date),
    getStockLedger({ productId, from: date, to: date, limit: 200 }),
    supabaseAdmin.from('products').select('id, name, stock_code').eq('id', productId).maybeSingle(),
    outstandingReservationRows(productId, date),
  ]);
  if (prior.error) throw prior.error;
  if (product.error) throw product.error;

  const opening = ((prior.data ?? []) as { delta: number | string }[])
    .reduce((s, h) => s + Number(h.delta ?? 0), 0);
  const name = (product.data?.name as string) ?? 'Unknown product';
  const stockCode = (product.data?.stock_code as string) ?? '—';

  // Oldest first here, unlike the paged listing: this view is read as a story of
  // the day, and a story runs forwards.
  const movements = [...day.rows].reverse();

  const synthetic = (
    transactionType: ProductionLedgerType,
    qty: number,
    at: string,
  ): ProductionStockLedgerRow => ({
    id: `${productId}:${date}:${transactionType}`,
    transactionNo: null,
    createdAt: at,
    businessDate: date,
    productId,
    productName: name,
    stockCode,
    transactionType,
    qty,
    branchId: null,
    branchName: null,
    productionOrderId: null,
    referenceId: null,
    createdBy: null,
    createdByName: null,
    remarks:
      transactionType === 'OPENING'
        ? "Carried forward from the previous business day's closing balance"
        : "The day's closing balance — tomorrow's opening",
    balanceAfter: null,
  });

  // The business day runs 02:00 → 02:00 Karachi (UTC+5), so its opening instant
  // is 21:00 UTC on the previous calendar date. Stated rather than guessed at,
  // because the row sorts against real timestamps.
  const openAt = `${date}T02:00:00+05:00`;
  const closeAt = `${date}T01:59:59+05:00`;

  const closing =
    opening + movements.reduce((s, m) => s + m.qty, 0);

  return [
    synthetic('OPENING', opening, openAt),
    ...movements,
    ...reservations,
    synthetic('CLOSING', closing, closeAt),
  ];
}

/**
 * Outstanding demand shown as DEMAND_RESERVED rows — one per claiming order.
 *
 * Negative `qty`, because that is what the claim will do to the shelf when it is
 * verified. It is NOT part of the closing arithmetic above and must never be: the
 * goods have not moved, and the same units appear again as DEMAND_FULFILLED when
 * they do. Reserved rows are marked by a null `transactionNo` and are only ever
 * shown for today, since an outstanding claim has no history.
 */
async function outstandingReservationRows(
  productId: string,
  date: string,
): Promise<ProductionStockLedgerRow[]> {
  if (date !== businessDateStr()) return [];

  const { data, error } = await supabaseAdmin
    .from('production_orders')
    .select('id, demand_number, branch_id, branch_name, status, submitted_at, items:production_order_items(product_id, qty, approved_qty)')
    .in('status', ['pending', 'awaiting_verification']);
  if (error) throw error;

  const rows: ProductionStockLedgerRow[] = [];
  for (const o of (data ?? []) as unknown as {
    id: string; demand_number: string | null; branch_id: string | null; branch_name: string | null;
    status: string; submitted_at: string;
    items: { product_id: string | null; qty: number | string; approved_qty: number | string | null }[];
  }[]) {
    for (const it of o.items ?? []) {
      if (it.product_id !== productId) continue;
      // Same rule as getOutstandingDemand: pending claims the request, a reviewed
      // order claims what Production agreed to send.
      const qty = o.status === 'pending' ? Number(it.qty ?? 0) : Number(it.approved_qty ?? it.qty ?? 0);
      if (!qty) continue;
      rows.push({
        id: `reserved:${o.id}:${productId}`,
        transactionNo: null,
        createdAt: o.submitted_at,
        businessDate: date,
        productId,
        productName: '',
        stockCode: '',
        transactionType: 'DEMAND_RESERVED',
        qty: -qty,
        branchId: o.branch_id,
        branchName: o.branch_name,
        productionOrderId: o.id,
        referenceId: o.demand_number,
        createdBy: null,
        createdByName: null,
        remarks:
          o.status === 'pending'
            ? 'Submitted, awaiting review — not yet off the shelf'
            : 'Sent by Production, awaiting branch verification — not yet off the shelf',
        balanceAfter: null,
      });
    }
  }
  return rows;
}

async function stockCodesFor(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin.from('products').select('id, stock_code').in('id', ids);
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.id as string, (p.stock_code as string) ?? '—']));
}

async function branchNamesFor(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin.from('branches').select('id, name').in('id', ids);
  if (error) throw error;
  return new Map((data ?? []).map((b) => [b.id as string, b.name as string]));
}
