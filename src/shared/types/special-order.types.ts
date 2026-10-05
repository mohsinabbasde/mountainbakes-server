import type { Attachment } from './attachment.types';

/**
 * A Special Order's status. These are values of the existing
 * `branch_production_order_status` enum — the same one demands use, not a
 * second status system — read with Special Order meanings:
 *
 *   pending               sent to Production, waiting for preparation
 *   awaiting_verification Production prepared it — it is in PRODUCTION STOCK and
 *                         waiting for the branch
 *   approved              the branch verified & approved it with its photo — it
 *                         is in BRANCH STOCK and can be sold
 *
 * `verified` is no longer produced. It survives only on orders verified before
 * migration 145, which still wait on Production's approval to move their stock.
 *
 * One stock addition per location: Production Stock at preparation, Branch Stock
 * at verification. Nobody enters either by hand.
 */
export type SpecialOrderStatus = 'pending' | 'awaiting_verification' | 'verified' | 'approved';

export const SPECIAL_ORDER_STATUS_LABELS: Record<SpecialOrderStatus, string> = {
  pending: 'Waiting for Preparation',
  awaiting_verification: 'Prepared — Waiting for Branch Verification',
  verified: 'Branch Verified — Waiting for Approval',
  approved: 'Verified & Approved — In Branch Stock',
};

export interface SpecialOrderItem {
  id: string;
  itemName: string;
  /** REQUESTED quantity — what the branch asked for. Never overwritten. */
  qty: number;
  /** PREPARED quantity — what Production made and booked into Production Stock. Null until prepared. */
  preparedQty: number | null;
  /** VERIFIED quantity — what the branch received and booked into its own stock. Null until verified. */
  verifiedQty: number | null;
  /** The agreed amount for the WHOLE ROW. Not a unit rate; never used for stock. */
  amount: number;
  description: string;
  lineNo: number;
  /** The hidden product that carries this one line in stock and at the till. */
  productId: string;
  /** The photo(s) the order was raised with. Never replaced by the verification photo. */
  requestPhotos: Attachment[];
  /** The Production Stock addition this item produced (its 'prepare' movement). Null until prepared. */
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
