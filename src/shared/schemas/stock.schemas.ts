import { z } from 'zod';
import { optionalBusinessDate } from './business-date.schemas';

/**
 * Admin → Branch Stock: direct control over a branch's stock ledger.
 *
 * Every figure here is an ABSOLUTE target, never a delta — the admin types the
 * numbers as they should read and the server sizes the compensating movements
 * against the LIVE ledger under a row lock (`apply_stock_correction`, migrations
 * 33 / 78 / 79 / 80). That is what makes a resubmit a true no-op and what stops a
 * page left open for an hour from clobbering a sale that landed in the meantime.
 *
 * It is the same correction engine the Support Center's "Change figures" uses.
 * The difference is only who reaches it: there it hangs off a support ticket, here
 * off an admin screen with no ticket, so the ref_id prefix is `admin:<uid>` rather
 * than the ticket id. Nothing about the arithmetic or the guards changes.
 */

/** A count. Whole and non-negative — Opening/New/Sold/Returned/Balance are tallies. */
const count = z
  .number({ invalid_type_error: 'Enter a number' })
  .int('Enter a whole number')
  .min(0, 'Cannot be negative');

/** The figure keys an admin may target, in the order the Stock table shows them. */
export const ADMIN_STOCK_FIGURES = ['opening', 'newQty', 'sold', 'returned', 'adjustment', 'balance'] as const;
export type AdminStockFigure = (typeof ADMIN_STOCK_FIGURES)[number];

/** Human labels for the figures, for error messages on both sides of the wire. */
export const ADMIN_STOCK_FIGURE_LABELS: Record<AdminStockFigure, string> = {
  opening: 'Opening Stock',
  newQty: 'New Stock',
  sold: 'Sold',
  returned: 'Returned',
  adjustment: 'Adjustment',
  balance: 'Balance',
};

/**
 * One product's target figures.
 *
 * `adjustment` is the only SIGNED one: a correction can take stock away as well
 * as add it, and `0` is how an existing one is cleared.
 *
 * `balance` and `adjustment` are the same degree of freedom seen from two ends —
 * adjustment is the residual in `opening + new − sold − returned + adjustment =
 * balance`. Sending both is refused here rather than left to the RPC's
 * `overdetermined` status, so the admin is told before a round trip that writes
 * nothing.
 */
export const AdminStockRowSchema = z
  .object({
    productId: z.string().uuid('Choose a product'),
    opening: count.optional(),
    newQty: count.optional(),
    sold: count.optional(),
    returned: count.optional(),
    adjustment: z.number({ invalid_type_error: 'Enter a number' }).int('Enter a whole number').optional(),
    balance: count.optional(),
  })
  .refine((r) => r.balance === undefined || r.adjustment === undefined, {
    message: 'Set either Balance or Adjustment, not both — each one determines the other.',
    path: ['balance'],
  })
  .refine((r) => ADMIN_STOCK_FIGURES.some((k) => r[k] !== undefined), {
    message: 'Enter at least one figure to save.',
    path: ['balance'],
  });

export type AdminStockRowInput = z.infer<typeof AdminStockRowSchema>;

/**
 * A save from the Admin → Branch Stock page. Many products in one submission,
 * because an admin reconciling a day edits a column, not a cell.
 *
 * NOT all-or-nothing, for the same reason `POST /api/stock/return` is not: the
 * correction RPC is per-product and PostgREST gives each call its own transaction.
 * The response names every row that saved and every row that did not, rather than
 * pretending a partial save was total.
 */
export const AdminStockSaveSchema = z.object({
  branchId: z.string().uuid('Choose a branch'),
  /** The business day being corrected. Defaults to today (Karachi) server-side. */
  date: optionalBusinessDate,
  /** Free-text why, kept on the notification sent to the branch. */
  reason: z.string().trim().max(300).optional().default(''),
  rows: z.array(AdminStockRowSchema).min(1, 'Nothing to save').max(300, 'Too many rows in one save'),
});

export type AdminStockSaveInput = z.infer<typeof AdminStockSaveSchema>;

/**
 * Removing a product's stock from a branch. Two very different things share this
 * endpoint because they answer the same question ("get this off the page"):
 *
 * - `zero`  — correct the balance to 0. A normal correction: the ledger keeps
 *             every movement and the row reads 0 from now on. Reversible by
 *             typing the old number back in.
 * - `purge` — DELETE the `stock` row and every `stock_history` row for this
 *             (branch, product). Irreversible, and it rewrites history: figures
 *             derived from the ledger — past daily closings, reports, a sale's
 *             stock movement — lose the rows they were derived from. Offered
 *             because an admin sometimes needs a mis-seeded product genuinely
 *             gone, but it is never the default and the UI confirms by name.
 */
export const AdminStockDeleteSchema = z.object({
  branchId: z.string().uuid('Choose a branch'),
  productId: z.string().uuid('Choose a product'),
  mode: z.enum(['zero', 'purge']).default('zero'),
  date: optionalBusinessDate,
  reason: z.string().trim().max(300).optional().default(''),
});

export type AdminStockDeleteInput = z.infer<typeof AdminStockDeleteSchema>;
