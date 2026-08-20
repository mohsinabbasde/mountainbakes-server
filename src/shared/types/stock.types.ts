export type StockMovementType = 'sale' | 'production' | 'return' | 'adjustment';

/** Running balance per (branchId, productId), keyed by (branchId, productId). */
export interface StockDoc {
  branchId: string;
  productId: string;
  productName: string;
  balance: number;
  updatedAt: string; // ISO UTC
}

/** Append-only movement log. */
export interface StockHistoryRow {
  id: string;
  branchId: string;
  productId: string;
  productName: string;
  type: StockMovementType;
  delta: number; // signed: +production, -sale
  balanceAfter: number;
  refId: string; // originating order / production order id
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdAt: string; // ISO UTC
}

/**
 * The derived figures for one product on one business date — the numeric core of a
 * `StockRow`, without the product identity. Also carried on a stock support
 * reference so the Support Center can render and correct the figures without
 * re-deriving them from display labels.
 */
export interface StockFigures {
  opening: number;
  newQty: number;
  sold: number;
  returned: number;
  /** Signed — see StockRow.adjustment. */
  adjustment: number;
  balance: number;
}

/** Computed per-product row for the Stock page. */
export interface StockRow {
  productId: string;
  stockCode: string; // human-readable STK-###### (per product)
  productName: string;
  opening: number;
  newQty: number;
  sold: number;
  returned: number; // units returned to production today (positive)
  /**
   * Signed net of today's `adjustment` movements — an admin stock correction from
   * the Support Center, or the compensating move behind a sale edit. Signed on
   * purpose: the direction is the point, and it is what makes the row reconcile
   * (opening + newQty − sold − returned + adjustment = balance).
   */
  adjustment: number;
  balance: number;
}

/**
 * A blocked sale attempt — written when the server refuses a POS sale because a
 * product had insufficient (or zero) stock. Reviewable by Admin. One document
 * per offending product line so it renders as a flat audit table.
 */
export interface StockAuditLog {
  id: string;
  branchId: string;
  branchName: string;
  userId: string;
  userName: string;
  productId: string;
  productName: string;
  requestedQty: number;
  availableQty: number;
  reason: 'Out of Stock' | 'Insufficient Stock';
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdAt: string; // ISO UTC
}

/**
 * One business day of a branch's stock ledger, aggregated across every product —
 * the row behind Branch Dashboard → Branch Stock History.
 *
 * Same derivation as `StockRow` (opening + new − sold − returned + adjustment =
 * balance), summed over products instead of listed per product, and carrying a
 * money figure beside every quantity.
 *
 * WHAT THE AMOUNTS ARE: every quantity is valued at the product's CURRENT
 * `products.price`, including the sold column. That is a deliberate choice and it
 * is not the day's takings — an order's revenue is its snapshotted `unitPrice`
 * less discount, and if this column used that number the row would stop adding
 * up (`openingAmount + newAmount − soldAmount − returnedAmount + adjustmentAmount
 * = balanceAmount`) on any day with a discount or a since-changed price. Read
 * these as stock valued at today's price list; read Sales on the same dashboard
 * for money actually taken.
 */
export interface BranchStockHistoryRow {
  /** Business date 'YYYY-MM-DD' (Karachi, 2 AM rollover). */
  date: string;
  /** Balance carried in from the previous business day. */
  openingQty: number;
  openingAmount: number;
  /** Stock added by Production approvals on this day. */
  newQty: number;
  newAmount: number;
  /** Units sold on this day — positive, though stored as negative deltas. */
  soldQty: number;
  soldAmount: number;
  /** Units handed back to Production — positive, same as `sold`. */
  returnedQty: number;
  returnedAmount: number;
  /** Signed net of admin corrections, so the row reconciles. */
  adjustmentQty: number;
  adjustmentAmount: number;
  /** Closing balance — what the branch carries into the next day. */
  balanceQty: number;
  balanceAmount: number;
}
