import { z } from 'zod';
import { optionalAttachmentIds, requiredAttachmentIds } from './attachment.schemas';
import { optionalBusinessDate } from './business-date.schemas';
import { dateOnly } from './production-order.schemas';

/**
 * Special Orders — a one-off a branch needs made (a named cake, a custom
 * decoration), raised as its OWN document and sent straight to Production.
 *
 * It is not a demand and never becomes one (migration 143): it has its own
 * tables, its own SO-###### number and its own endpoint, and the demand schema
 * refuses special items outright.
 */

/**
 * One row of a Special Order.
 *
 * `amount` is THE AGREED AMOUNT FOR THE WHOLE ROW, typed by the branch at the
 * moment it raises the order. It is not a unit rate — nothing multiplies it by
 * `qty` — it does not come from the price list, and it has no bearing on stock:
 * a row of qty 3 / amount 1500 moves 3 units and is worth 1500.
 *
 * Required, and 0 is a legitimate value (a replacement made free of charge), so
 * the check is "a number was entered", never "is truthy".
 */
export const SpecialOrderLineSchema = z.object({
  name: z.string().trim().min(1, 'Please enter the item name.').max(120, 'Item name is too long'),
  qty: z
    .number({ required_error: 'Please enter quantity.', invalid_type_error: 'Please enter quantity.' })
    .int('Quantity must be a whole number')
    .positive('Please enter quantity.'),
  amount: z
    .number({
      required_error: 'Please enter the Special Order amount.',
      invalid_type_error: 'Please enter the Special Order amount.',
    })
    .finite('Please enter the Special Order amount.')
    .nonnegative('The Special Order amount cannot be negative.')
    .max(99_999_999, 'The Special Order amount is too large')
    // Two decimals at most — the column is numeric(14,2), and silently rounding
    // would store an amount other than the one that was agreed.
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'Enter the amount to at most 2 decimal places'),
  description: z.string().trim().max(500, 'Description is too long').default(''),
  /** The optional REQUEST photo — "this is the cake I mean". */
  attachmentIds: optionalAttachmentIds,
});

// branchId is derived from the auth token server-side, never trusted from the client.
export const CreateSpecialOrderSchema = z.object({
  items: z.array(SpecialOrderLineSchema).min(1, 'Add at least one Special Order item').max(50),
  /** The day the branch needs it by. Optional: not every client asks. */
  requiredDate: dateOnly.optional(),
  /** The day it was RAISED, as captured on the device — see business-date.schemas.ts. */
  businessDate: optionalBusinessDate,
});

/**
 * The branch verifying a prepared Special Order.
 *
 * The photo is REQUIRED — it is the proof of the finished item, and an order
 * cannot be approved (and so cannot reach stock) without it. It is stored under
 * its own attachment entity, separate from the request photo.
 */
export const VerifySpecialOrderSchema = z.object({
  attachmentIds: requiredAttachmentIds,
});

export type SpecialOrderLineInput = z.infer<typeof SpecialOrderLineSchema>;
export type CreateSpecialOrderInput = z.infer<typeof CreateSpecialOrderSchema>;
export type VerifySpecialOrderInput = z.infer<typeof VerifySpecialOrderSchema>;
