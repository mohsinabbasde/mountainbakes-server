/**
 * Finance Ledger — the accounts department's own module.
 *
 * This is deliberately a WORLD APART from Branch / Production / Admin: it is the
 * company's book of account, not an operations screen. Two consequences run
 * through every type below.
 *
 *   1. Nothing here is ever edited in place once posted. A mistake is corrected
 *      with a reversing or adjustment entry that leaves the original visible.
 *      That is why `LedgerEntry` has no `updatedAt` and no update payload type.
 *   2. Every amount that reaches the ledger has passed an approval, and the
 *      approval is recorded on the SOURCE document (a FinanceTransaction, a
 *      SalaryPayment, …) rather than on the ledger row. The ledger row is the
 *      consequence; the source document is the decision.
 *
 * Money is `numeric(14,2)` in Postgres and therefore arrives from PostgREST as a
 * STRING. Every service in this module coerces with Number() at the boundary —
 * see the note on `coerceToDefaultType` in settings.service.ts for what happens
 * when that is forgotten.
 */

import type { UserRole } from './user.types';
import type { Attachment } from './attachment.types';

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/**
 * The four finance roles. These are values of the `user_role` Postgres enum
 * (migration 51), NOT a separate claim — so `app.jwt_role()`, RLS, RouteGuard
 * and `requireRole()` all keep working unchanged, and a finance account is
 * provisioned through the same POST /api/users path as every other account.
 */
export type FinanceRole = 'finance_admin' | 'finance_manager' | 'accountant' | 'finance_auditor';

export const FINANCE_ROLES = [
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
] as const satisfies readonly FinanceRole[];

export const FINANCE_ROLE_LABELS: Record<FinanceRole, string> = {
  finance_admin: 'Finance Admin',
  finance_manager: 'Finance Manager',
  accountant: 'Accountant',
  finance_auditor: 'Read Only Auditor',
};

export function isFinanceRole(role: unknown): role is FinanceRole {
  return typeof role === 'string' && (FINANCE_ROLES as readonly string[]).includes(role);
}

/**
 * What a finance user may do, in increasing order of consequence.
 *
 *   view      — read every finance screen and report
 *   create    — raise a draft / submit it for approval
 *   approve   — approve or reject, which is what posts money to the ledger
 *   adjust    — reverse or adjust an ALREADY POSTED entry
 *   configure — ledger heads, share percentages, opening balances, employees
 */
export type FinancePermission = 'view' | 'create' | 'approve' | 'adjust' | 'configure';

const FINANCE_ROLE_PERMISSIONS: Record<FinanceRole, readonly FinancePermission[]> = {
  finance_admin: ['view', 'create', 'approve', 'adjust', 'configure'],
  finance_manager: ['view', 'create', 'approve'],
  accountant: ['view', 'create'],
  // The clue is in the name. An auditor who can write is not an auditor.
  finance_auditor: ['view'],
};

/**
 * Whether `role` may perform `permission`.
 *
 * Super Admin is a special case and reads exactly as the brief specifies: they
 * can VIEW every finance record and report unconditionally, but cannot modify
 * one "unless granted permission" — which is the `allowSuperAdminWrite` toggle
 * in Finance Settings, off by default. Being able to see the books and being
 * able to move money in them are separate grants, and separation of duties is
 * the entire point of a finance module living outside admin operations.
 *
 * Every other role — branch_manager, branch_user, production_user — gets nothing
 * at all, including `view`.
 */
export function financeCan(
  role: UserRole | string | null | undefined,
  permission: FinancePermission,
  allowSuperAdminWrite = false,
): boolean {
  if (role === 'super_admin') return permission === 'view' || allowSuperAdminWrite;
  if (!isFinanceRole(role)) return false;
  return FINANCE_ROLE_PERMISSIONS[role].includes(permission);
}

/** Everyone who may open the module at all. Used for route registration + nav. */
export function canAccessFinance(role: UserRole | string | null | undefined): boolean {
  return role === 'super_admin' || isFinanceRole(role);
}

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Which side of the books a ledger head belongs to. */
export type LedgerHeadType = 'income' | 'expense';

/**
 * Which pot the money moved through. This is what separates "Cash in Hand" from
 * "Bank Balance" on the dashboard and the daily closing — the ledger's running
 * `balance` is the two combined.
 */
export type FinanceAccount = 'cash' | 'bank';

export const FINANCE_ACCOUNTS = ['cash', 'bank'] as const satisfies readonly FinanceAccount[];

export const FINANCE_ACCOUNT_LABELS: Record<FinanceAccount, string> = {
  cash: 'Cash in Hand',
  bank: 'Bank',
};

/**
 * How money changed hands. A superset of the branch-side `payment_method` enum
 * (migration 01) because finance also settles by cheque and bank transfer, which
 * a shop counter never does. Kept as free text in the database for the same
 * reason expense categories are — see CreateExpenseSchema.
 */
export const FINANCE_PAYMENT_METHODS = [
  'cash',
  'easypaisa',
  'bank_transfer',
  'cheque',
  'foodpanda',
  'online',
  'other',
] as const;

export type FinancePaymentMethod = (typeof FINANCE_PAYMENT_METHODS)[number];

export const FINANCE_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  foodpanda: 'Foodpanda',
  online: 'Online',
  other: 'Other',
};

/**
 * The approval lifecycle every manual document walks:
 *
 *   draft → pending_approval → approved → posted → locked
 *                     ↘ rejected
 *
 * `approved` and `posted` are distinct states even though the API advances
 * through both inside one call: approval is the human decision, posting is the
 * bookkeeping consequence, and a posting that fails must not leave a document
 * looking un-approved. `locked` is applied in bulk when the finance day closes.
 */
export type FinanceDocStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'locked'
  | 'rejected';

export const FINANCE_DOC_STATUS_LABELS: Record<FinanceDocStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  posted: 'Posted',
  locked: 'Locked',
  rejected: 'Rejected',
};

/** Statuses whose document is still editable by its author. */
export const EDITABLE_DOC_STATUSES: readonly FinanceDocStatus[] = ['draft', 'rejected'];

// ---------------------------------------------------------------------------
// Ledger heads
// ---------------------------------------------------------------------------

export interface LedgerHead {
  id: string;
  /** Stable short code (INC-CASH-BRANCH, EXP-RENT). Unique; used by reports. */
  code: string;
  name: string;
  type: LedgerHeadType;
  description: string | null;
  /** Optional grouping shown as a section header on the Ledger Heads page. */
  groupName: string | null;
  isActive: boolean;
  /**
   * Seeded by migration 52 and referenced by the automatic postings (branch
   * income, the two share splits, salaries). A system head may be renamed but
   * never deactivated, or the import would have nowhere to post.
   */
  isSystem: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The code of every head the automatic postings depend on. Anything reading one
 * of these MUST use the constant — a typo here is a runtime "ledger head not
 * found" at 2 AM on the closing job, not a compile error.
 */
export const SYSTEM_LEDGER_HEAD_CODES = {
  BRANCH_CASH: 'INC-BRANCH-CASH',
  COMPANY_SHARE: 'INC-COMPANY-SHARE',
  BRANCH_SHARE: 'INC-BRANCH-SHARE',
  SALARIES: 'EXP-SALARIES',
  PARTNER_WITHDRAWAL: 'EXP-PARTNER',
  OPENING_BALANCE: 'INC-OPENING',
  ADJUSTMENT: 'EXP-ADJUSTMENT',
  BRANCH_SHARE_PAYOUT: 'EXP-BRANCH-SHARE-PAYOUT',
  PRODUCTION_EXPENSE: 'EXP-PRODUCTION',
} as const;

// ---------------------------------------------------------------------------
// Ledger entries — the posted book
// ---------------------------------------------------------------------------

/**
 * Where a posted entry came from. Every entry has exactly one source document,
 * and `sourceId` points at it, so any figure on any report can be traced back
 * to the decision that authorised it.
 */
export type LedgerSourceType =
  | 'opening'
  | 'manual'
  | 'branch_income'
  | 'company_share'
  | 'branch_share'
  | 'salary'
  | 'partner_expense'
  | 'adjustment'
  | 'branch_share_payout'
  | 'branch_share_bonus';

/**
 * `posted` is the normal state. `locked` is applied when the finance day closes.
 * `reversed` marks an entry that a later reversing entry has cancelled — the
 * original stays in the book, greyed out, exactly as an audit requires.
 */
export type LedgerEntryStatus = 'posted' | 'locked' | 'reversed';

export interface LedgerEntry {
  id: string;
  voucherNo: string;
  /**
   * Global monotonic posting order. THE ledger is ordered by this, not by
   * `entryDate`: `balance` is the running book balance at the moment of posting,
   * so re-sorting by date would show balances that never existed. Back-dating
   * into a closed day is refused outright (see post_finance_ledger_entry), which
   * is what keeps the two orderings from diverging in practice.
   */
  seq: number;
  /** Business date (Asia/Karachi, 2 AM rollover) the entry belongs to. */
  entryDate: string;
  ledgerHeadId: string | null;
  /** Snapshot — a head renamed later must not rewrite historical vouchers. */
  ledgerHeadName: string;
  ledgerHeadType: LedgerHeadType;
  branchId: string | null;
  branchName: string | null;
  description: string;
  /** Money IN (a receipt). Cash-book convention: debit increases the balance. */
  debit: number;
  /** Money OUT (a payment). */
  credit: number;
  /** Running book balance after this entry, in `seq` order. */
  balance: number;
  account: FinanceAccount;
  paymentMethod: string | null;
  status: LedgerEntryStatus;
  sourceType: LedgerSourceType;
  sourceId: string | null;
  /** Set on a reversing entry: the entry it cancels. */
  reversesEntryId: string | null;
  /** Set on the original once reversed: the entry that cancelled it. */
  reversedByEntryId: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  postedAt: string;
  /**
   * Photos of the SOURCE DOCUMENT this voucher was posted from, resolved on read
   * via (sourceType, sourceId) — they are not stored on the ledger row, which is
   * immutable by trigger. Absent on entries whose source carries no photo:
   * opening balances, reversals, and anything imported rather than keyed in.
   *
   * The `url` on each is short-lived. See the note on `Attachment`.
   */
  attachments?: Attachment[];
}

export interface LedgerQuery {
  from?: string;
  to?: string;
  branchId?: string;
  ledgerHeadId?: string;
  type?: LedgerHeadType;
  account?: FinanceAccount;
  status?: LedgerEntryStatus;
  sourceType?: LedgerSourceType;
  voucherNo?: string;
  /** Free-text across description, voucher no, head name, branch name. */
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
  offset?: number;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  total: number;
  /** Book balance immediately BEFORE the first entry on this page. */
  openingBalance: number;
  /** Book balance after the last entry on this page. */
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
}

// ---------------------------------------------------------------------------
// Branch income approvals
// ---------------------------------------------------------------------------

/**
 *   Branch submits daily closing → Admin verifies → Finance approves → posted.
 *
 * `pending_verification` exists only while Finance Settings has
 * `requireAdminVerification` on; with it off, the import lands straight in
 * `pending_approval`. Nothing reaches the ledger until Finance approves.
 */
export type IncomeApprovalStatus =
  | 'pending_verification'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export interface FinanceIncomeApproval {
  id: string;
  referenceNo: string;
  branchId: string;
  branchName: string;
  businessDate: string;

  /** Gross collected by the branch — the sum of the five splits below. */
  totalAmount: number;
  cashAmount: number;
  easypaisaAmount: number;
  foodpandaAmount: number;
  bankAmount: number;
  otherAmount: number;

  /** The branch's own shop expenses for the day, for reference and `netAmount`. */
  branchExpenses: number;
  /** totalAmount − branchExpenses. Which of the two the shares are struck on is
   *  the `shareBasis` setting. */
  netAmount: number;

  /** Percentages SNAPSHOT at approval time — changing the setting later must not
   *  silently restate an approved day. */
  companySharePct: number;
  branchSharePct: number;
  companyShare: number;
  branchShare: number;

  status: IncomeApprovalStatus;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Optional here, unlike every other finance document. These rows are IMPORTED
   * from the branch closing rather than keyed into a form, so there is no moment
   * of capture to require a photo at. A verifier may attach one; nothing forces
   * it. See the note on `optionalAttachmentIds`.
   */
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------
// Manual income / expense documents
// ---------------------------------------------------------------------------

export interface FinanceTransaction {
  id: string;
  txnNo: string;
  txnType: LedgerHeadType;
  ledgerHeadId: string;
  ledgerHeadName: string;
  branchId: string | null;
  branchName: string | null;
  description: string;
  amount: number;
  paymentMethod: string;
  account: FinanceAccount;
  businessDate: string;
  status: FinanceDocStatus;
  /** Cheque number, transfer reference, invoice number — whatever backs it up. */
  referenceNo: string | null;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the receipt or voucher, captured when the entry was raised. */
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------
// Salaries
// ---------------------------------------------------------------------------

/**
 * The payroll master. Separate from `users` on purpose: `users` is the set of
 * people who can SIGN IN, and most people on a payroll cannot. Linking payroll
 * to auth accounts would mean provisioning a login for every baker.
 */
export interface FinanceEmployee {
  id: string;
  employeeCode: string;
  name: string;
  department: string;
  designation: string;
  branchId: string | null;
  branchName: string | null;
  /** The salary effective as of today — resolved from salary_revisions, not a raw column. */
  baseSalary: number;
  /** An already-recorded revision whose effective date hasn't arrived yet, if any. */
  pendingRevision: { newSalary: number; effectiveFrom: string; reason: string } | null;
  phone: string | null;
  joinedOn: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One recorded base-salary change. Append-only (salary_revisions table) — a
 * correction is a new row, not an edit to this one. See the migration
 * comment for why this can never restate a payslip that already exists.
 */
export interface SalaryRevision {
  id: string;
  employeeId: string;
  employeeName: string;
  previousSalary: number;
  newSalary: number;
  reason: string;
  effectiveFrom: string;
  changedBy: string | null;
  changedByName: string;
  createdAt: string;
}

export interface SalaryPayment {
  id: string;
  salaryNo: string;
  employeeId: string;
  /** Snapshots — a promotion must not restate last year's payslips. */
  employeeName: string;
  department: string;
  designation: string;
  /** 'YYYY-MM'. Unique per employee, which is what stops a double payment. */
  salaryMonth: string;
  grossSalary: number;
  bonus: number;
  deductions: number;
  /** grossSalary + bonus − deductions, computed server-side. */
  netSalary: number;
  paymentDate: string | null;
  paymentMethod: string;
  account: FinanceAccount;
  status: FinanceDocStatus;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the signed payslip or the cash handover. */
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------
// Partners, partner advances/draws, branch share payouts
// ---------------------------------------------------------------------------

/** One of the four fixed owners. `sharePct` is informational here — the 25%
 * split is enforced by the migration's check constraint, not read live from
 * this row by every consumer, so a future ownership change is one row edit
 * away rather than a re-derivation. */
export interface FinancePartner {
  id: string;
  name: string;
  fatherName: string | null;
  dateOfBirth: string | null;
  joinedOn: string | null;
  partnerType: 'founder' | 'co_founder' | null;
  address: string | null;
  contactNumber: string | null;
  emergencyNumber: string | null;
  sharePct: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PartnerTxnKind = 'advance' | 'draw';

/**
 * An ADVANCE is money lent to a partner against their future share (deducted
 * later); a DRAW is a partner withdrawing money they are already entitled to
 * from the current grand total. Both post as an expense under EXP-PARTNER —
 * `txnKind` is what the Partner Share Detail report groups by.
 */
export interface PartnerExpense {
  id: string;
  expenseNo: string;
  partnerId: string | null;
  partnerName: string;
  txnKind: PartnerTxnKind;
  ledgerHeadId: string;
  ledgerHeadName: string;
  description: string;
  amount: number;
  paymentMethod: string;
  account: FinanceAccount;
  businessDate: string;
  status: FinanceDocStatus;
  requestedBy: string | null;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the cash handover or the transfer slip. */
  attachments?: Attachment[];
}

/**
 * Actually paying a branch its already-recorded share. Branch income
 * approval posts the company/branch share split to the ledger immediately,
 * but that only RECORDS the split — this is the payout. `bonus` is optional
 * and posts separately to Production Expenses rather than the share-payout
 * head, with a note naming the branch.
 */
export interface BranchSharePayment {
  id: string;
  paymentNo: string;
  branchId: string;
  branchName: string;
  amount: number;
  bonus: number;
  businessDate: string;
  paymentMethod: string;
  account: FinanceAccount;
  status: FinanceDocStatus;
  notes: string | null;
  requestedBy: string | null;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  bonusLedgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the payout being handed over. */
  attachments?: Attachment[];
}

/**
 * What one branch is still owed — computed from the ledger, never stored.
 *
 * `recorded` is every posted Branch Share entry for the branch (what income
 * approval booked as theirs); `paidOut` is every posted Branch Share Payout for
 * it. The difference is what a payout should be for, which is the number the
 * payout form previously asked someone to key from memory.
 *
 * Bonuses are excluded on purpose — a bonus posts to Production Expenses, not
 * against the branch's share, so counting it here would make the branch look
 * settled when its share is still outstanding.
 */
export interface BranchShareBalance {
  branchId: string;
  branchName: string;
  /** The split this branch is currently on, and whether it is its own. */
  companySharePct: number;
  branchSharePct: number;
  isOverride: boolean;
  recorded: number;
  paidOut: number;
  /** recorded − paidOut. Negative means the branch has been overpaid. */
  outstanding: number;
}

/** One row of the Partner Share Detail table — computed, not stored. */
export interface PartnerShareRow {
  id: string;
  name: string;
  sharePct: number;
  /** grandTotal × sharePct / 100 */
  sharePctAmount: number;
  advancePaid: number;
  drawPaid: number;
  /** sharePctAmount − advancePaid − drawPaid */
  balance: number;
}

export interface PartnerShareSummary {
  from: string | null;
  to: string | null;
  /** Every posted expense except partner advances/draws — production, utilities, packaging, salaries, branch share payouts, etc. */
  totalExpense: number;
  /** Every posted entry under the Company Share head. */
  totalCompanyShare: number;
  /** totalCompanyShare − totalExpense */
  grandTotal: number;
  partners: PartnerShareRow[];
}

// ---------------------------------------------------------------------------
// Daily closing
// ---------------------------------------------------------------------------

export interface FinanceDayClosing {
  businessDate: string;
  /** Carried from the previous day's closing balance — see financeDaySummary. */
  openingBalance: number;
  openingCash: number;
  openingBank: number;
  totalIncome: number;
  totalExpenses: number;
  /** totalIncome − totalExpenses for the day alone. */
  netBalance: number;
  cashInHand: number;
  bankBalance: number;
  closingBalance: number;
  entryCount: number;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface FinanceDashboard {
  businessDate: string;
  todayIncome: number;
  todayExpenses: number;
  netCashBalance: number;
  companyShare: number;
  branchShare: number;
  pendingIncomeApprovals: number;
  pendingIncomeAmount: number;
  pendingExpenseApprovals: number;
  pendingExpenseAmount: number;
  bankBalance: number;
  cashInHand: number;
  recentEntries: LedgerEntry[];
  /** Oldest first, so a chart can render it without reversing. */
  trend: { businessDate: string; income: number; expenses: number; net: number }[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Whether the company/branch split is struck on gross collection or on net of
 *  the branch's own expenses. */
export type ShareBasis = 'gross' | 'net';

export interface FinanceSettings {
  /** MUST sum to 100 with branchSharePct — enforced by a table CHECK. */
  companySharePct: number;
  branchSharePct: number;
  shareBasis: ShareBasis;
  /** The book's starting position, before any ledger entry exists. */
  openingCashBalance: number;
  openingBankBalance: number;
  openingBalanceDate: string | null;
  /** Pull approved branch closings into the pending-income list automatically. */
  autoImportBranchIncome: boolean;
  /** Insert the Admin-verifies step between import and Finance approval. */
  requireAdminVerification: boolean;
  /** Grants Super Admin write access to finance records. Off by default. */
  allowSuperAdminWrite: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_FINANCE_SETTINGS = {
  companySharePct: 75,
  branchSharePct: 25,
  shareBasis: 'gross',
  openingCashBalance: 0,
  openingBankBalance: 0,
  autoImportBranchIncome: true,
  requireAdminVerification: true,
  allowSuperAdminWrite: false,
} as const;

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type FinanceAuditAction =
  | 'created'
  | 'updated'
  | 'submitted'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'reversed'
  | 'adjusted'
  | 'locked'
  | 'imported'
  | 'settings_updated'
  | 'salary_revised'
  | 'resolved'
  | 'deleted';

export type FinanceAuditEntity =
  | 'ledger_entry'
  | 'ledger_head'
  | 'finance_transaction'
  | 'income_approval'
  | 'salary_payment'
  | 'partner_expense'
  | 'employee'
  | 'day_closing'
  | 'settings'
  | 'branch_share_payment'
  | 'finance_partner'
  | 'finance_ticket';

export interface FinanceAuditLog {
  id: string;
  entity: FinanceAuditEntity;
  entityId: string | null;
  /** Human handle for the row — voucher no, salary no, reference no. */
  entityRef: string | null;
  action: FinanceAuditAction;
  actorId: string | null;
  actorName: string;
  actorRole: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  deviceInfo: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const FINANCE_REPORT_TYPES = [
  'daily_cash_book',
  'general_ledger',
  'income_statement',
  'expense_report',
  'profit_loss',
  'company_share',
  'branch_share',
  'salary',
  'partner_expense',
  'trial_balance',
] as const;

export type FinanceReportType = (typeof FINANCE_REPORT_TYPES)[number];

export const FINANCE_REPORT_LABELS: Record<FinanceReportType, string> = {
  daily_cash_book: 'Daily Cash Book',
  general_ledger: 'General Ledger',
  income_statement: 'Income Statement',
  expense_report: 'Expense Report',
  profit_loss: 'Profit & Loss',
  company_share: 'Company Share Report',
  branch_share: 'Branch Share Report',
  salary: 'Salary Report',
  partner_expense: 'Partner Expense Report',
  trial_balance: 'Trial Balance',
};

export type ReportCellFormat = 'text' | 'money' | 'number' | 'date';

export interface FinanceReportColumn {
  key: string;
  label: string;
  format?: ReportCellFormat;
  align?: 'left' | 'right' | 'center';
  /** Relative width hint, used by the PDF/Excel writers. */
  width?: number;
}

/**
 * One shape for all ten reports.
 *
 * The alternative — ten bespoke response types with ten bespoke PDF writers and
 * ten bespoke Excel writers — is thirty places to fix a column. A report is a
 * title, some columns, some rows and some totals; the export layer needs to know
 * nothing else, which is why `exportFinanceReport` can render any of them.
 */
export interface FinanceReport {
  type: FinanceReportType;
  title: string;
  subtitle: string;
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  generatedBy: string;
  columns: FinanceReportColumn[];
  rows: Record<string, string | number | null>[];
  /** Column key → total, rendered as a bold footer row. */
  totals: Record<string, number>;
  /** Headline figures printed above the table. */
  summary: { label: string; value: number; format?: ReportCellFormat }[];
}

export interface FinanceReportQuery {
  type: FinanceReportType;
  from?: string;
  to?: string;
  branchId?: string;
  ledgerHeadId?: string;
  partnerName?: string;
  employeeId?: string;
  department?: string;
  salaryMonth?: string;
}

export type FinanceExportFormat = 'pdf' | 'excel' | 'csv';

// ---------------------------------------------------------------------------
// Finance Help Desk
//
// A query an Accountant or Finance Manager raises against a finance record, and
// the Finance Admin's resolution of it. Kept separate from the admin Support
// Center (`support.types.ts`) on purpose — see migration 60 for why.
// ---------------------------------------------------------------------------

/**
 * The finance records a query can be raised against, each keyed to the table it
 * lives in and the column carrying its human reference number. The API resolves
 * a typed reference number (RV-000001, SAL-000012, …) through this map, so the
 * raiser never has to say which kind of record they mean.
 *
 * `altPrefixes` exists because one table can carry more than one number series.
 * `ledger_entries` carries three: RV- receipts and PV- payments (migration 71),
 * plus every FV- voucher issued before that split — those rows still exist and
 * are still what an old report or an open ticket cites, so the Help Desk has to
 * keep resolving them. Order matters only for display: `prefix` is the one shown
 * as the example.
 */
export const FINANCE_TICKET_REFERENCES = {
  ledger_entry:         { prefix: 'RV',  altPrefixes: ['PV', 'FV'], table: 'ledger_entries',           refColumn: 'voucher_no',   label: 'Ledger Voucher' },
  income_approval:      { prefix: 'INC', table: 'finance_income_approvals', refColumn: 'reference_no', label: 'Branch Income' },
  finance_transaction:  { prefix: 'FTX', table: 'finance_transactions',     refColumn: 'txn_no',       label: 'Transaction' },
  salary_payment:       { prefix: 'SAL', table: 'salary_payments',          refColumn: 'salary_no',    label: 'Salary Payment' },
  partner_expense:      { prefix: 'PEX', table: 'partner_expenses',         refColumn: 'expense_no',   label: 'Partner Expense' },
  branch_share_payment: { prefix: 'BSP', table: 'branch_share_payments',    refColumn: 'payment_no',   label: 'Branch Share' },
} as const;

export type FinanceTicketReferenceType = keyof typeof FINANCE_TICKET_REFERENCES;

/**
 * Every prefix a raiser may legitimately type, primary and alternate alike.
 * Derived, so adding a series is one edit to the map above — the Help Desk regex
 * and the "expected one of" error both read this rather than their own list.
 */
export const FINANCE_TICKET_PREFIXES: string[] = Object.values(FINANCE_TICKET_REFERENCES).flatMap(
  (r) => [r.prefix, ...(('altPrefixes' in r ? r.altPrefixes : []) as readonly string[])],
);

export const FINANCE_TICKET_REFERENCE_LABELS: Record<FinanceTicketReferenceType, string> = {
  ledger_entry: 'Ledger Voucher',
  income_approval: 'Branch Income',
  finance_transaction: 'Transaction',
  salary_payment: 'Salary Payment',
  partner_expense: 'Partner Expense',
  branch_share_payment: 'Branch Share',
};

/**
 * Reference-number prefix → the record type it identifies. Derived, never
 * hand-written. Alternate prefixes map to the same type as their primary, which
 * is what lets RV-, PV- and FV- all resolve to `ledger_entry`.
 */
export const FINANCE_TICKET_PREFIX_MAP: Record<string, FinanceTicketReferenceType> = Object.fromEntries(
  (Object.keys(FINANCE_TICKET_REFERENCES) as FinanceTicketReferenceType[]).flatMap((k) => {
    const ref = FINANCE_TICKET_REFERENCES[k];
    const alts = ('altPrefixes' in ref ? ref.altPrefixes : []) as readonly string[];
    return [ref.prefix, ...alts].map((p) => [p, k] as const);
  }),
);

export type FinanceTicketStatus = 'open' | 'resolved' | 'rejected';

export const FINANCE_TICKET_STATUS_LABELS: Record<FinanceTicketStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export interface FinanceTicket {
  id: string;
  ticketNo: string;
  referenceType: FinanceTicketReferenceType;
  /** Null when the referenced row has since been removed; the snapshot survives. */
  referenceId: string | null;
  referenceNo: string;
  /** The record's figures as they stood when the query was raised. */
  referenceSnapshot: Record<string, unknown> | null;
  subject: string;
  message: string;
  status: FinanceTicketStatus;
  resolutionNote: string | null;
  raisedBy: string | null;
  raisedByName: string;
  raisedByRole: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What GET /api/finance/tickets/lookup returns for a reference number. */
export interface FinanceTicketReferenceLookup {
  referenceType: FinanceTicketReferenceType;
  referenceId: string;
  referenceNo: string;
  label: string;
  snapshot: Record<string, unknown>;
}
