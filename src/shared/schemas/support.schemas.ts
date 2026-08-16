import { z } from 'zod';
import { PAYMENT_METHOD_VALUES } from './order.schemas';

/** Help Desk → raise a query against a reference ID with an issue message. */
export const CreateSupportTicketSchema = z.object({
  referenceId: z.string().trim().min(1, 'Reference ID is required').max(40),
  message: z.string().trim().min(3, 'Please describe the issue').max(2000),
});
export type CreateSupportTicketInput = z.infer<typeof CreateSupportTicketSchema>;

/** Support Center → admin edits the ticket text (message and/or internal note). */
export const EditSupportTicketSchema = z.object({
  message: z.string().trim().min(3).max(2000).optional(),
  resolutionNote: z.string().trim().max(2000).optional(),
});
export type EditSupportTicketInput = z.infer<typeof EditSupportTicketSchema>;

/** Support Center → admin resolves or rejects the query. */
export const ResolveSupportTicketSchema = z.object({
  status: z.enum(['resolved', 'rejected']),
  resolutionNote: z.string().trim().max(2000).optional().default(''),
});
export type ResolveSupportTicketInput = z.infer<typeof ResolveSupportTicketSchema>;

/**
 * Support Center → admin "Change figures". `edits` maps an editable field key to
 * its new value. Applied as a live mutation for expenses (amount / description) and
 * for a branch's stock figures (`newQty` / `sold` / `returned` / `balance`), which
 * are ABSOLUTE targets: the server sizes a compensating movement per figure against
 * the live ledger. Sales are corrected through the richer /sale-items editor, which
 * moves order totals, customer spend and tender along with stock. Anything with no
 * editable field is recorded on the ticket for manual follow-up.
 */
export const ChangeFiguresSchema = z.object({
  edits: z.record(z.string(), z.union([z.string(), z.number()])),
  note: z.string().trim().max(2000).optional().default(''),
});
export type ChangeFiguresInput = z.infer<typeof ChangeFiguresSchema>;

/**
 * Support Center → admin edits a sale's line items (change product / qty / unit
 * price, add or remove a line). Applied live and atomically via edit_sale_items:
 * order_items are replaced, order totals recomputed, and stock reconciled with a
 * compensating movement. `unitPrice` is the per-unit "amount" the admin sets.
 */
export const SaleItemEditSchema = z.object({
  productId: z.string().uuid().nullable(),
  productName: z.string().trim().min(1, 'Product is required').max(200),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().max(200).nullable().optional(),
  unitPrice: z.number().nonnegative('Amount cannot be negative'),
  qty: z.number().positive('Quantity must be greater than 0'),
  discount: z.number().min(0).optional().default(0),
});
export type SaleItemEditInput = z.infer<typeof SaleItemEditSchema>;

/**
 * Support Center → admin edits a demand's product lines (change requested /
 * approved qty, add or remove a product). Applied live via
 * correct_production_order (migration 77), which rewrites the lines and returns
 * the per-product change in APPROVED quantity; the route then reconciles branch
 * stock and the production pool, but only for an order that already delivered.
 *
 * `qty` is what the branch asked for and may be 0 on a line Production added.
 * `approvedQty` is what Production granted — the figure that moves stock — so it
 * is the one a correction reconciles against.
 */
export const DemandItemEditSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string().trim().min(1, 'Product is required').max(200),
  qty: z.number().min(0, 'Requested quantity cannot be negative'),
  approvedQty: z.number().min(0, 'Approved quantity cannot be negative'),
});
export type DemandItemEditInput = z.infer<typeof DemandItemEditSchema>;

export const EditDemandItemsSchema = z.object({
  items: z.array(DemandItemEditSchema).min(1, 'A demand must have at least one product'),
  reason: z.string().trim().max(500).optional().default(''),
  note: z.string().trim().max(2000).optional().default(''),
});
export type EditDemandItemsInput = z.infer<typeof EditDemandItemsSchema>;

export const EditSaleItemsSchema = z.object({
  items: z.array(SaleItemEditSchema).min(1, 'A sale must have at least one item'),
  /**
   * Optional new tender for the sale. Omitted means "leave it alone"; the route
   * only writes it when it actually differs from what the order carries, so a
   * resubmit of an unchanged value is a no-op rather than a phantom correction.
   */
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES).optional(),
  note: z.string().trim().max(2000).optional().default(''),
});
export type EditSaleItemsInput = z.infer<typeof EditSaleItemsSchema>;
