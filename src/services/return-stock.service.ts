import { dbFor } from '../db';
import {
  businessDateStr,
  type ProductionReturnDisposition,
  type ReturnStockMovementRow,
  type ReturnStockMovementType,
  type ReturnStockRow,
} from '../shared';

const db = dbFor('return-stock');

/**
 * Branch Return Stock — the inventory of goods branches have sent back.
 *
 * SEPARATE from the production pool (production-stock.service.ts), with its own
 * tables and ledger (`return_stock`, `return_stock_history`, migration 139). An
 * accepted return lands here and nowhere else. Nothing in this module adds a
 * return to production stock except `transferReturnStockToProduction`, which is
 * an explicit, authorised transaction and never a side effect of a return.
 */

export interface AcceptedReturn {
  branchId: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string | null;
  source: string | null;
}

/**
 * Accept a pending return and credit Branch Return Stock, in ONE transaction
 * (`accept_production_return`).
 *
 * Returns null when the return is no longer pending — somebody else reviewed it
 * first — in which case nothing was written.
 */
export async function acceptReturnIntoReturnStock(params: {
  returnId: string;
  disposition: ProductionReturnDisposition;
  dispositionNote?: string | null;
  actorId: string;
  actorName: string;
}): Promise<AcceptedReturn | null> {
  const { data, error } = await db.rpc('accept_production_return', {
    p_return_id: params.returnId,
    p_disposition: params.disposition,
    p_disposition_note: params.dispositionNote ?? null,
    p_reviewed_by: params.actorId,
    p_reviewed_by_name: params.actorName,
    p_business_date: businessDateStr(),
  });
  if (error) throw error;

  const result = (data ?? {}) as {
    status?: string; branchId?: string; productId?: string; productName?: string;
    qty?: number | string; reason?: string | null; source?: string | null;
  };
  if (result.status !== 'ok') return null;
  return {
    branchId: result.branchId!,
    productId: result.productId!,
    productName: result.productName!,
    qty: Number(result.qty ?? 0),
    reason: result.reason ?? null,
    source: result.source ?? null,
  };
}

/** Return Stock does not hold what the transfer asked for. Nothing was moved. */
export class InsufficientReturnStockError extends Error {
  constructor(
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`Return stock holds ${available}; cannot transfer ${requested}.`);
    this.name = 'InsufficientReturnStockError';
  }
}

/**
 * Move units from Branch Return Stock into Production Stock — the only bridge
 * between the two inventories.
 *
 * One SQL transaction debits the one and credits the other (as `return_transfer`)
 * under the same `refId`. A repeat with the same `refId` moves nothing and comes
 * back `duplicate`.
 */
export async function transferReturnStockToProduction(params: {
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  refId: string;
  actorId?: string | null;
  actorName?: string | null;
}): Promise<{ returnStock: number; productionStock: number; duplicate: boolean }> {
  const { data, error } = await db.rpc('transfer_return_stock_to_production', {
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_qty: params.qty,
    p_ref_id: params.refId,
    p_business_date: businessDateStr(),
    p_reason: params.reason,
    p_created_by: params.actorId ?? null,
    p_created_by_name: params.actorName ?? null,
  });
  if (error) throw error;

  const result = (data ?? {}) as {
    status?: string; error?: string; requested?: number | string; available?: number | string;
    returnStock?: number | string; productionStock?: number | string;
  };
  if (result.status === 'invalid') {
    throw Object.assign(new Error(result.error ?? 'Invalid transfer'), { status: 400 });
  }
  if (result.status === 'insufficient') {
    throw new InsufficientReturnStockError(Number(result.requested ?? params.qty), Number(result.available ?? 0));
  }
  return {
    returnStock: Number(result.returnStock ?? 0),
    productionStock: Number(result.productionStock ?? 0),
    duplicate: result.status === 'duplicate',
  };
}

/**
 * The Branch Return Stock table for a Karachi business day, folded out of
 * `return_stock_history` the same way the production table is folded out of its
 * own ledger: opening is everything before the day, the rest is the day itself.
 *
 * Products with nothing on hand and nothing happening are absent.
 */
export async function getReturnStockRows(date: string = businessDateStr()): Promise<ReturnStockRow[]> {
  const [products, prior, history] = await Promise.all([
    db.from('products').select('id, name, stock_code, category_id, category_name'),
    db.from('return_stock_history').select('product_id, delta').lt('business_date', date),
    db
      .from('return_stock_history')
      .select('product_id, product_name, type, delta')
      .eq('business_date', date),
  ]);
  if (products.error) throw products.error;
  if (prior.error) throw prior.error;
  if (history.error) throw history.error;

  const metaById = new Map(
    ((products.data ?? []) as {
      id: string; name: string; stock_code: string | null;
      category_id: string | null; category_name: string | null;
    }[]).map((p) => [p.id, p]),
  );

  const rows = new Map<string, ReturnStockRow>();
  const rowFor = (productId: string, fallbackName = 'Unknown product'): ReturnStockRow => {
    let r = rows.get(productId);
    if (!r) {
      const meta = metaById.get(productId);
      r = {
        productId,
        stockCode: meta?.stock_code ?? '—',
        productName: meta?.name ?? fallbackName,
        categoryId: meta?.category_id ?? null,
        categoryName: meta?.category_name ?? null,
        opening: 0,
        returnedToday: 0,
        transferredToday: 0,
        balance: 0,
      };
      rows.set(productId, r);
    }
    return r;
  };

  for (const h of (prior.data ?? []) as { product_id: string; delta: number | string }[]) {
    rowFor(h.product_id).opening += Number(h.delta ?? 0);
  }
  for (const h of (history.data ?? []) as {
    product_id: string; product_name: string; type: ReturnStockMovementType; delta: number | string;
  }[]) {
    const row = rowFor(h.product_id, h.product_name);
    const delta = Number(h.delta ?? 0);
    if (h.type === 'return_in') row.returnedToday += delta;
    else if (h.type === 'transfer_out') row.transferredToday -= delta;
  }
  for (const row of rows.values()) {
    row.balance = row.opening + row.returnedToday - row.transferredToday;
  }

  return [...rows.values()]
    .filter((r) => r.opening !== 0 || r.returnedToday !== 0 || r.transferredToday !== 0)
    .sort((a, b) => b.balance - a.balance || a.productName.localeCompare(b.productName));
}

/** Total Branch Return Stock on hand right now, across all products. */
export async function getReturnStockTotal(): Promise<number> {
  const { data, error } = await db.from('return_stock').select('balance');
  if (error) throw error;
  return ((data ?? []) as { balance: number | string }[]).reduce((s, r) => s + Number(r.balance ?? 0), 0);
}

const MOVEMENT_PAGE_MAX = 200;

/** The Branch Return Stock ledger, newest first. Every filter is server-side. */
export async function getReturnStockMovements(query: {
  from?: string;
  to?: string;
  productId?: string;
  branchId?: string;
  type?: ReturnStockMovementType;
  limit?: number;
  offset?: number;
}): Promise<{ rows: ReturnStockMovementRow[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MOVEMENT_PAGE_MAX);
  const offset = Math.max(query.offset ?? 0, 0);

  let q = db
    .from('return_stock_history')
    .select(
      'id, created_at, business_date, product_id, product_name, type, delta, balance_after, branch_id, production_return_id, ref_id, created_by_name, reason, branch:branches(name)',
      { count: 'exact' },
    )
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (query.from) q = q.gte('business_date', query.from);
  if (query.to) q = q.lte('business_date', query.to);
  if (query.productId) q = q.eq('product_id', query.productId);
  if (query.branchId) q = q.eq('branch_id', query.branchId);
  if (query.type) q = q.eq('type', query.type);

  const { data, error, count } = await q;
  if (error) throw error;

  const rows = ((data ?? []) as unknown as {
    id: string; created_at: string; business_date: string; product_id: string; product_name: string;
    type: ReturnStockMovementType; delta: number | string; balance_after: number | string;
    branch_id: string | null; production_return_id: string | null; ref_id: string;
    created_by_name: string | null; reason: string | null; branch: { name: string } | null;
  }[]).map((h) => ({
    id: h.id,
    createdAt: h.created_at,
    businessDate: h.business_date,
    productId: h.product_id,
    productName: h.product_name,
    type: h.type,
    qty: Number(h.delta ?? 0),
    balanceAfter: Number(h.balance_after ?? 0),
    branchId: h.branch_id,
    branchName: h.branch?.name ?? null,
    productionReturnId: h.production_return_id,
    referenceId: h.ref_id,
    createdByName: h.created_by_name,
    reason: h.reason,
  }));
  return { rows, total: count ?? rows.length };
}
