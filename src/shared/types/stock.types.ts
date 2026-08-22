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
  /**
   * False for a discontinued product. Such a product is still listed while it
   * holds stock or moved that day — the units are on the shelf and inside the
   * branch balance, so hiding them made the Stock page total disagree with the
   * dashboard's Remaining Stock. Callers that are choosing a product to SELL or
   * to stock up (rather than counting what is there) filter on this.
   */
  isActive: boolean;
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
 * Why one product's units sit in the day's aggregate but not in the per-product
 * table, or vice versa.
 *
 * - `deleted-from-catalogue` — the branch holds a balance for a product that is
 *   no longer in `products` at all. The aggregate counts the units (it sums the
 *   `stock` table); the per-product table cannot name a row it has no product
 *   for. This is the one cause that needs a data fix rather than an explanation.
 * - `discontinued` — an inactive product. Normally listed on both sides while it
 *   still holds stock, so this should not appear; if it does, the two sides are
 *   filtering the catalogue differently again.
 * - `unlisted` — an active product carrying a balance that the per-product table
 *   did not return. Should never happen.
 * - `mismatch` — both sides know the product and disagree about its quantity.
 *   Should never happen; it means the two derivations have drifted.
 */
export type StockReconciliationCause =
  | 'deleted-from-catalogue'
  | 'discontinued'
  | 'unlisted'
  | 'mismatch';

/** One product's contribution to the gap between the two figures. */
export interface StockReconciliationReason {
  productId: string;
  productName: string;
  /** Signed, in the direction statement − items: +3 means the aggregate counts 3 the table does not. */
  qty: number;
  cause: StockReconciliationCause;
}

/**
 * Cross-check between the two places a branch's remaining stock is stated:
 * the aggregated statement (Dashboard → Stock Detail) and the sum of the
 * per-product rows (Stock page). They are derived by different paths from the
 * same ledger, so agreement is an invariant rather than a coincidence — and for
 * a long time they disagreed silently, because nothing compared them.
 *
 * `difference` is `statementQty − itemsQty` and is 0 on a healthy day. When it
 * is not, `reasons` names the products responsible; `unexplained` is whatever
 * the named products do not account for, which is the part that cannot be
 * described and is therefore the most serious.
 */
export interface StockReconciliation {
  /** What Dashboard → Stock Detail prints as Remaining Stock items. */
  statementQty: number;
  /** What the Stock page's Balance column adds up to for the same day. */
  itemsQty: number;
  /** statementQty − itemsQty. Zero when the two agree. */
  difference: number;
  reasons: StockReconciliationReason[];
  /** Part of `difference` no product accounts for. Zero unless something is badly wrong. */
  unexplained: number;
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

/**
 * One branch's stock movement TOTALLED over a window — the row behind
 * Admin → Branch Stock with "All branches" selected.
 *
 * The same six figures as `BranchStockHistoryRow`, folded the other way: that
 * type slices ONE branch by day, this one slices ALL branches by branch. Both
 * are derived by the same function, so the two views can never disagree about
 * what a branch did.
 *
 * The window telescopes rather than sums:
 *   - `opening` is the balance at the START of the window (the oldest day's
 *     opening), NOT a sum of daily openings — adding those would count the same
 *     stock once per day.
 *   - `new` / `sold` / `returned` / `adjustment` ARE sums, since each counts
 *     movements that happened on their day.
 *   - `balance` is the live balance today.
 * So `opening + new − sold − returned + adjustment = balance` holds across the
 * whole window exactly as it does on a single day.
 *
 * Amounts carry the same caveat as the per-day rows: every quantity is valued at
 * the product's CURRENT price, so `soldAmount` is stock valued at today's price
 * list, not the money actually taken.
 */
export interface BranchStockSummaryRow {
  branchId: string;
  branchName: string;
  /** Balance at the start of the window — see the note above on telescoping. */
  openingQty: number;
  openingAmount: number;
  newQty: number;
  newAmount: number;
  soldQty: number;
  soldAmount: number;
  returnedQty: number;
  returnedAmount: number;
  /** Signed, so the window reconciles. */
  adjustmentQty: number;
  adjustmentAmount: number;
  /** Live balance today. */
  balanceQty: number;
  balanceAmount: number;
  /**
   * The first business date this branch's figures actually cover. Normally the
   * requested window's start, but a branch whose ledger hit the read cap gets a
   * shorter one — reported per branch because the cap bites per branch.
   */
  from: string;
  capped: boolean;
}

/** The "All branches" response. `from` is the widest window every row shares. */
export interface BranchStockSummaryResult {
  from: string;
  to: string;
  rows: BranchStockSummaryRow[];
  /** True if ANY branch's ledger was capped — at least one row is short. */
  capped: boolean;
}
