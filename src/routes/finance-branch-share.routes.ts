import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveSchema,
  CreateBranchSharePaymentSchema,
  RejectSchema,
  UpdateBranchSharePaymentSchema,
  type FinanceDocStatus,
} from '../shared';
import {
  approveBranchSharePayment,
  createBranchSharePayment,
  getBranchSharePayment,
  listBranchSharePayments,
  rejectBranchSharePayment,
  submitBranchSharePayment,
  updateBranchSharePayment,
} from '../services/finance-branch-share.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';

/**
 * /api/finance/branch-share — paying a branch its already-recorded income
 * share. See finance-branch-share.service.ts for why approving this posts
 * two ledger entries instead of the usual one.
 */

export const router = Router();

router.use(authenticate);

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const payments = await listBranchSharePayments({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      branchId: q['branchId'],
      from: q['from'],
      to: q['to'],
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
    });
    res.json({ payments, total: payments.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireFinance('create'),
  validate(CreateBranchSharePaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const payment = await createBranchSharePayment(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'branch_share_payment',
        entityId: payment.id,
        entityRef: payment.paymentNo,
        action: 'created',
        newValues: auditSnapshot(payment as unknown as Record<string, unknown>, [
          'branchName', 'amount', 'bonus', 'paymentMethod', 'businessDate', 'status',
        ]),
      });
      res.status(201).json({ payment });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/:id',
  requireFinance('create'),
  validate(UpdateBranchSharePaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getBranchSharePayment(id);
      const payment = await updateBranchSharePayment(id, req.body);

      await logFinanceAudit(req, {
        entity: 'branch_share_payment',
        entityId: id,
        entityRef: payment.paymentNo,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['amount', 'bonus', 'status'])
          : null,
        newValues: auditSnapshot(payment as unknown as Record<string, unknown>, ['amount', 'bonus', 'status']),
      });

      res.json({ payment });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const payment = await submitBranchSharePayment(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'branch_share_payment',
      entityId: payment.id,
      entityRef: payment.paymentNo,
      action: 'submitted',
      newValues: { amount: payment.amount, bonus: payment.bonus, status: payment.status },
    });
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entries } = await approveBranchSharePayment(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'branch_share_payment',
        entityId: document.id,
        entityRef: document.paymentNo,
        action: 'approved',
        newValues: {
          branchName: document.branchName,
          amount: document.amount,
          bonus: document.bonus,
          voucherNos: entries.map((e) => e.voucherNo),
        },
      });
      res.json({ payment: document, ledgerEntries: entries });
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
      const payment = await rejectBranchSharePayment(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'branch_share_payment',
        entityId: payment.id,
        entityRef: payment.paymentNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, branchName: payment.branchName, amount: payment.amount },
      });
      res.json({ payment });
    } catch (err) {
      next(err);
    }
  },
);
