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

// The three decisions Production can take on a pending return. 'returned' hands
// the paperwork back to the branch to correct and is NOT terminal — it moves no
// stock and the branch resubmits from it. It is only valid on a branch-raised
// return; the route refuses it on a Production-recorded one, where there is no
// branch record to hand back.
export const ReviewProductionReturnSchema = z.object({
  status: z.enum(['accepted', 'rejected', 'returned']),
});

// ── Branch-initiated Returns (from the branch Stock page) ────────────────────
// The branch returns unsold/damaged stock straight to production. branchId is
// derived server-side from the caller; reason is optional here (the Production
// flow above requires it).
//
// REVIEWED, NOT AUTO-APPROVED. This used to insert already 'accepted' with both
// stock movements applied before the response was written. It now inserts
// 'pending': the units come off the branch balance immediately (they have
// physically left the shop) but the central pool is credited only when
// Production approves.
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

// ── Correcting a branch-initiated return (Branch → Return Stock) ─────────────
// Only valid while the return is still open — 'pending' or 'returned'. Once
// Production has accepted or rejected it the record is final and the server
// refuses this with a 409; the client hides the button for the same reason.
//
// Even open, this is NOT a draft edit: the branch half of the movement has
// already happened (the units came off the balance as the return was saved), so
// this is a request to move the DIFFERENCE. `qty` is the return's new total, not
// a delta — the client shows the figure that is on the record and the server
// works out which way stock has to go, which is the only reading that stays
// right if two corrections race.
//
// `reason` is optional and, unlike the Production-recorded flow, may be blank —
// it mirrors CreateBranchReturnSchema above, where an end-of-day batch carries
// one shared reason and often none at all.
export const ReviseBranchReturnSchema = z.object({
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().max(500).optional(),
});

export type PrepareProductionInput = z.infer<typeof PrepareProductionSchema>;
export type CreateProductionReturnInput = z.infer<typeof CreateProductionReturnSchema>;
export type ReviewProductionReturnInput = z.infer<typeof ReviewProductionReturnSchema>;
export type CreateBranchReturnInput = z.infer<typeof CreateBranchReturnSchema>;
export type ReviseBranchReturnInput = z.infer<typeof ReviseBranchReturnSchema>;
