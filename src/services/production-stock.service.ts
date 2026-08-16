import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  type ProductionStockFigures,
  type ProductionStockMovementType,
  type ProductionStockRow,
} from '../shared';
import {
  InsufficientStockError,
  type SaleBalance,
  type SaleItem,
  type StockShortfall,
} from './stock.service';

/**
 * Central Production Stock pool (no cron). Mirrors the derived-stock approach in
 * `stock.service.ts` but for a single, branch-agnostic pool: running balance per
 * product_id in `production_stock`, every movement appended to
 * `production_stock_history`.
 *
 * The read-modify-write lives in apply_production_stock_movement (migration 15)
 * for the same reason as branch stock: PostgREST gives each call its own
 * transaction, so a balance read and its write cannot be made atomic from here.
 *
 * Idempotency is the UNIQUE (ref_id, product_id, type) — a retry that reuses the
 * same refId is a no-op. Negative balances are allowed (flagged in the UI, never
 * blocked), matching the branch-stock philosophy.
 */

interface ProductionMovementInput {
  productId: string;
  productName: string;
  delta: number; // signed
  type: ProductionStockMovementType;
  refId: string;
}

/** Apply one signed movement to the pool. Returns the post-movement balance. */
export async function applyProductionStockMovement(input: ProductionMovementInput): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('apply_production_stock_movement', {
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

/** Record "Today's Prepared Products" — each qty is positive; adds to the pool. */
export function prepareProducts(
  refId: string,
  items: { productId: string; productName: string; qty: number }[],
): Promise<number[]> {
  return Promise.all(
    items.map((i) =>
      applyProductionStockMovement({
        productId: i.productId,
        productName: i.productName,
        delta: Math.abs(i.qty),
        type: 'prepare',
        refId,
      }),
    ),
  );
}

/** On demand approval, move approved units OUT of the pool (recorded as a negative delta). */
export function transferOutOnApproval(
  orderId: string,
  items: { productId: string; productName: string; qty: number }[],
): Promise<number[]> {
  return Promise.all(
    items
      .filter((i) => i.qty > 0)
      .map((i) =>
        applyProductionStockMovement({
          productId: i.productId,
          productName: i.productName,
          delta: -Math.abs(i.qty),
          type: 'transfer_out',
          refId: orderId,
        }),
      ),
  );
}

/** On an accepted return, add units BACK into the pool. */
export function returnIntoPool(
  returnId: string,
  item: { productId: string; productName: string; qty: number },
): Promise<number> {
  return applyProductionStockMovement({
    productId: item.productId,
    productName: item.productName,
    delta: Math.abs(item.qty),
    type: 'return_in',
    refId: returnId,
  });
}

/**
 * Atomically validate the pool, write the order + its line items, decrement
 * `production_stock` and append `production_stock_history` — all inside ONE
 * transaction (migration 35's commit_production_sale).
 *
 * The production-counter sibling of `commitSaleTransaction`
 * (stock.service.ts): identical parameters and return shape, but the units come
 * out of the central pool instead of a branch's `stock`. `branchId` is
 * attribution only — it lands on the order row (orders.branch_id is NOT NULL, and
 * it is what puts the sale in that branch's revenue reports) and moves no branch
 * balance.
 *
 * Unlike `applyProductionStockMovement`, this one BLOCKS rather than letting the
 * pool go negative — see the migration header for why a sale is different from a
 * prepare/transfer/return. Throws `InsufficientStockError` with nothing
 * persisted, so the route can reuse the same 409 path as the branch POS sale.
 */
export async function commitProductionSaleTransaction(params: {
  order: Record<string, unknown>;
  items: SaleItem[];
  branchId: string;
}): Promise<{ orderId: string; balances: Map<string, SaleBalance> }> {
  const { data, error } = await supabaseAdmin.rpc('commit_production_sale', {
    p_order: params.order,
    p_items: params.items,
    p_branch_id: params.branchId,
    p_business_date: businessDateStr(),
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

/**
 * Build the Production Stock table for a Karachi day: current pool balance per
 * product plus today's prepared / transferred-out / returned totals.
 * `totalStock` is the gross available for the day (balance + what was moved out).
 */
export async function getProductionStockRows(date: string = businessDateStr()): Promise<ProductionStockRow[]> {
  // The date filter is an indexed predicate rather than a full-collection scan.
  //
  // `products` is read for the stock_code — the STK-###### the Help Desk needs to
  // raise a query against an item. Unfiltered on purpose: a product deactivated
  // today can still hold pool balance, and its row must not lose its ID.
  const [products, stock, history] = await Promise.all([
    supabaseAdmin.from('products').select('id, name, stock_code, is_active'),
    supabaseAdmin.from('production_stock').select('product_id, product_name, balance'),
    supabaseAdmin
      .from('production_stock_history')
      .select('product_id, product_name, type, delta')
      .eq('business_date', date),
  ]);
  if (products.error) throw products.error;
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const catalogue = (products.data ?? []) as
    { id: string; name: string; stock_code: string; is_active: boolean }[];
  const codeById = new Map(catalogue.map((p) => [p.id, p.stock_code]));

  const rows = new Map<string, ProductionStockRow>();

  // Seed from the ACTIVE catalogue, as the branch Stock page does, so every item
  // production sells is listed with its ID from the start. Without this a product
  // that has never been prepared has no row at all — nothing to read a code off,
  // and so nothing that can be queried.
  for (const p of catalogue) {
    if (!p.is_active) continue;
    rows.set(p.id, {
      productId: p.id,
      stockCode: p.stock_code,
      productName: p.name,
      preparedToday: 0,
      totalStock: 0,
      approvedQty: 0,
      balance: 0,
      returned: 0,
      soldToday: 0,
      adjustment: 0,
    });
  }

  // Overlay the current pool balances. An inactive product still holding balance
  // gets its row here rather than being dropped.
  for (const d of (stock.data ?? []) as { product_id: string; product_name: string; balance: number | string }[]) {
    const existing = rows.get(d.product_id);
    if (existing) {
      existing.balance = Number(d.balance ?? 0);
      continue;
    }
    rows.set(d.product_id, {
      productId: d.product_id,
      stockCode: codeById.get(d.product_id) ?? '—',
      productName: d.product_name,
      preparedToday: 0,
      totalStock: 0,
      approvedQty: 0,
      balance: Number(d.balance ?? 0),
      returned: 0,
      soldToday: 0,
      adjustment: 0,
    });
  }

  // Fold today's movements in.
  for (const h of (history.data ?? []) as {
    product_id: string;
    product_name: string;
    type: ProductionStockMovementType;
    delta: number | string;
  }[]) {
    let row = rows.get(h.product_id);
    if (!row) {
      // A product with movement today but no balance row yet (net zero) — still show it.
      row = {
        productId: h.product_id,
        stockCode: codeById.get(h.product_id) ?? '—',
        productName: h.product_name,
        preparedToday: 0,
        totalStock: 0,
        approvedQty: 0,
        balance: 0,
        returned: 0,
        soldToday: 0,
        adjustment: 0,
      };
      rows.set(h.product_id, row);
    }
    // SIGNED, not Math.abs. The pool stores prepare/return_in positive and
    // transfer_out/sale negative, so negating the two outbound types reports them
    // positive — identical to the branch fold in computeStockRows, and identical
    // to abs() for every movement the pool wrote before corrections existed.
    //
    // It matters now: an admin lowering "Prepared Today" appends a NEGATIVE
    // 'prepare' movement, and abs() would have counted that as more prepared.
    const delta = Number(h.delta ?? 0);
    if (h.type === 'prepare') row.preparedToday += delta;
    else if (h.type === 'transfer_out') row.approvedQty -= delta;
    else if (h.type === 'return_in') row.returned += delta;
    else if (h.type === 'sale') row.soldToday -= delta;
    // 'adjustment' folds into none of the four above — it is the remainder they do
    // not explain — but it is no longer dropped: it is reported on its own,
    // SIGNED, so the page can show what an admin corrected today rather than
    // leaving an unexplained gap between the four figures and the balance.
    else if (h.type === 'adjustment') row.adjustment += delta;
  }

  // totalStock = what's on hand now + everything that already left today. Counter
  // sales leave the pool just like an approved transfer does, so they belong in
  // this sum — without them the gross view would shrink every time one is rung up.
  for (const row of rows.values()) row.totalStock = row.balance + row.approvedQty + row.soldToday;

  return [...rows.values()].sort((a, b) => b.balance - a.balance || a.productName.localeCompare(b.productName));
}

/**
 * The derived pool figures for ONE product on one business date — the
 * single-product form of `getProductionStockRows`, for callers (the Support
 * Center's stock reference) that need one product rather than the whole
 * catalogue. Same definitions, so the admin sees exactly what the Production
 * Stock page shows.
 *
 * `adjustment` is not on the page (it is the remainder, already inside balance)
 * but is carried here so the correction dialog can show what earlier corrections
 * already booked today.
 */
export async function getProductionStockFigures(
  productId: string,
  date: string = businessDateStr(),
): Promise<ProductionStockFigures> {
  const [stock, history] = await Promise.all([
    supabaseAdmin.from('production_stock').select('balance').eq('product_id', productId).maybeSingle(),
    supabaseAdmin
      .from('production_stock_history')
      .select('type, delta')
      .eq('product_id', productId)
      .eq('business_date', date),
  ]);
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const figures: ProductionStockFigures = {
    preparedToday: 0,
    approvedQty: 0,
    returned: 0,
    soldToday: 0,
    adjustment: 0,
    balance: Number(stock.data?.balance ?? 0),
    totalStock: 0,
  };

  // Same signed convention as getProductionStockRows above.
  for (const h of (history.data ?? []) as { type: ProductionStockMovementType; delta: number | string }[]) {
    const delta = Number(h.delta ?? 0);
    if (h.type === 'prepare') figures.preparedToday += delta;
    else if (h.type === 'transfer_out') figures.approvedQty -= delta;
    else if (h.type === 'return_in') figures.returned += delta;
    else if (h.type === 'sale') figures.soldToday -= delta;
    else if (h.type === 'adjustment') figures.adjustment += delta;
  }
  figures.totalStock = figures.balance + figures.approvedQty + figures.soldToday;
  return figures;
}

/** What the admin may set on the pool. An omitted key is LEFT ALONE. */
export type ProductionStockCorrectionTargets = Partial<
  Pick<ProductionStockFigures, 'preparedToday' | 'approvedQty' | 'returned' | 'soldToday' | 'balance'>
>;

export interface ProductionStockCorrectionResult {
  applied: boolean;
  before: ProductionStockFigures;
  after: ProductionStockFigures;
  movements: { type: ProductionStockMovementType; delta: number }[];
}

/**
 * Thrown when migration 50 has not been applied to the database yet. Migrations are
 * pushed by hand here (the dyno does not run them at boot), so the alternative is a
 * bare 500 from PostgREST that reads as a bug rather than as a pending deploy step.
 */
export class CorrectionUnavailableError extends Error {
  constructor() {
    super(
      'Production stock corrections are not installed on the database yet. Apply migrations 49 and 50, then try again.',
    );
    this.name = 'CorrectionUnavailableError';
  }
}

/**
 * Apply an admin correction to the central pool (migration 50) — the pool's
 * sibling of `applyStockCorrection`. Targets are ABSOLUTE: the server sizes one
 * compensating movement per figure against the live ledger, inside one
 * transaction, and the append-only history keeps every original row.
 *
 * Unlike the branch version this cannot fail on a negative result: the pool is
 * allowed to go negative (migration 15), and a product already negative has to
 * stay correctable. The resulting balance comes back in `after` so the caller can
 * say so.
 */
export async function applyProductionStockCorrection(params: {
  productId: string;
  productName: string;
  targets: ProductionStockCorrectionTargets;
  ticketId: string;
  businessDate?: string;
}): Promise<ProductionStockCorrectionResult> {
  const { data, error } = await supabaseAdmin.rpc('apply_production_stock_correction', {
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_targets: params.targets,
    p_ticket_id: params.ticketId,
    p_business_date: params.businessDate ?? businessDateStr(),
  });
  if (error) {
    // PGRST202 is PostgREST's "no function matches this name and signature".
    if (error.code === 'PGRST202' || /apply_production_stock_correction/.test(error.message ?? '')) {
      throw new CorrectionUnavailableError();
    }
    throw error;
  }

  const result = (data ?? {}) as {
    applied?: boolean;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    movements?: { type: ProductionStockMovementType; delta: number | string }[];
  };

  // numeric(14,3) arrives as a string from PostgREST — coerce every figure.
  const figures = (raw: Record<string, unknown> = {}): ProductionStockFigures => ({
    preparedToday: Number(raw['preparedToday'] ?? 0),
    approvedQty: Number(raw['approvedQty'] ?? 0),
    returned: Number(raw['returned'] ?? 0),
    soldToday: Number(raw['soldToday'] ?? 0),
    adjustment: Number(raw['adjustment'] ?? 0),
    balance: Number(raw['balance'] ?? 0),
    totalStock: Number(raw['totalStock'] ?? 0),
  });

  return {
    applied: Boolean(result.applied),
    before: figures(result.before),
    after: figures(result.after),
    movements: (result.movements ?? []).map((m) => ({ type: m.type, delta: Number(m.delta) })),
  };
}
