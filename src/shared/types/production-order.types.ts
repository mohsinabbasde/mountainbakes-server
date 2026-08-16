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
//
// Two terminal states sit outside that line:
//   rejected  Production refused it
//   cancelled the BRANCH withdrew it, before Production reviewed (migration 73)
//
// They are kept apart deliberately — only one of them is a fulfilment failure.
export type BranchProductionOrderStatus =
  | 'pending'
  | 'awaiting_verification'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface BranchProductionOrderItem {
  productId: string;
  productName: string;
  qty: number; // the branch's demand for this order — the whole requirement
  remarks: string;
  /**
   * Quantity Production actually approved. Defaults to `qty` — the fresh demand —
   * and is lower when Production reduces a line, higher when it raises one.
   */
  approvedQty?: number;
  /**
   * Pending-balance carry-forward fields, frozen onto the item at approval time.
   *
   * DEAD as of server migration 74, which removed the carry-forward entirely: a
   * demand is now the fresh demand alone. New rows are written with
   * previousBalanceQty = 0, totalRequiredQty = qty and remainingBalanceQty = 0,
   * and nothing computes with them.
   *
   * They stay readable because orders approved BEFORE that migration genuinely
   * were approved against previous balance + new demand, and these stored figures
   * are the only record of what was decided on the day. Absent on pending orders
   * and on legacy orders predating the feature — treat missing values as 0.
   *
   * Do NOT reintroduce them into any calculation: adding previousBalanceQty back
   * into a demand is precisely the bug migration 74 fixed.
   */
  previousBalanceQty?: number; // historical only — balance carried in from prior orders
  totalRequiredQty?: number; // historical: previousBalanceQty + qty. Now always qty.
  remainingBalanceQty?: number; // historical: the shortfall carried on. Now always 0.
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
  /**
   * This line was added by Production before review, or found in the delivery
   * at verification — the branch never demanded it (migration 83).
   *
   * `qty` on such a line still carries the intended quantity and is still what
   * the approval defaults to, so this does NOT change what ships. It exists so
   * the screens stop reporting that quantity as branch demand: a demand column
   * showing Production's own figure made every added line read as though the
   * branch had asked for exactly what was sent, and inflated the demand total
   * by goods nobody requested.
   *
   * Absent on lines predating the flag — read as `?? false`. Lines added by
   * Production before migration 83 carry no marker and are indistinguishable
   * from genuine branch demand; they read as demand, as they always have.
   */
  addedByProduction?: boolean;
}

export interface BranchProductionOrder {
  id: string;
  demandNumber: string; // human-readable DMD-######
  branchId: string;
  branchName: string;
  date: string; // 'YYYY-MM-DD' (Karachi) — the day the demand was RAISED
  time: string; // 'HH:mm' (Karachi)
  /**
   * 'YYYY-MM-DD' — the day the branch needs this delivered BY, chosen on the
   * order form. Required on every demand raised since the field was added
   * (migration 81) and absent on every one raised before it, which is why it is
   * optional here; render a missing value as '—' rather than falling back to
   * `date`, which would show a delivery commitment that was never made.
   */
  requiredDate?: string | null;
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
   * Why the branch deleted this demand. Present only on a 'cancelled' order, and
   * mandatory there — the whole point of the soft delete is that Production can
   * see what was withdrawn and why, rather than a demand quietly vanishing off
   * the summary it was planning against.
   */
  cancelReason?: string | null;
  cancelledBy?: string | null;
  cancelledByName?: string | null;
  cancelledAt?: string | null; // ISO UTC
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
