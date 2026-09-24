/**
 * Data Engine — the resource registry.
 *
 * Every list the web app reads through `GET /api/data/:resource` is declared
 * here and nowhere else. A resource names its table, who may read it, how
 * their rows are scoped, and exactly which fields may be searched, filtered,
 * sorted, aggregated and exported. The request can never reach a column that
 * is not written down in this file.
 *
 * Scoping mirrors the hand-written routes it replaces, rule for rule:
 *   - branch roles are pinned to `req.user.branchId` (`isBranchRole`);
 *   - a production user sees active orders everywhere plus the production
 *     counter's own delivered sales (`orders.routes.ts`);
 *   - finance help-desk raisers see only the queries they raised
 *     (`finance-tickets.routes.ts`); admins see the queue minus others' drafts;
 *   - login history pins non-admins to their own sessions
 *     (`login-history.routes.ts`) and masks addresses the same way;
 *   - every finance table honours its soft delete (`utils/softDelete.ts`).
 */
import {
  BRANCH_ROLES,
  FINANCE_ROLES,
  USER_ROLES,
  financeHelpDeskCan,
  isBranchRole,
  type UserRole,
} from '../shared';
import { maskEmail } from '../utils/mask';
import { getProductionBranchId } from '../utils/productionBranch';
import { ScopeDenied, type AuthUser, type FieldDef, type ResourceConfig, type ScopeRule } from './types';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const ALL_ROLES: readonly UserRole[] = USER_ROLES;
const FINANCE_READERS: readonly UserRole[] = ['super_admin', ...FINANCE_ROLES];
const OPERATIONS: readonly UserRole[] = ['super_admin', ...BRANCH_ROLES, 'production_user'];

/**
 * The canonical branch rule: a branch role reads its own branch, full stop.
 * A branch account with no branch assigned is refused rather than shown
 * everything — fail closed, as `auth.ts` does for a missing role.
 */
function branchScope(user: AuthUser): ScopeRule[] {
  if (!isBranchRole(user.role)) return [];
  if (!user.branchId) throw new ScopeDenied('Your account has no branch assigned');
  return [{ column: 'branch_id', op: 'eq', value: user.branchId }];
}

const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({ key, kind, ...extra });

/** `created_at` on the 2 AM business day — the rule every sales screen uses. */
const createdAtBusiness = f('createdAt', 'timestamp', { businessDay: true });

const branchFields = [f('branchId', 'uuid'), f('branchName', 'text')];

// ---------------------------------------------------------------------------
// Orders / Sales
// ---------------------------------------------------------------------------

const ACTIVE_ORDER_STATUSES = ['pending', 'preparing', 'ready'];

const ORDER_SELECT = `
  *,
  items:order_items(
    product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
`;

const ordersConfig: ResourceConfig = {
  table: 'orders',
  select: ORDER_SELECT,
  embedOrder: [{ column: 'line_no', referencedTable: 'order_items', ascending: true }],
  roles: OPERATIONS,
  async scope(user) {
    if (user.role === 'production_user') {
      // Active orders from every branch (the kitchen queue) plus the
      // production counter's own delivered sales — the union of what
      // /api/orders and /api/orders/production-sales each allowed.
      const productionBranchId = await getProductionBranchId();
      return [
        {
          any: [
            { column: 'status', op: 'in', value: ACTIVE_ORDER_STATUSES },
            {
              all: [
                { column: 'branch_id', op: 'eq', value: productionBranchId },
                { column: 'status', op: 'eq', value: 'delivered' },
              ],
            },
          ],
        },
      ];
    }
    return branchScope(user);
  },
  fields: [
    f('orderNumber', 'text'),
    f('customerId', 'uuid'),
    f('customerName', 'text'),
    f('customerPhone', 'text'),
    ...branchFields,
    f('status', 'enum'),
    f('paymentMethod', 'enum'),
    f('subtotal', 'number'),
    f('discountTotal', 'number'),
    f('deliveryCharges', 'number'),
    f('taxAmount', 'number'),
    f('grandTotal', 'number'),
    f('businessDate', 'date'),
    f('notes', 'text'),
    f('createdBy', 'uuid'),
    f('createdByName', 'text'),
    createdAtBusiness,
  ],
  searchableFields: ['orderNumber', 'customerName', 'customerPhone'],
  sortableFields: ['createdAt', 'businessDate', 'orderNumber', 'customerName', 'grandTotal', 'status', 'branchName', 'notes'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  aggregatableFields: ['subtotal', 'discountTotal', 'deliveryCharges', 'taxAmount', 'grandTotal'],
  groupableFields: ['status', 'paymentMethod', 'branchId', 'branchName', 'businessDate'],
  export: {
    fileName: 'orders',
    columns: [
      { key: 'orderNumber', header: 'Order #' },
      { key: 'businessDate', header: 'Business Date' },
      { key: 'createdAt', header: 'Time' },
      { key: 'branchName', header: 'Branch' },
      { key: 'customerName', header: 'Customer' },
      { key: 'customerPhone', header: 'Phone' },
      { key: 'status', header: 'Status' },
      { key: 'paymentMethod', header: 'Payment' },
      { key: 'subtotal', header: 'Subtotal' },
      { key: 'discountTotal', header: 'Discount' },
      { key: 'grandTotal', header: 'Total' },
      { key: 'createdByName', header: 'Sold By' },
    ],
  },
  cache: 'live',
};

// Sales are orders read by business day. Same rows, same rules — a second
// name so a page can say what it means and get a sales-shaped export.
const salesConfig: ResourceConfig = {
  ...ordersConfig,
  export: { ...ordersConfig.export!, fileName: 'sales' },
};

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

const productionOrdersConfig: ResourceConfig = {
  table: 'production_orders',
  select: `
    *,
    items:production_order_items(*),
    packingItems:production_order_packing_items(*)
  `,
  embedOrder: [
    { column: 'line_no', referencedTable: 'production_order_items', ascending: true },
    { column: 'line_no', referencedTable: 'production_order_packing_items', ascending: true },
  ],
  roles: OPERATIONS,
  scope: branchScope,
  fields: [
    f('demandNumber', 'text'),
    ...branchFields,
    f('status', 'enum'),
    f('businessDate', 'date'),
    f('requiredDate', 'date'),
    f('createdBy', 'uuid'),
    f('createdByName', 'text'),
    f('approvedByName', 'text'),
    f('printed', 'boolean'),
    f('wasChanged', 'boolean'),
    f('submittedAt', 'timestamp', { businessDay: true }),
    f('cancelReason', 'text'),
    createdAtBusiness,
  ],
  searchableFields: ['demandNumber', 'branchName', 'createdByName'],
  sortableFields: ['businessDate', 'submittedAt', 'createdAt', 'demandNumber', 'branchName', 'status', 'requiredDate', 'cancelReason'],
  defaultSort: { key: 'businessDate', direction: 'desc' },
  groupableFields: ['status', 'branchId', 'branchName', 'businessDate'],
  // The page type spells these `date` / `time` (production-orders.routes.ts).
  transform: (rows) =>
    rows.map(({ businessDate, submittedTime, ...rest }) => ({ ...rest, businessDate, date: businessDate, time: submittedTime })),
  export: {
    fileName: 'production-orders',
    columns: [
      { key: 'demandNumber', header: 'Demand #' },
      { key: 'date', header: 'Date' },
      { key: 'time', header: 'Time' },
      { key: 'branchName', header: 'Branch' },
      { key: 'status', header: 'Status' },
      { key: 'requiredDate', header: 'Required' },
      { key: 'createdByName', header: 'Raised By' },
      { key: 'approvedByName', header: 'Approved By' },
    ],
  },
  cache: 'live',
};

const productionStockConfig: ResourceConfig = {
  table: 'production_stock_history',
  roles: ['super_admin', 'production_user'],
  fields: [
    f('productId', 'uuid'),
    f('productName', 'text'),
    f('type', 'enum'),
    f('branchId', 'uuid'),
    f('productionOrderId', 'uuid'),
    f('transactionNo', 'text'),
    f('delta', 'number'),
    f('balanceAfter', 'number'),
    f('createdByName', 'text'),
    f('reason', 'text'),
    f('businessDate', 'date'),
    f('createdAt', 'timestamp', { businessDay: true }),
  ],
  searchableFields: ['productName', 'transactionNo', 'reason', 'createdByName'],
  sortableFields: ['businessDate', 'createdAt', 'productName', 'type', 'delta', 'balanceAfter'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  aggregatableFields: ['delta'],
  groupableFields: ['type', 'productId', 'productName', 'branchId', 'businessDate'],
  export: {
    fileName: 'production-stock-ledger',
    columns: [
      { key: 'businessDate', header: 'Date' },
      { key: 'createdAt', header: 'Time' },
      { key: 'transactionNo', header: 'Txn #' },
      { key: 'productName', header: 'Product' },
      { key: 'type', header: 'Type' },
      { key: 'delta', header: 'Qty' },
      { key: 'balanceAfter', header: 'Balance' },
      { key: 'createdByName', header: 'By' },
      { key: 'reason', header: 'Reason' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Branch stock
// ---------------------------------------------------------------------------

const branchStockConfig: ResourceConfig = {
  table: 'stock_history',
  roles: ['super_admin', ...BRANCH_ROLES],
  scope: branchScope,
  fields: [
    f('branchId', 'uuid'),
    f('productId', 'uuid'),
    f('productName', 'text'),
    f('type', 'enum'),
    f('delta', 'number'),
    f('balanceAfter', 'number'),
    f('refId', 'uuid'),
    f('businessDate', 'date'),
    f('createdAt', 'timestamp', { businessDay: true }),
  ],
  searchableFields: ['productName'],
  sortableFields: ['businessDate', 'createdAt', 'productName', 'type', 'delta', 'balanceAfter'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  aggregatableFields: ['delta'],
  groupableFields: ['type', 'productId', 'productName', 'businessDate'],
  export: {
    fileName: 'branch-stock-ledger',
    columns: [
      { key: 'businessDate', header: 'Date' },
      { key: 'createdAt', header: 'Time' },
      { key: 'productName', header: 'Product' },
      { key: 'type', header: 'Type' },
      { key: 'delta', header: 'Qty' },
      { key: 'balanceAfter', header: 'Balance' },
    ],
  },
  cache: 'live',
};

const stockAuditConfig: ResourceConfig = {
  table: 'stock_audit_log',
  roles: ['super_admin', ...BRANCH_ROLES],
  scope: branchScope,
  fields: [
    ...branchFields,
    f('userId', 'uuid'),
    f('userName', 'text'),
    f('productId', 'uuid'),
    f('productName', 'text'),
    f('requestedQty', 'number'),
    f('availableQty', 'number'),
    f('businessDate', 'date'),
    f('createdAt', 'timestamp', { businessDay: true }),
  ],
  searchableFields: ['productName', 'userName', 'reason'],
  sortableFields: ['createdAt', 'businessDate', 'productName', 'userName'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

const closingStockConfig: ResourceConfig = {
  table: 'daily_closing_reports',
  // report_json is the whole archived sheet — never in a list.
  select: 'id, business_date, scope, branch_id, department, generated_at',
  roles: ['super_admin', ...BRANCH_ROLES],
  scope: branchScope,
  fields: [
    f('businessDate', 'date'),
    f('scope', 'enum'),
    f('branchId', 'uuid'),
    f('department', 'text'),
    f('generatedAt', 'timestamp'),
  ],
  sortableFields: ['businessDate', 'generatedAt', 'department'],
  defaultSort: { key: 'businessDate', direction: 'desc' },
  cache: 'static',
};

const dailySaleRecordsConfig: ResourceConfig = {
  table: 'daily_sale_records',
  roles: ['super_admin', ...BRANCH_ROLES],
  scope: branchScope,
  fields: [
    ...branchFields,
    f('businessDate', 'date'),
    f('status', 'enum'),
    f('autoTotalSale', 'number'),
    f('autoCash', 'number'),
    f('discount', 'number'),
    f('expenseTotal', 'number'),
    f('orderCount', 'number'),
    f('overallDifference', 'number'),
    f('fedByName', 'text'),
    f('verifiedByName', 'text'),
    f('createdAt', 'timestamp'),
  ],
  searchableFields: ['branchName', 'fedByName', 'verifiedByName'],
  sortableFields: ['businessDate', 'branchName', 'status', 'autoTotalSale', 'overallDifference'],
  defaultSort: { key: 'businessDate', direction: 'desc' },
  aggregatableFields: ['autoTotalSale', 'autoCash', 'discount', 'expenseTotal', 'orderCount', 'overallDifference'],
  groupableFields: ['status', 'branchId', 'branchName', 'businessDate'],
  export: {
    fileName: 'daily-sale-records',
    columns: [
      { key: 'businessDate', header: 'Date' },
      { key: 'branchName', header: 'Branch' },
      { key: 'status', header: 'Status' },
      { key: 'autoTotalSale', header: 'Total Sale' },
      { key: 'discount', header: 'Discount' },
      { key: 'expenseTotal', header: 'Expenses' },
      { key: 'orderCount', header: 'Orders' },
      { key: 'overallDifference', header: 'Difference' },
      { key: 'fedByName', header: 'Fed By' },
      { key: 'verifiedByName', header: 'Verified By' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

const expensesConfig: ResourceConfig = {
  table: 'expenses',
  roles: OPERATIONS,
  scope: branchScope,
  fields: [
    f('expenseNumber', 'text'),
    ...branchFields,
    f('businessDate', 'date'),
    f('category', 'text'),
    f('description', 'text'),
    f('paymentMethod', 'enum'),
    f('amount', 'number'),
    f('remarks', 'text'),
    f('createdBy', 'uuid'),
    f('createdByName', 'text'),
    createdAtBusiness,
  ],
  searchableFields: ['expenseNumber', 'description', 'remarks', 'createdByName'],
  sortableFields: ['businessDate', 'createdAt', 'expenseNumber', 'amount', 'category', 'branchName', 'paymentMethod'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  aggregatableFields: ['amount'],
  groupableFields: ['category', 'paymentMethod', 'branchId', 'branchName', 'businessDate'],
  // The Expense type calls the business date `date` (expenses.routes.ts).
  transform: (rows) => rows.map(({ businessDate, ...rest }) => ({ ...rest, businessDate, date: businessDate })),
  export: {
    fileName: 'expenses',
    columns: [
      { key: 'expenseNumber', header: 'Expense #' },
      { key: 'date', header: 'Date' },
      { key: 'branchName', header: 'Branch' },
      { key: 'category', header: 'Category' },
      { key: 'description', header: 'Description' },
      { key: 'paymentMethod', header: 'Payment' },
      { key: 'amount', header: 'Amount' },
      { key: 'remarks', header: 'Remarks' },
      { key: 'createdByName', header: 'Entered By' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

const incomeConfig: ResourceConfig = {
  table: 'finance_income_approvals',
  roles: FINANCE_READERS,
  softDelete: { mayInclude: ['super_admin', 'finance_admin'] },
  fields: [
    f('referenceNo', 'text'),
    ...branchFields,
    f('businessDate', 'date'),
    f('status', 'enum'),
    f('totalAmount', 'number'),
    f('cashAmount', 'number'),
    f('easypaisaAmount', 'number'),
    f('foodpandaAmount', 'number'),
    f('bankAmount', 'number'),
    f('otherAmount', 'number'),
    f('branchExpenses', 'number'),
    f('netAmount', 'number'),
    f('companyShare', 'number'),
    f('branchShare', 'number'),
    f('verifiedByName', 'text'),
    f('approvedByName', 'text'),
    f('approvedAt', 'timestamp'),
    f('createdAt', 'timestamp'),
  ],
  searchableFields: ['referenceNo', 'branchName'],
  sortableFields: ['businessDate', 'branchName', 'status', 'totalAmount', 'netAmount', 'createdAt', 'approvedAt'],
  defaultSort: { key: 'businessDate', direction: 'desc' },
  aggregatableFields: [
    'totalAmount', 'cashAmount', 'easypaisaAmount', 'foodpandaAmount', 'bankAmount', 'otherAmount',
    'branchExpenses', 'netAmount', 'companyShare', 'branchShare',
  ],
  groupableFields: ['status', 'branchId', 'branchName', 'businessDate'],
  export: {
    fileName: 'branch-income',
    columns: [
      { key: 'referenceNo', header: 'Reference' },
      { key: 'businessDate', header: 'Date' },
      { key: 'branchName', header: 'Branch' },
      { key: 'status', header: 'Status' },
      { key: 'totalAmount', header: 'Total' },
      { key: 'branchExpenses', header: 'Expenses' },
      { key: 'netAmount', header: 'Net' },
      { key: 'companyShare', header: 'Company Share' },
      { key: 'branchShare', header: 'Branch Share' },
      { key: 'approvedByName', header: 'Approved By' },
    ],
  },
  cache: 'live',
};

const financeConfig: ResourceConfig = {
  table: 'ledger_entries',
  roles: FINANCE_READERS,
  softDelete: { mayInclude: ['super_admin', 'finance_admin'] },
  fields: [
    f('voucherNo', 'text'),
    f('seq', 'number'),
    f('entryDate', 'date'),
    f('ledgerHeadId', 'uuid'),
    f('ledgerHeadName', 'text'),
    f('ledgerHeadType', 'enum'),
    ...branchFields,
    f('description', 'text'),
    f('debit', 'number'),
    f('credit', 'number'),
    f('balance', 'number'),
    f('account', 'enum'),
    f('paymentMethod', 'enum'),
    f('status', 'enum'),
    f('sourceType', 'enum'),
    f('sourceId', 'uuid'),
    f('createdByName', 'text'),
    f('approvedByName', 'text'),
    f('postedAt', 'timestamp'),
  ],
  searchableFields: ['voucherNo', 'description', 'ledgerHeadName', 'branchName'],
  sortableFields: ['entryDate', 'seq', 'voucherNo', 'ledgerHeadName', 'debit', 'credit', 'balance', 'postedAt'],
  // The book reads in posting order: date, then sequence.
  defaultSort: { key: 'entryDate', direction: 'desc' },
  tiebreaker: { column: 'seq', ascending: false },
  aggregatableFields: ['debit', 'credit'],
  groupableFields: ['ledgerHeadId', 'ledgerHeadName', 'ledgerHeadType', 'account', 'paymentMethod', 'status', 'sourceType', 'branchId', 'branchName', 'entryDate'],
  export: {
    fileName: 'ledger',
    columns: [
      { key: 'entryDate', header: 'Date' },
      { key: 'voucherNo', header: 'Voucher' },
      { key: 'ledgerHeadName', header: 'Head' },
      { key: 'branchName', header: 'Branch' },
      { key: 'description', header: 'Description' },
      { key: 'account', header: 'Account' },
      { key: 'debit', header: 'Debit' },
      { key: 'credit', header: 'Credit' },
      { key: 'balance', header: 'Balance' },
      { key: 'status', header: 'Status' },
    ],
  },
  cache: 'live',
};

const transactionsConfig: ResourceConfig = {
  table: 'finance_transactions',
  roles: FINANCE_READERS,
  softDelete: { mayInclude: ['super_admin', 'finance_admin'] },
  fields: [
    f('txnNo', 'text'),
    f('txnType', 'enum'),
    f('ledgerHeadId', 'uuid'),
    f('ledgerHeadName', 'text'),
    ...branchFields,
    f('description', 'text'),
    f('amount', 'number'),
    f('paymentMethod', 'enum'),
    f('account', 'enum'),
    f('businessDate', 'date'),
    f('status', 'enum'),
    f('referenceNo', 'text'),
    f('createdByName', 'text'),
    f('approvedByName', 'text'),
    f('approvedAt', 'timestamp'),
    f('createdAt', 'timestamp'),
  ],
  searchableFields: ['txnNo', 'description', 'ledgerHeadName', 'referenceNo'],
  sortableFields: ['businessDate', 'createdAt', 'txnNo', 'amount', 'status', 'ledgerHeadName', 'branchName'],
  defaultSort: { key: 'businessDate', direction: 'desc' },
  tiebreaker: { column: 'created_at', ascending: false },
  aggregatableFields: ['amount'],
  groupableFields: ['txnType', 'status', 'account', 'paymentMethod', 'ledgerHeadId', 'ledgerHeadName', 'branchId', 'branchName', 'businessDate'],
  export: {
    fileName: 'finance-entries',
    columns: [
      { key: 'txnNo', header: 'Txn #' },
      { key: 'businessDate', header: 'Date' },
      { key: 'txnType', header: 'Type' },
      { key: 'ledgerHeadName', header: 'Head' },
      { key: 'branchName', header: 'Branch' },
      { key: 'description', header: 'Description' },
      { key: 'amount', header: 'Amount' },
      { key: 'paymentMethod', header: 'Payment' },
      { key: 'status', header: 'Status' },
      { key: 'referenceNo', header: 'Reference' },
    ],
  },
  cache: 'live',
};

/** A raiser sees their own queue; the admin and the auditor see all of it. */
function seesWholeQueue(role: string): boolean {
  return financeHelpDeskCan(role, 'respond') || role === 'finance_auditor';
}

const financeHelpDeskConfig: ResourceConfig = {
  table: 'finance_tickets',
  roles: FINANCE_READERS,
  softDelete: { mayInclude: ['super_admin'] },
  scope(user) {
    if (!seesWholeQueue(user.role)) return [{ column: 'raised_by', op: 'eq', value: user.uid }];
    // Another person's DRAFT is not on anyone's desk yet.
    return [
      {
        any: [
          { column: 'status', op: 'neq', value: 'draft' },
          { column: 'raised_by', op: 'eq', value: user.uid },
        ],
      },
    ];
  },
  fields: [
    f('queryNo', 'text'),
    f('ticketNo', 'text'),
    f('referenceType', 'enum'),
    f('referenceNo', 'text'),
    f('subject', 'text'),
    f('status', 'enum'),
    f('queryType', 'enum'),
    f('priority', 'enum'),
    ...branchFields,
    f('raisedBy', 'uuid'),
    f('raisedByName', 'text'),
    f('raisedByRole', 'enum'),
    f('assignedTo', 'uuid'),
    f('amount', 'number'),
    f('businessDate', 'date'),
    f('createdAt', 'timestamp'),
    f('updatedAt', 'timestamp'),
    f('resolvedAt', 'timestamp'),
  ],
  searchableFields: [
    'queryNo', 'ticketNo', 'referenceNo', 'subject', 'raisedByName', 'branchName',
  ],
  sortableFields: ['createdAt', 'updatedAt', 'queryNo', 'status', 'priority', 'amount', 'businessDate', 'branchName'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  groupableFields: ['status', 'queryType', 'priority', 'branchId', 'branchName', 'raisedBy'],
  aggregatableFields: ['amount'],
  // internal_note is the admin's working note and is stripped for everyone
  // else HERE, at the boundary (finance-tickets.routes.ts, ticketForCaller).
  transform: (rows, user) =>
    financeHelpDeskCan(user.role, 'respond')
      ? rows
      : rows.map(({ internalNote: _internalNote, ...visible }) => visible),
  export: {
    fileName: 'finance-queries',
    columns: [
      { key: 'queryNo', header: 'Query #' },
      { key: 'createdAt', header: 'Raised' },
      { key: 'status', header: 'Status' },
      { key: 'priority', header: 'Priority' },
      { key: 'queryType', header: 'Type' },
      { key: 'referenceNo', header: 'Reference' },
      { key: 'subject', header: 'Subject' },
      { key: 'branchName', header: 'Branch' },
      { key: 'raisedByName', header: 'Raised By' },
      { key: 'amount', header: 'Amount' },
    ],
  },
  cache: 'live',
};

const financeAuditConfig: ResourceConfig = {
  table: 'finance_audit_logs',
  roles: FINANCE_READERS,
  fields: [
    f('entity', 'enum'),
    f('entityId', 'uuid'),
    f('entityRef', 'text'),
    f('action', 'enum'),
    f('actorId', 'uuid'),
    f('actorName', 'text'),
    f('actorRole', 'enum'),
    f('createdAt', 'timestamp', { businessDay: true }),
  ],
  searchableFields: ['entityRef', 'actorName'],
  sortableFields: ['createdAt', 'entity', 'action', 'actorName'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  groupableFields: ['entity', 'action', 'actorId', 'actorName'],
  export: {
    fileName: 'finance-audit',
    columns: [
      { key: 'createdAt', header: 'When' },
      { key: 'entity', header: 'Entity' },
      { key: 'entityRef', header: 'Reference' },
      { key: 'action', header: 'Action' },
      { key: 'actorName', header: 'By' },
      { key: 'actorRole', header: 'Role' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

const productsConfig: ResourceConfig = {
  table: 'products',
  roles: ALL_ROLES,
  fields: [
    f('name', 'text'),
    f('sku', 'text'),
    f('stockCode', 'text'),
    f('categoryId', 'uuid'),
    f('categoryName', 'text'),
    f('price', 'number'),
    f('costPrice', 'number'),
    f('isActive', 'boolean'),
    f('isSpecial', 'boolean'),
    f('createdAt', 'timestamp'),
    f('updatedAt', 'timestamp'),
  ],
  searchableFields: ['name', 'sku', 'stockCode'],
  sortableFields: ['name', 'sku', 'stockCode', 'categoryName', 'price', 'costPrice', 'createdAt', 'updatedAt'],
  defaultSort: { key: 'name', direction: 'asc' },
  groupableFields: ['categoryId', 'categoryName', 'isActive', 'isSpecial'],
  export: {
    fileName: 'products',
    columns: [
      { key: 'stockCode', header: 'Code' },
      { key: 'name', header: 'Product' },
      { key: 'sku', header: 'SKU' },
      { key: 'categoryName', header: 'Category' },
      { key: 'price', header: 'Price' },
      { key: 'costPrice', header: 'Cost' },
      { key: 'isActive', header: 'Active' },
    ],
  },
  cache: 'static',
};

const customersConfig: ResourceConfig = {
  table: 'customers',
  roles: ['super_admin', ...BRANCH_ROLES],
  scope: branchScope,
  fields: [
    f('name', 'text'),
    f('phone', 'text'),
    f('email', 'text'),
    ...branchFields,
    f('totalOrders', 'number'),
    f('totalSpent', 'number'),
    f('createdAt', 'timestamp'),
  ],
  searchableFields: ['name', 'phone', 'email'],
  sortableFields: ['name', 'createdAt', 'totalOrders', 'totalSpent', 'branchName'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  aggregatableFields: ['totalOrders', 'totalSpent'],
  groupableFields: ['branchId', 'branchName'],
  export: {
    fileName: 'customers',
    columns: [
      { key: 'name', header: 'Name' },
      { key: 'phone', header: 'Phone' },
      { key: 'email', header: 'Email' },
      { key: 'branchName', header: 'Branch' },
      { key: 'totalOrders', header: 'Orders' },
      { key: 'totalSpent', header: 'Spent' },
      { key: 'createdAt', header: 'Since' },
    ],
  },
  cache: 'static',
};

const usersConfig: ResourceConfig = {
  table: 'users',
  roles: ['super_admin'],
  fields: [
    f('email', 'text'),
    f('displayName', 'text'),
    f('username', 'text'),
    f('userCode', 'text'),
    f('phone', 'text'),
    f('role', 'enum'),
    ...branchFields,
    f('status', 'enum'),
    f('shift', 'enum'),
    f('mustChangePassword', 'boolean'),
    f('lastLoginAt', 'timestamp'),
    f('createdAt', 'timestamp'),
  ],
  searchableFields: ['email', 'displayName', 'username', 'userCode', 'phone'],
  sortableFields: ['displayName', 'email', 'role', 'status', 'branchName', 'lastLoginAt', 'createdAt'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  groupableFields: ['role', 'status', 'branchId', 'branchName'],
  export: {
    fileName: 'users',
    columns: [
      { key: 'userCode', header: 'Code' },
      { key: 'displayName', header: 'Name' },
      { key: 'email', header: 'Email' },
      { key: 'role', header: 'Role' },
      { key: 'branchName', header: 'Branch' },
      { key: 'status', header: 'Status' },
      { key: 'lastLoginAt', header: 'Last Login' },
    ],
  },
  cache: 'static',
};

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const loginHistoryConfig: ResourceConfig = {
  table: 'login_sessions',
  roles: ALL_ROLES,
  // A non-admin is pinned to their own sessions regardless of what they ask
  // (login-history.routes.ts).
  scope: (user) => (user.role === 'super_admin' ? [] : [{ column: 'user_id', op: 'eq', value: user.uid }]),
  fields: [
    f('userId', 'uuid'),
    f('userCode', 'text'),
    f('userName', 'text'),
    f('userRole', 'enum'),
    ...branchFields,
    f('country', 'text'),
    f('city', 'text'),
    f('browser', 'text'),
    f('os', 'text'),
    f('deviceType', 'enum'),
    f('ipAddress', 'text'),
    f('isSuspicious', 'boolean'),
    f('endReason', 'enum'),
    f('loginAt', 'timestamp', { businessDay: true }),
    f('lastSeenAt', 'timestamp'),
    f('endedAt', 'timestamp'),
    f('revokedAt', 'timestamp'),
    f('businessDate', 'date'),
  ],
  searchableFields: ['userCode', 'userName', 'city', 'country', 'browser', 'os', 'ipAddress'],
  sortableFields: ['loginAt', 'lastSeenAt', 'endedAt', 'userName', 'branchName', 'country', 'city', 'browser'],
  defaultSort: { key: 'loginAt', direction: 'desc' },
  groupableFields: ['userId', 'userName', 'userRole', 'branchId', 'branchName', 'country', 'city', 'browser', 'deviceType', 'businessDate'],
  // Same redaction as login-history.service.ts `toApi`: the address is shown
  // in full to an admin or to the row's own user, masked to anyone else, and
  // never substituted. Coordinates never leave the server in a list.
  transform: (rows, user) =>
    rows.map(({ businessDate, userEmail, browserEmail, latitude: _lat, longitude: _lng, ...rest }) => {
      const reveal = user.role === 'super_admin' || rest.userId === user.uid;
      const email = typeof userEmail === 'string' ? userEmail : '';
      const google = typeof browserEmail === 'string' && browserEmail ? browserEmail : null;
      return {
        ...rest,
        date: businessDate,
        businessDate,
        userEmail: reveal ? email : maskEmail(email),
        browserEmail: google === null ? null : reveal ? google : maskEmail(google),
      };
    }),
  export: {
    fileName: 'login-history',
    columns: [
      { key: 'loginAt', header: 'Login' },
      { key: 'userName', header: 'User' },
      { key: 'userCode', header: 'Code' },
      { key: 'userRole', header: 'Role' },
      { key: 'branchName', header: 'Branch' },
      { key: 'deviceType', header: 'Device' },
      { key: 'browser', header: 'Browser' },
      { key: 'os', header: 'OS' },
      { key: 'city', header: 'City' },
      { key: 'country', header: 'Country' },
      { key: 'ipAddress', header: 'IP' },
      { key: 'endedAt', header: 'Ended' },
      { key: 'endReason', header: 'End Reason' },
    ],
  },
  cache: 'live',
};

const loginAttemptsConfig: ResourceConfig = {
  table: 'login_attempts',
  roles: ['super_admin'],
  fields: [
    f('email', 'text'),
    f('reason', 'enum'),
    f('country', 'text'),
    f('city', 'text'),
    f('browser', 'text'),
    f('os', 'text'),
    f('deviceType', 'enum'),
    f('ipAddress', 'text'),
    f('attemptedAt', 'timestamp', { businessDay: true }),
    f('businessDate', 'date'),
  ],
  searchableFields: ['email', 'ipAddress', 'city', 'country'],
  sortableFields: ['attemptedAt', 'email', 'reason', 'country'],
  defaultSort: { key: 'attemptedAt', direction: 'desc' },
  groupableFields: ['reason', 'country', 'deviceType', 'businessDate'],
  transform: (rows) => rows.map(({ businessDate, ...rest }) => ({ ...rest, businessDate, date: businessDate })),
  export: {
    fileName: 'failed-logins',
    columns: [
      { key: 'attemptedAt', header: 'When' },
      { key: 'email', header: 'Email' },
      { key: 'reason', header: 'Reason' },
      { key: 'ipAddress', header: 'IP' },
      { key: 'city', header: 'City' },
      { key: 'country', header: 'Country' },
      { key: 'browser', header: 'Browser' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// Support & audit
// ---------------------------------------------------------------------------

const supportConfig: ResourceConfig = {
  table: 'support_tickets',
  roles: OPERATIONS,
  // Archived tickets are the admin's "deleted": hidden unless asked for.
  softDelete: { column: 'archived_at', mayInclude: ['super_admin'] },
  scope: (user) => (user.role === 'super_admin' ? [] : [{ column: 'raised_by', op: 'eq', value: user.uid }]),
  fields: [
    f('ticketNumber', 'text'),
    f('referenceType', 'enum'),
    f('referenceId', 'uuid'),
    f('status', 'enum'),
    ...branchFields,
    f('raisedBy', 'uuid'),
    f('raisedByName', 'text'),
    f('raisedByRole', 'enum'),
    f('resolvedByName', 'text'),
    f('resolvedAt', 'timestamp'),
    f('createdAt', 'timestamp', { businessDay: true }),
    f('updatedAt', 'timestamp'),
  ],
  searchableFields: ['ticketNumber', 'message', 'raisedByName', 'branchName'],
  sortableFields: ['createdAt', 'updatedAt', 'ticketNumber', 'status', 'branchName', 'raisedByName', 'resolvedAt'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  groupableFields: ['status', 'referenceType', 'branchId', 'branchName', 'raisedByRole'],
  export: {
    fileName: 'support-tickets',
    columns: [
      { key: 'ticketNumber', header: 'Ticket #' },
      { key: 'createdAt', header: 'Raised' },
      { key: 'status', header: 'Status' },
      { key: 'referenceType', header: 'About' },
      { key: 'branchName', header: 'Branch' },
      { key: 'raisedByName', header: 'Raised By' },
      { key: 'message', header: 'Message' },
      { key: 'resolvedByName', header: 'Resolved By' },
      { key: 'resolvedAt', header: 'Resolved' },
    ],
  },
  cache: 'live',
};

const auditLogsConfig: ResourceConfig = {
  table: 'audit_logs',
  roles: ['super_admin'],
  fields: [
    f('action', 'text'),
    f('adminId', 'uuid'),
    f('adminName', 'text'),
    f('targetUserId', 'uuid'),
    f('targetUserName', 'text'),
    f('targetUserRole', 'enum'),
    f('createdAt', 'timestamp', { businessDay: true }),
  ],
  searchableFields: ['action', 'adminName', 'targetUserName'],
  sortableFields: ['createdAt', 'action', 'adminName', 'targetUserName'],
  defaultSort: { key: 'createdAt', direction: 'desc' },
  groupableFields: ['action', 'adminId', 'adminName', 'targetUserRole'],
  export: {
    fileName: 'audit-logs',
    columns: [
      { key: 'createdAt', header: 'When' },
      { key: 'action', header: 'Action' },
      { key: 'adminName', header: 'By' },
      { key: 'targetUserName', header: 'Target' },
      { key: 'targetUserRole', header: 'Target Role' },
    ],
  },
  cache: 'live',
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const resources = {
  sales: salesConfig,
  orders: ordersConfig,
  productionOrders: productionOrdersConfig,
  productionStock: productionStockConfig,
  branchStock: branchStockConfig,
  stockAudit: stockAuditConfig,
  closingStock: closingStockConfig,
  dailySaleRecords: dailySaleRecordsConfig,
  expenses: expensesConfig,
  income: incomeConfig,
  finance: financeConfig,
  financeHelpDesk: financeHelpDeskConfig,
  financeAudit: financeAuditConfig,
  transactions: transactionsConfig,
  products: productsConfig,
  customers: customersConfig,
  users: usersConfig,
  loginHistory: loginHistoryConfig,
  loginAttempts: loginAttemptsConfig,
  support: supportConfig,
  auditLogs: auditLogsConfig,
} satisfies Record<string, ResourceConfig>;

export type ResourceName = keyof typeof resources;

export function getResource(name: string): ResourceConfig | undefined {
  return Object.prototype.hasOwnProperty.call(resources, name)
    ? (resources as Record<string, ResourceConfig>)[name]
    : undefined;
}
