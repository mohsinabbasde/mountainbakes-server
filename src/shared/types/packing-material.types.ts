// Packing materials — company service items (shoppers, boxes, spoons, writing
// cream) supplied alongside a branch's daily production demand.
//
// They are NOT products: no selling price, no cost price, never saleable. They
// live in their own `packing_materials` table for that reason — see migration 38.

/** A catalogue entry. `category` is free text, not a `categories` row. */
export interface PackingMaterial {
  id: string;
  materialCode: string; // PACK-001 …
  materialName: string;
  category: string | null;
  description: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string; // ISO UTC
  updatedAt: string; // ISO UTC
}

/**
 * One packing line on a branch demand.
 *
 * Note what is absent: there are no balance fields. Unlike products, packing
 * materials carry no unmet demand forward — Production approves a quantity and the
 * request ends there (migration 39).
 */
export interface BranchProductionOrderPackingItem {
  packingMaterialId: string;
  materialName: string;
  qty: number; // requested by the branch
  /** Set only on approval. Defaults to `qty` unless Production adjusted it. */
  approvedQty?: number;
}

/**
 * One row of the Daily Packing Material Usage report.
 *
 * `deliveredQty` is derived, not stored: approving a demand is what sends it, so
 * delivered equals approved on approved orders and 0 otherwise.
 */
export interface PackingMaterialUsageRow {
  date: string; // business date, 'YYYY-MM-DD'
  branchId: string;
  branchName: string;
  packingMaterialId: string | null;
  materialName: string;
  requestedQty: number;
  approvedQty: number;
  deliveredQty: number;
}
