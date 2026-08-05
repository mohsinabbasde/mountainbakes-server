import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance, requireIncomeVerifier } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveSchema,
  CreateFinanceTransactionSchema,
  ImportBranchIncomeSchema,
  RejectSchema,
  UpdateFinanceTransactionSchema,
  VerifyIncomeSchema,
  type FinanceDocStatus,
  type IncomeApprovalStatus,
} from '../shared';
import {
  approveIncome,
  getIncomeApproval,
  importBranchIncome,
  listIncomeApprovals,
  rejectIncome,
  verifyIncome,
} from '../services/finance-income.service';
import {
  approveTransaction,
  createTransaction,
  getTransaction,
  listTransactions,
  rejectTransaction,
  submitTransaction,
  updateTransaction,
} from '../services/finance-documents.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';

/**
 * /api/finance/income — branch closing income, and manual income/expense entries.
 *
 * The two live together because they are the two ways money is recorded, and the
 * Finance screens present them side by side: a pending list you approve, and a
 * form you fill in. The manual side (`/entries`) handles BOTH income and expense
 * documents — the ledger head decides which, so there is no reason for two
 * near-identical route families.
 */

export const router = Router();

router.use(authenticate);

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

// ---------------------------------------------------------------------------
// Branch income approvals
// ---------------------------------------------------------------------------

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const approvals = await listIncomeApprovals({
      // 'pending' spans both waiting states and is what the screen opens on.
      status: (q['status'] as IncomeApprovalStatus | 'pending') || 'pending',
      branchId: q['branchId'],
      from: q['from'],
      to: q['to'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
    });
    res.json({ approvals, total: approvals.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/income/import — pull a business date's branch closings in.
 *
 * `create`, not `approve`: importing stages figures for review and posts nothing.
 * Idempotent, so a finance user hitting it twice costs nothing.
 */
router.post(
  '/import',
  requireFinance('create'),
  validate(ImportBranchIncomeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const result = await importBranchIncome(req.body);
      await logFinanceAudit(req, {
        entity: 'income_approval',
        entityRef: result.businessDate,
        action: 'imported',
        newValues: { imported: result.imported, refreshed: result.refreshed, skipped: result.skipped },
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get('/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const approval = await getIncomeApproval(String(req.params['id']));
    if (!approval) {
      res.status(404).json({ error: 'Income approval not found' });
      return;
    }
    res.json({ approval });
  } catch (err) {
    next(err);
  }
});

/** The Admin-verifies step. See requireIncomeVerifier for why it is not `approve`. */
router.post(
  '/:id/verify',
  requireIncomeVerifier(),
  validate(VerifyIncomeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const approval = await verifyIncome(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'income_approval',
        entityId: approval.id,
        entityRef: approval.referenceNo,
        action: 'verified',
        newValues: { branchName: approval.branchName, businessDate: approval.businessDate, totalAmount: approval.totalAmount },
      });
      res.json({ approval });
    } catch (err) {
      next(err);
    }
  },
);

/** The moment branch income enters the book, split into company and branch shares. */
router.post(
  '/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const before = await getIncomeApproval(String(req.params['id']));
      const { approval, entries } = await approveIncome(String(req.params['id']), actorOf(req), req.body.notes);

      await logFinanceAudit(req, {
        entity: 'income_approval',
        entityId: approval.id,
        entityRef: approval.referenceNo,
        action: 'approved',
        previousValues: before ? auditSnapshot(before as unknown as Record<string, unknown>, ['status', 'companyShare', 'branchShare']) : null,
        newValues: {
          status: approval.status,
          totalAmount: approval.totalAmount,
          companySharePct: approval.companySharePct,
          branchSharePct: approval.branchSharePct,
          companyShare: approval.companyShare,
          branchShare: approval.branchShare,
          postedVouchers: entries.map((e) => e.voucherNo),
        },
      });

      res.json({ approval, entries });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const approval = await rejectIncome(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'income_approval',
        entityId: approval.id,
        entityRef: approval.referenceNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, branchName: approval.branchName, businessDate: approval.businessDate },
      });
      res.json({ approval });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Manual income / expense documents
//
// Mounted under a sub-path of this router so the URL reads
// /api/finance/income/entries. They share the approval machinery and the screens
// sit next to each other; splitting them across two prefixes would suggest a
// separation that does not exist.
// ---------------------------------------------------------------------------

export const entriesRouter = Router();

entriesRouter.use(authenticate);

entriesRouter.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const entries = await listTransactions({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      type: (q['type'] as 'income' | 'expense') || undefined,
      branchId: q['branchId'],
      ledgerHeadId: q['ledgerHeadId'],
      from: q['from'],
      to: q['to'],
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
    });
    res.json({ entries, total: entries.length });
  } catch (err) {
    next(err);
  }
});

entriesRouter.post(
  '/',
  requireFinance('create'),
  validate(CreateFinanceTransactionSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const doc = await createTransaction(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'finance_transaction',
        entityId: doc.id,
        entityRef: doc.txnNo,
        action: 'created',
        newValues: auditSnapshot(doc as unknown as Record<string, unknown>, [
          'txnType', 'ledgerHeadName', 'description', 'amount', 'account', 'paymentMethod', 'businessDate', 'status',
        ]),
      });
      res.status(201).json({ entry: doc });
    } catch (err) {
      next(err);
    }
  },
);

entriesRouter.put(
  '/:id',
  requireFinance('create'),
  validate(UpdateFinanceTransactionSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getTransaction(id);
      const doc = await updateTransaction(id, req.body);

      await logFinanceAudit(req, {
        entity: 'finance_transaction',
        entityId: id,
        entityRef: doc.txnNo,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['ledgerHeadName', 'description', 'amount', 'account', 'businessDate', 'status'])
          : null,
        newValues: auditSnapshot(doc as unknown as Record<string, unknown>, ['ledgerHeadName', 'description', 'amount', 'account', 'businessDate', 'status']),
      });

      res.json({ entry: doc });
    } catch (err) {
      next(err);
    }
  },
);

entriesRouter.post('/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const doc = await submitTransaction(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'finance_transaction',
      entityId: doc.id,
      entityRef: doc.txnNo,
      action: 'submitted',
      newValues: { amount: doc.amount, status: doc.status },
    });
    res.json({ entry: doc });
  } catch (err) {
    next(err);
  }
});

entriesRouter.post(
  '/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entry } = await approveTransaction(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'finance_transaction',
        entityId: document.id,
        entityRef: document.txnNo,
        action: 'approved',
        newValues: { amount: document.amount, ledgerHeadName: document.ledgerHeadName, voucherNo: entry.voucherNo },
      });
      res.json({ entry: document, ledgerEntry: entry });
    } catch (err) {
      next(err);
    }
  },
);

entriesRouter.post(
  '/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const doc = await rejectTransaction(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'finance_transaction',
        entityId: doc.id,
        entityRef: doc.txnNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, amount: doc.amount },
      });
      res.json({ entry: doc });
    } catch (err) {
      next(err);
    }
  },
);
