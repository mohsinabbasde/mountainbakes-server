// Central Production department operations: the production stock pool, product
// returns, and production expenses. These are distinct from per-branch `stock`
// (see stock.types.ts) — the production pool is a single, branch-agnostic pool
// keyed by productId.

// ── Production Stock pool ────────────────────────────────────────────────────

export type ProductionStockMovementType =
  | 'prepare' // Production prepared units → pool +
  | 'transfer_out' // demand approved, moved to a branch → pool −
  | 'return_in' // accepted return added back → pool +
  | 'sale' // sold at the production counter → pool − (branch stock untouched)
  | 'adjustment';

/** Running balance for the central production pool. Keyed by `productId`. */
export interface ProductionStockDoc {
  productId: string;
  productName: string;
  balance: number;
  updatedAt: string; // ISO UTC
}

/** Append-only movement log for the production pool. doc id = `${refId}_${productId}_${type}`. */
export interface ProductionStockHistoryRow {
  id: string;
  productId: string;
  productName: string;
  type: ProductionStockMovementType;
  delta: number; // signed
  balanceAfter: number;
  refId: string; // prep batch / order / return id
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdAt: string; // ISO UTC
}

/**
 * The derived pool figures for one product on one business date — the numeric core
 * of a `ProductionStockRow`, without the product identity. The pool's counterpart
 * of `StockFigures`, carried on a production stock support reference so the Support
 * Center can render and correct them without re-deriving them from display labels.
 *
 * `adjustment` is SIGNED (the direction is the information) and `totalStock` is
 * derived — balance + approved + sold — so neither is directly correctable.
 */
export interface ProductionStockFigures {
  /**
   * The pool balance at the start of this business day — yesterday's closing.
   * Derived exactly as the branch ledger derives it (StockFigures.opening):
   * balance minus the day's net movement. Not correctable, for the same reason
   * the branch's is not: it is a day that has already closed.
   */
  opening: number;
  preparedToday: number;
  approvedQty: number;
  returned: number;
  soldToday: number;
  adjustment: number;
  balance: number;
  totalStock: number;
}

/** Computed per-product row for the Production Stock page. */
export interface ProductionStockRow {
  productId: string;
  /**
   * The product's human-readable STK-###### — the same code the branch Stock page
   * shows, because it identifies the PRODUCT, not a branch's row. It is what the
   * Help Desk is given to raise a stock query, so the pool page has to show it or
   * a production user has nothing to quote.
   */
  stockCode: string;
  productName: string;
  opening: number; // pool balance at the start of the day (balance − today's net)
  preparedToday: number; // Σ prepare deltas today
  totalStock: number; // current balance + what left today (a "gross in" view)
  approvedQty: number; // Σ transferred out today
  balance: number; // current pool balance
  returned: number; // Σ returns added back today
  soldToday: number; // Σ sold at the production counter today
  /**
   * Σ signed 'adjustment' deltas today — admin corrections and nothing else.
   * Shown as its own column rather than folded into the four figures above: it is
   * the remainder they do not explain, and folding it would report a correction
   * as production or a return. Day-scoped like every other figure here, so it
   * reads 0 tomorrow with its effect already inside the balance.
   */
  adjustment: number;
}

// ── Product Returns ──────────────────────────────────────────────────────────

export type ProductionReturnStatus = 'pending' | 'accepted' | 'rejected';

export interface ProductionReturn {
  id: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  status: ProductionReturnStatus;
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}
