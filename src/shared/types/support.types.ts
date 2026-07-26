// Support tickets — the Help Desk (branches / production) → Support Center (admin)
// query queue. A ticket is always raised against ONE reference ID (a sale
// MB-######, an expense EXP-######, or a product's stock STK-######); the
// reference's figures are snapshotted onto the ticket at submit time so the
// admin sees exactly what the raiser saw.

import type { PaymentMethod } from './order.types';
import type { StockFigures } from './stock.types';

// 'system' is not raised by a human against a lookupable ID — it is opened
// automatically when an unattended job fails (e.g. the 2 AM closing summary could
// not be generated or delivered). Such a ticket has no editable reference, so its
// referenceSnapshot is null and the failure detail lives in `message`.
export type SupportReferenceType = 'sale' | 'expense' | 'stock' | 'system';
export type SupportTicketStatus = 'open' | 'resolved' | 'rejected';

/** One key/value line of the auto-shown reference detail. */
export interface SupportDetailField {
  label: string;
  value: string;
}

/** A field the admin may directly correct on the underlying record. */
export interface SupportEditableField {
  key: string;
  label: string;
  kind: 'number' | 'text';
  value: string | number;
}

/**
 * One editable line of a sale (order_items row). Carried on a sale reference so
 * the Support Center can change the product, qty, or unit price of each line and
 * apply it live via edit_sale_items. `discount` is carried through unchanged (not
 * exposed in the editor); `unitPrice` is the "amount" the admin edits per unit.
 */
export interface SupportSaleItem {
  productId: string | null;
  productName: string;
  categoryId: string | null;
  categoryName: string | null;
  unitPrice: number;
  qty: number;
  discount: number;
}

/**
 * The resolved detail for a reference ID. Rendered auto-adjusted in both the
 * Help Desk (before submit) and the Support Center (on the ticket), and stored
 * on the ticket as `referenceSnapshot`.
 */
export interface SupportReference {
  type: SupportReferenceType;
  referenceId: string;
  /** Human summary line, e.g. "Sale MB-000125 — Ali Raza · Rs.1,250". */
  title: string;
  fields: SupportDetailField[];
  /**
   * Directly editable fields, applied live by PATCH /api/support/:id/figures.
   * Expenses expose `amount` / `description`. A branch-scoped stock reference
   * exposes `newQty` / `sold` / `returned` / `balance` — ABSOLUTE targets, from
   * which the server sizes a compensating movement per figure. (`opening` is
   * deliberately absent: it is the previous day's closing.) Empty means "nothing
   * here can be written directly", and the correction is only recorded.
   */
  editableFields: SupportEditableField[];
  /**
   * For sale references: the current line items, editable in the Support Center
   * and applied live (product / qty / unit price) via edit_sale_items.
   */
  saleItems?: SupportSaleItem[];
  /**
   * For sale references: the order's payment method at snapshot time. The Support
   * Center can change it alongside the line items — a wrong tender (cash booked as
   * Easypaisa, say) is the other half of "this sale is recorded wrong", and it moves
   * the day's payment-method totals without touching stock or the grand total.
   */
  paymentMethod?: PaymentMethod;
  /** Internal uuid of the underlying row, used when applying a figure edit. */
  entityId: string;
  /** For expenses: which table the row lives in, so the figure edit hits the right one. */
  entityTable?: string;
  /**
   * For stock references: whose ledger the figures describe. A stock correction has
   * to land on exactly one branch, and this is it — the raiser's branch, or the
   * branch an admin scoped the lookup to. Null when the reference is an
   * all-branches total, which is not correctable.
   */
  branchId?: string | null;
  /** For stock references: the business date the figures were computed for. */
  businessDate?: string;
  /**
   * For branch-scoped stock references: the branch's live derived figures, so the
   * Support Center can show the whole row and recompute the implied balance as the
   * admin edits. Absent on an all-branches (uncorrectable) stock reference.
   */
  stockFigures?: StockFigures;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  referenceType: SupportReferenceType;
  referenceId: string;
  referenceSnapshot: SupportReference | null;
  message: string;
  status: SupportTicketStatus;
  resolutionNote: string | null;
  branchId: string | null;
  branchName: string | null;
  raisedBy: string | null;
  raisedByName: string | null;
  raisedByRole: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
