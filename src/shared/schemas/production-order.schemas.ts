import { z } from 'zod';

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

export const ReviewProductionOrderSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  // Only meaningful when status === 'approved'.
  approvedItems: z.array(ApprovedItemSchema).optional(),
  approvedPackingItems: z.array(ApprovedPackingItemSchema).optional(),
  reason: z.string().max(500).optional(),
});

export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderSchema>;
export type ReviewProductionOrderInput = z.infer<typeof ReviewProductionOrderSchema>;
