import type { Attachment } from './attachment.types';

// ---------------------------------------------------------------------------
// Cash transfers — money a branch hands over to the company (migration 118).
//
// A branch records the handover with a photo of the slip; Finance approves it,
// and the approval posts ONE RV- receipt to the Daily Ledger in the same
// transaction. The transfer is its own transaction: it never adds to or
// subtracts from a sale, a demand, a discount or a previous balance. The
// production slip SUMS approved transfers as "Payment Received" and shows the
// figure beside the existing ones (previous-balance.service.ts).
// ---------------------------------------------------------------------------

/**
 * The three ways a branch can hand money over. The same values the daily sale
 * record lets a branch key by hand (DAILY_SALE_MANUAL_METHODS), and the CHECK
 * on `cash_transfers.payment_method` mirrors this list — change both.
 */
export const CASH_TRANSFER_METHODS = ['cash', 'easypaisa', 'bank_account'] as const;
export type CashTransferMethod = (typeof CASH_TRANSFER_METHODS)[number];

export const CASH_TRANSFER_METHOD_LABELS: Record<CashTransferMethod, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank_account: 'Bank',
};

/**
 * pending  — waiting on Finance. The branch cannot edit it; a wrong figure is
 *            rejected and raised again under a fresh photo.
 * approved — booked; `voucherNo` / `ledgerEntryId` are set. Final.
 * rejected — refused with a reason. The record and photo stay. Final.
 */
export const CASH_TRANSFER_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CashTransferStatus = (typeof CASH_TRANSFER_STATUSES)[number];

export const CASH_TRANSFER_STATUS_LABELS: Record<CashTransferStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface CashTransfer {
  id: string;
  /** CT-000001 … issued at insert, before Finance has seen it. */
  transferNo: string;
  branchId: string;
  branchName: string;
  amount: number;
  paymentMethod: CashTransferMethod;
  note: string | null;
  /** Business date of the handover (`business_date`), as the API's `date`. */
  date: string;
  status: CashTransferStatus;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Stamped on approve AND reject — `status` says which. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  rejectionReason: string | null;
  /** The RV- receipt this became; null until approved. */
  ledgerEntryId: string | null;
  voucherNo: string | null;
  updatedAt: string;
  /** The handover photo(s). Signed URLs — see Attachment. */
  attachments: Attachment[];
}

export type CashTransferSortKey =
  | 'date'
  | 'createdAt'
  | 'approvedAt'
  | 'transferNo'
  | 'voucherNo'
  | 'branchName'
  | 'amount'
  | 'paymentMethod'
  | 'status';

/**
 * One approved transfer as the production slip lists it under "Payment
 * Received" — the lines the total was built from, itemised server-side so the
 * slip cannot drift from the figure (same reason `discountItems` exists).
 */
export interface PaymentReceivedItem {
  transferId: string;
  transferNo: string;
  voucherNo: string | null;
  date: string;
  paymentMethod: CashTransferMethod;
  amount: number;
}
