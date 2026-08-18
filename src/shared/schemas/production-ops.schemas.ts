import { z } from 'zod';
import { optionalBusinessDate } from './business-date.schemas';

// ── Today's Prepared Products ────────────────────────────────────────────────
export const PrepareProductionItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

export const PrepareProductionSchema = z.object({
  items: z.array(PrepareProductionItemSchema).min(1, 'At least one product is required'),
});

// ── Product Returns (recorded by Production) ─────────────────────────────────
// branchId + productId identify what came back; names are resolved server-side.
export const CreateProductionReturnSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().min(1, 'Reason is required').max(500),
});

export const ReviewProductionReturnSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
});

// ── Branch-initiated Returns (from the branch Stock page) ────────────────────
// The branch returns unsold/damaged stock straight to production. branchId is
// derived server-side from the caller; reason is optional here (the Production
// flow above requires it). Applied immediately, no review step.
//
// One submission carries MANY products — a branch closing out an evening hands
// back everything unsold at once. `reason` is shared across the whole return
// (an end-of-day batch has one reason) and is copied onto each product's record.
export const BranchReturnItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

export const CreateBranchReturnSchema = z.object({
  items: z
    .array(BranchReturnItemSchema)
    .min(1, 'Add at least one product to return')
    .superRefine((items, ctx) => {
      // One row per product, and this is a correctness guard rather than tidiness:
      // the balance check is per row, so two rows for the same product each pass
      // on their own but overdraw together — "Vanilla Cake 5" twice against a
      // balance of 6 takes 10. This is the only input that can drive a branch
      // negative through rows that are each individually valid.
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it.productId)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'productId'],
            message: 'This product is already on the return',
          });
        }
        seen.add(it.productId);
      });
    }),
  reason: z.string().max(500).optional().default(''),
  // Sent by the mobile app only; see business-date.schemas.ts.
  businessDate: optionalBusinessDate,
});

export type PrepareProductionInput = z.infer<typeof PrepareProductionSchema>;
export type CreateProductionReturnInput = z.infer<typeof CreateProductionReturnSchema>;
export type ReviewProductionReturnInput = z.infer<typeof ReviewProductionReturnSchema>;
export type CreateBranchReturnInput = z.infer<typeof CreateBranchReturnSchema>;
