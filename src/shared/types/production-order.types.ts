import type { BranchProductionOrderPackingItem } from './packing-material.types';

// Named "Branch…" to avoid colliding with production.types.ts `ProductionOrder`
// (the production-queue view of a customer order). This is the branch's daily
// production *request* (collection `production_orders`).
//
// 'awaiting_verification' sits between 'pending' and 'approved': Production's
// review still moves stock into branch inventory immediately (unchanged), but
// the order isn't 'approved' until the branch has physically checked what
// arrived and confirmed it via the verify step — which is what may still
// adjust quantities/add items before the order is finally 'approved'.
export type BranchProductionOrderStatus = 'pending' | 'awaiting_verification' | 'approved' | 'rejected';

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
