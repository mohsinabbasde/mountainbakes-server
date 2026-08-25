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
  preparedToday: number;
  approvedQty: number;
  returned: number;
  soldToday: number;
  adjustment: number;
  /** The running pool balance, yesterday carried forward. Correctable. */
  balance: number;
  /** What the pool took in today: prepared + returned. Opening is not in it. */
  totalStock: number;
  /**
   * Today's own position — totalStock − approvedQty − soldToday + adjustment.
   * Negative means the shortfall the floor still has to bake. Derived, so it is
   * not correctable on its own: correct the figures it is made of.
   */
  dayBalance: number;
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
  preparedToday: number; // Σ prepare deltas today
  /**
   * What the pool took IN today: prepared + returned.
   *
   * Yesterday's carry-forward is deliberately NOT in this sum. The pool is baked
   * fresh each morning, so a balance that opened negative made every product
   * prepared today read negative too — the floor made 50 and the sheet said -50.
   * Reading the day on its own is what puts a newly prepared product back on a
   * positive figure. `balance` below still carries the running total for the
   * callers that need it.
   */
  totalStock: number;
  approvedQty: number; // Σ transferred out today
  balance: number; // running pool balance, yesterday carried forward
  /**
   * Today's own position: totalStock − approvedQty − soldToday + adjustment.
   *
   * NEGATIVE IS A REAL ANSWER and must not be clamped: it is the shortfall the
   * floor still has to bake before what has already gone out is covered. This is
   * the figure the Production Stock page shows as Balance; `balance` is what the
   * Demand Summary and the counter-sale check read, and neither is changed by it.
   */
  dayBalance: number;
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

/**
 * Where a return sits in Production's review.
 *
 * Two of the four are terminal and two are open:
 *
 * - `pending`  — awaiting Production. The units have already left the branch
 *                balance (a branch return moves them as it is saved) but the
 *                central pool has NOT been credited yet.
 * - `returned` — Production handed it back to the branch to correct. Same stock
 *                position as `pending`, moves nothing on its own; the branch
 *                fixes the figure and resubmits, which returns it to `pending`.
 * - `accepted` — Production took it. The pool is credited. Final.
 * - `rejected` — Production refused it. The units go back onto the branch
 *                balance. Final.
 *
 * `pending` and `returned` are the ONLY states in which a branch may change or
 * delete its own return; both terminal states are locked to it. That rule lives
 * in `branch-returns.service.ts` on the server, and the Return Stock page's
 * `isCorrectable` is its client-side mirror deciding which buttons render.
 */
export type ProductionReturnStatus = 'pending' | 'accepted' | 'rejected' | 'returned';

export interface ProductionReturn {
  id: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  status: ProductionReturnStatus;
  /**
   * Which side raised it: 'branch' for the branch-initiated path
   * (POST /api/stock/return), null when Production recorded it
   * (POST /api/production-returns). Both now start `pending`; what differs is
   * which stock has already moved by then, and the review has to know:
   *
   * - `'branch'` — the units are already OFF the branch balance and are waiting
   *   on Production, so accepting only credits the pool and rejecting only puts
   *   them back on the branch.
   * - `null` — nothing has moved at all; it is Production's note that goods
   *   arrived, so accepting does BOTH movements and rejecting does none.
   *
   * It also decides who may change the record. Branch → Return Stock offers
   * Change, Delete and Resubmit on its own `'branch'` rows only; a
   * Production-recorded return is Production's account of what it received and
   * is corrected on their screen — which is also why Send Back is offered on
   * `'branch'` rows alone, there being no branch paperwork to hand back
   * otherwise. The server enforces both rules in `branch-returns.service.ts` and
   * `production-returns.routes.ts`, so this is the client knowing why a button
   * is absent, not the rule itself.
   */
  source: 'branch' | null;
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}
