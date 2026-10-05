import type { Attachment } from './attachment.types';

/**
 * A Special Order's status. These are four of the existing
 * `branch_production_order_status` values — the same enum demands use, not a
 * second status system — read with Special Order meanings:
 *
 *   pending               sent to Production, waiting for preparation
 *   awaiting_verification Production prepared it; the branch must verify it
 *   verified              the branch verified it, with its photo
 *   approved              approved — and its quantity is in Production Stock
 *
 * No stock moves at any step except the last, and there it moves exactly once.
 */
export type SpecialOrderStatus = 'pending' | 'awaiting_verification' | 'verified' | 'approved';

export const SPECIAL_ORDER_STATUS_LABELS: Record<SpecialOrderStatus, string> = {
  pending: 'Waiting for Preparation',
  awaiting_verification: 'Waiting for Branch Verification',
  verified: 'Branch Verified — Waiting for Approval',
  approved: 'Approved — Stock Added',
};

export interface SpecialOrderItem {
  id: string;
  itemName: string;
  /** The quantity ordered — and exactly the quantity added to Production Stock on approval. */
  qty: number;
  /** The agreed amount for the WHOLE ROW. Not a unit rate; never used for stock. */
  amount: number;
  description: string;
  lineNo: number;
  /** The hidden product that carries this item in Production Stock. */
  productId: string;
  /** The photo(s) the order was raised with. Never replaced by the verification photo. */
  requestPhotos: Attachment[];
  /** The one stock movement this item produced. Null until the order is approved. */
  stockMovementId: string | null;
  /** Its human-readable ledger number (STK-YYYYMMDD-NNNNNN). */
  stockTransactionNo: string | null;
}

export interface SpecialOrder {
  id: string;
  /** SO-###### — also the reference Production works from. */
  orderNumber: string;
  branchId: string;
  branchName: string | null;
  date: string; // 'YYYY-MM-DD' (Karachi) — the day it was raised
  requiredDate: string | null;
  status: SpecialOrderStatus;
  items: SpecialOrderItem[];
  /** Σ of the rows' amounts. */
  totalAmount: number;
  /** The branch's proof of the finished item. Empty until verification. */
  verificationPhotos: Attachment[];
  createdBy: string | null;
  createdByName: string | null;
  submittedAt: string; // ISO UTC
  preparedBy: string | null;
  preparedByName: string | null;
  preparedAt: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  stockAddedAt: string | null;
}
