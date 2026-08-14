import { z } from 'zod';
import { requiredAttachmentIds } from './attachment.schemas';

export const ProductionOrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  remarks: z.string().max(500).default(''),
});

/**
 * An optional packing-material line on the same demand. Quantity must be > 0 —
 * a zero-quantity request is just a row the branch forgot to remove.
 */
export const ProductionOrderPackingItemSchema = z.object({
  packingMaterialId: z.string().min(1, 'Packing material is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

// branchId is derived from the auth token server-side, never trusted from the client.
export const CreateProductionOrderSchema = z
  .object({
    items: z.array(ProductionOrderItemSchema).min(1, 'At least one item is required'),
    // Optional by design: most demands are products only, and an absent key must
    // behave exactly like the pre-packing-material payload.
    packingItems: z.array(ProductionOrderPackingItemSchema).default([]),
    /**
     * Photo the branch captures when raising the demand — the shelf, the empty
     * crate, whatever justifies the quantities being asked for. Required: it is
     * what Production looks at when a demand's numbers seem wrong.
     *
     * NOTE this is a breaking change to the endpoint's contract. The web app is
     * a static-export PWA, so a tab still running the previous bundle will send
     * no attachmentIds and get a 400 until it reloads. That is deliberate — the
     * alternative is a grace period during which the photo is silently optional,
     * which is indistinguishable from the feature not working.
     */
    attachmentIds: requiredAttachmentIds,
  })
  .superRefine((val, ctx) => {
    // One material, one quantity — a duplicate row is meaningless and would also
    // violate the unique constraint in migration 39. Caught here so the user gets a
    // field error instead of a database error.
    const seen = new Set<string>();
    val.packingItems.forEach((item, i) => {
      if (seen.has(item.packingMaterialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packingItems', i, 'packingMaterialId'],
          message: 'This packing material is already on the demand',
        });
      }
      seen.add(item.packingMaterialId);
    });
  });

// Per-item approved quantity override, supplied when Production adjusts a demand
// before approving. Omitted items keep their requested quantity.
export const ApprovedItemSchema = z.object({
  productId: z.string().min(1),
  approvedQty: z.number().int().nonnegative('Approved quantity cannot be negative'),
});

/** Packing-material equivalent of ApprovedItemSchema. */
export const ApprovedPackingItemSchema = z.object({
  packingMaterialId: z.string().min(1),
  approvedQty: z.number().int().nonnegative('Approved quantity cannot be negative'),
});

// 'awaiting_verification' replaces the old 'approved' outcome here: Production's
// review still transfers stock immediately (unchanged), but the order only
// becomes 'approved' once the branch verifies what physically arrived.
//
// 'approved' is still ACCEPTED as a legacy alias and normalised to
// 'awaiting_verification' by the route. The web app is a static-export PWA, so a
// client that loaded the old bundle keeps sending 'approved' until it reloads —
// rejecting it here would 400 those users for as long as their tab stays open.
export const ReviewProductionOrderSchema = z.object({
  status: z.enum(['awaiting_verification', 'approved', 'rejected']),
  // Only meaningful when status is 'awaiting_verification' (or its 'approved' alias).
  approvedItems: z.array(ApprovedItemSchema).optional(),
  approvedPackingItems: z.array(ApprovedPackingItemSchema).optional(),
  reason: z.string().max(500).optional(),
});

/** Production adding an extra line to a still-'pending' order before submitting it. */
export const AddProductionOrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  remarks: z.string().max(500).default(''),
});

// Per-item quantity the branch confirms it physically received, correcting for
// any shortage/overage against what Production recorded. Omitted items keep
// their approved quantity unchanged.
export const VerifiedItemSchema = z.object({
  productId: z.string().min(1),
  verifiedQty: z.number().nonnegative('Verified quantity cannot be negative'),
});

/** An item the branch found on arrival that wasn't on the original demand. */
export const NewVerifiedItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().positive('Quantity must be at least 1'),
});

export const VerifyProductionOrderSchema = z.object({
  verifiedItems: z.array(VerifiedItemSchema).default([]),
  newItems: z.array(NewVerifiedItemSchema).default([]),
  /**
   * Photo of what physically arrived, captured at the moment of counting.
   *
   * Verification is the step that MOVES STOCK (see the note on
   * BranchProductionOrderStatus), and it is the branch's own count that decides
   * how much. The photo is the only independent record Production gets of a
   * delivery it can no longer inspect — which is why this is required rather
   * than encouraged.
   */
  attachmentIds: requiredAttachmentIds,
});

export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderSchema>;
export type ReviewProductionOrderInput = z.infer<typeof ReviewProductionOrderSchema>;
export type AddProductionOrderItemInput = z.infer<typeof AddProductionOrderItemSchema>;
export type VerifyProductionOrderInput = z.infer<typeof VerifyProductionOrderSchema>;
