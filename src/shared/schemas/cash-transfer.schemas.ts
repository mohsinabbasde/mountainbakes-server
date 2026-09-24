import { z } from 'zod';
import { CASH_TRANSFER_METHODS } from '../types/cash-transfer.types';
import { requiredAttachmentIds } from './attachment.schemas';
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

export type CreateCashTransferInput = z.infer<typeof CreateCashTransferSchema>;
export type ApproveCashTransferInput = z.infer<typeof ApproveCashTransferSchema>;
export type RejectCashTransferInput = z.infer<typeof RejectCashTransferSchema>;
