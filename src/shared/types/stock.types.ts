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
