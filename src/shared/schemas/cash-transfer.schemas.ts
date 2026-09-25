import { z } from 'zod';
import { CASH_TRANSFER_METHODS } from '../types/cash-transfer.types';
import { FINANCE_QUERY_PRIORITIES } from '../types/finance.types';
import { optionalAttachmentIds, requiredAttachmentIds } from './attachment.schemas';
import { optionalBusinessDate } from './business-date.schemas';

// ── Cash transfers ───────────────────────────────────────────────────────────
//
// `branchId` is NEVER in any schema here: it is derived server-side from the
// caller's JWT, the same rule CreateBranchDiscountSchema follows. Nor are
// `status`, `voucherNo` or any approver field — those are the server's alone.

/** Money, to two decimal places, positive — the discount rule, verbatim. */
const transferAmount = z
  .number()
  .positive('Amount must be more than 0')
  .max(10_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places');

export const CreateCashTransferSchema = z.object({
  amount: transferAmount,
  paymentMethod: z.enum(CASH_TRANSFER_METHODS, { message: 'Pick how the money was sent' }),
  note: z.string().trim().max(500).optional(),
  /**
   * The photo of the slip / handover, uploaded first to POST /api/attachments.
   * Required: a transfer without evidence is a number somebody typed. The
   * message is shown verbatim under the camera button.
   */
  attachmentIds: requiredAttachmentIds,
  // Sent by the mobile app only; see business-date.schemas.ts.
  businessDate: optionalBusinessDate,
});

export const ApproveCashTransferSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const RejectCashTransferSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this transfer is refused').max(500),
});

/**
 * A branch raising a query on one of ITS OWN transfers (Finance Help Desk,
 * branch side). The transfer is named by id and re-read server-side under the
 * caller's branch, so a branch cannot open a query on another shop's CT-. The
 * reference, amount, date and branch on the query all come from that row —
 * none of them is the branch's to type.
 */
export const RaiseCashTransferQuerySchema = z.object({
  transferId: z.string().uuid('Pick the transfer this query is about'),
  subject: z.string().trim().min(3, 'Give the query a short subject').max(200),
  description: z.string().trim().min(3, 'Please describe the problem').max(4000),
  priority: z.enum(FINANCE_QUERY_PRIORITIES).default('normal'),
  attachmentIds: optionalAttachmentIds,
});

export type RaiseCashTransferQueryInput = z.infer<typeof RaiseCashTransferQuerySchema>;
export type CreateCashTransferInput = z.infer<typeof CreateCashTransferSchema>;
export type ApproveCashTransferInput = z.infer<typeof ApproveCashTransferSchema>;
export type RejectCashTransferInput = z.infer<typeof RejectCashTransferSchema>;
