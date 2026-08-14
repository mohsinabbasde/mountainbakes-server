import type { BranchProductionOrderPackingItem } from './packing-material.types';
import type { Attachment } from './attachment.types';

// Named "Branch…" to avoid colliding with production.types.ts `ProductionOrder`
// (the production-queue view of a customer order). This is the branch's daily
// production *request* (collection `production_orders`).
//
// Four live states, in order:
//   pending               branch submitted, Production has not reviewed
//   awaiting_verification Production sent it out — NO stock has moved yet
//   verified              branch counted what arrived — STOCK MOVES AT THIS STEP
//   approved              Production's final sign-off; status only
//
// Stock deliberately moves on verification rather than on Production's step, so
// the pool is debited once for the quantity actually counted and branch stock
// never claims goods nobody has confirmed receiving.
export type BranchProductionOrderStatus =
  | 'pending'
  | 'awaiting_verification'
  | 'verified'
  | 'approved'
  | 'rejected';

export interface BranchProductionOrderItem {
  productId: string;
  productName: string;
  qty: number; // requested quantity — the branch's "New Demand" for this order
  remarks: string;
  /**
   * Quantity Production actually approved. Defaults to `totalRequiredQty` on approval
   * (previous balance + new demand); may be lower/higher when Production adjusts.
   */
  approvedQty?: number;
  /**
   * Pending-balance carry-forward fields, frozen onto the item at approval time.
   * Absent on pending orders (computed live in the print preview) and on legacy
   * orders created before this feature — treat missing values as 0.
   */
  previousBalanceQty?: number; // outstanding balance carried in from prior orders
  totalRequiredQty?: number; // previousBalanceQty + qty (New Demand)
  remainingBalanceQty?: number; // max(0, totalRequiredQty - approvedQty) — carried forward
  /**
   * This line came from the Special Order Items section, not the product list.
   *
   * It is still an ordinary line in every mechanical sense — it has a real
   * product behind it (a hidden `is_special` one, created on submit) and moves
   * stock exactly like any other. The flag is what lets the screens group it
   * under its own heading and label it. Absent on every demand raised before
   * migration 69; read as `?? false`.
   */
  isSpecial?: boolean;
  /**
   * What the branch typed in the Description box. Stored in `remarks`, which is
   * where it is read from — this alias exists only so a screen rendering a
   * special item does not have to know that.
   */
  description?: string;
  /** The optional photo captured with a special item. Empty on everything else. */
  photos?: Attachment[];
}

export interface BranchProductionOrder {
  id: string;
  demandNumber: string; // human-readable DMD-######
  branchId: string;
  branchName: string;
  date: string; // 'YYYY-MM-DD' (Karachi)
  time: string; // 'HH:mm' (Karachi)
  items: BranchProductionOrderItem[];
  /**
   * Optional packing materials requested with this demand. Empty on most orders and
   * on every order created before the packing-material module — always read it as
   * `?? []` rather than assuming presence.
   */
  packingItems?: BranchProductionOrderPackingItem[];
  status: BranchProductionOrderStatus;
  /** True when any approved quantity differed from the requested quantity. Powers the "Changed Orders" metric. */
  wasChanged?: boolean;
  /** Optional reason Production recorded when adjusting quantities. */
  changeReason?: string | null;
  createdBy: string;
  createdByName: string;
  submittedAt: string; // ISO UTC
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** Set once the production slip has been printed. Idempotent — printing never mutates stock. */
  printed?: boolean;
  printedAt?: string | null; // ISO UTC
  /** Set when the branch verifies a demand that's 'awaiting_verification', moving it to 'approved'. */
  verifiedBy?: string | null;
  verifiedByName?: string | null;
  verifiedAt?: string | null;
  /**
   * Photos the branch captured when RAISING the demand — what it is asking for
   * and why. Absent on demands created before this feature; read as `?? []`.
   */
  demandPhotos?: Attachment[];
  /**
   * Photos the branch captured when VERIFYING what arrived. This is the set
   * Production reviews before final approval, and the only independent record of
   * a delivery that has already been unpacked. Empty until verification.
   */
  verificationPhotos?: Attachment[];
}

/**
 * Per-(branch, product) outstanding demand that Production has not yet fulfilled.
 * Keyed by (branchId, productId). `pendingQty` is an absolute
 * running balance: each approval SETS it to that order's remaining balance
 * (overwrite, never increment — `totalRequiredQty` already folds the prior balance in).
 */
export interface ProductionBalanceDoc {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  pendingQty: number;
  updatedAt: string; // ISO UTC
}
