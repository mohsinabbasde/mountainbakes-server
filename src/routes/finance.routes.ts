import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  AdjustLedgerEntrySchema,
  businessDateStr,
  CloseFinanceDaySchema,
  CreateLedgerHeadSchema,
  UpdateFinanceSettingsSchema,
  UpdateLedgerHeadSchema,
  type FinanceAccount,
  type LedgerEntryStatus,
  type LedgerHeadType,
  type LedgerQuery,
  type LedgerSourceType,
} from '../shared';
import {
  adjustEntry,
  closeFinanceDay,
  createLedgerHead,
  getDayClosing,
  getFinanceDashboard,
  getLedgerEntry,
  listDayClosings,
  listLedgerHeads,
  queryLedger,
  updateLedgerHead,
} from '../services/finance-ledger.service';
import { getFinanceSettings, updateFinanceSettings } from '../services/finance-settings.service';
import { auditSnapshot, listFinanceAudit, logFinanceAudit } from '../services/finance-audit.service';

/**
 * /api/finance — the ledger, its chart of accounts, the daily closing, settings
 * and the audit trail.
 *
 * Every route below is gated twice: `authenticate` resolves the Supabase JWT and
 * fails closed on an unrecognised role, then `requireFinance(permission)` decides
 * whether THAT role may do THIS. Branch and production users never get past the
 * second gate, on any endpoint, including the read-only ones.
 *
 * The audit trail is written by the ROUTE rather than the service, deliberately:
 * only the route has the request, and the request is where the IP and the device
 * come from. A service-level trail would have to be handed a fake one.
 */

export const router = Router();

router.use(authenticate);

/** The signed-in user as the services and the trail want them. */
function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/dashboard', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const businessDate = typeof req.query['date'] === 'string' ? req.query['date'] : businessDateStr();
    res.json(await getFinanceDashboard(businessDate));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * GET /api/finance/ledger — the cash book.
 *
 * Defaults to the current business date rather than "everything": an unfiltered
 * ledger is both slow and useless, and the Daily Ledger page always arrives with
 * a date in hand.
 */
router.get('/ledger', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const today = businessDateStr();

    const query: LedgerQuery = {
      from: q['from'] ?? today,
      to: q['to'] ?? q['from'] ?? today,
      branchId: q['branchId'] || undefined,
      ledgerHeadId: q['ledgerHeadId'] || undefined,
      type: (q['type'] as LedgerHeadType) || undefined,
      account: (q['account'] as FinanceAccount) || undefined,
      status: (q['status'] as LedgerEntryStatus) || undefined,
      sourceType: (q['sourceType'] as LedgerSourceType) || undefined,
      voucherNo: q['voucherNo'] || undefined,
      search: q['search'] || undefined,
      minAmount: q['minAmount'] ? Number(q['minAmount']) : undefined,
      maxAmount: q['maxAmount'] ? Number(q['maxAmount']) : undefined,
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    };

    res.json(await queryLedger(query));
  } catch (err) {
    next(err);
  }
});

router.get('/ledger/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const entry = await getLedgerEntry(String(req.params['id']));
    if (!entry) {
      res.status(404).json({ error: 'Ledger entry not found' });
      return;
    }
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/ledger/:id/adjust — reverse, or reverse and re-post.
 *
 * The ONLY route in this module that touches a posted figure, and it does not
 * edit one: it posts new entries that cancel and (optionally) replace the
 * original, leaving both in the book. `adjust` is a Finance Admin permission
 * because it is the one action that can move money without a source document
 * behind it.
 */
router.post(
  '/ledger/:id/adjust',
  requireFinance('adjust'),
  validate(AdjustLedgerEntrySchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getLedgerEntry(id);
      if (!before) {
        res.status(404).json({ error: 'Ledger entry not found' });
        return;
      }

      const entries = await adjustEntry(id, req.body, actorOf(req));

      await logFinanceAudit(req, {
        entity: 'ledger_entry',
        entityId: id,
        entityRef: before.voucherNo,
        action: req.body.correctedAmount !== undefined ? 'adjusted' : 'reversed',
        previousValues: auditSnapshot(before as unknown as Record<string, unknown>, [
          'voucherNo', 'entryDate', 'ledgerHeadName', 'description', 'debit', 'credit', 'balance', 'status',
        ]),
        newValues: {
          reason: req.body.reason,
          correctedAmount: req.body.correctedAmount ?? null,
          postedVouchers: entries.map((e) => e.voucherNo),
        },
      });

      res.status(201).json({ entries });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Ledger heads
// ---------------------------------------------------------------------------

router.get('/heads', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const heads = await listLedgerHeads({
      type: (req.query['type'] as LedgerHeadType) || undefined,
      includeInactive: req.query['includeInactive'] === 'true',
    });
    res.json({ heads, total: heads.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/heads',
  requireFinance('configure'),
  validate(CreateLedgerHeadSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const head = await createLedgerHead(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'ledger_head',
        entityId: head.id,
        entityRef: head.code,
        action: 'created',
        newValues: auditSnapshot(head as unknown as Record<string, unknown>, ['code', 'name', 'type', 'groupName']),
      });
      res.status(201).json({ head });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/heads/:id',
  requireFinance('configure'),
  validate(UpdateLedgerHeadSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = (await listLedgerHeads({ includeInactive: true })).find((h) => h.id === id);
      const head = await updateLedgerHead(id, req.body);

      await logFinanceAudit(req, {
        entity: 'ledger_head',
        entityId: id,
        entityRef: head.code,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['name', 'groupName', 'isActive', 'sortOrder'])
          : null,
        newValues: auditSnapshot(head as unknown as Record<string, unknown>, ['name', 'groupName', 'isActive', 'sortOrder']),
      });

      res.json({ head });
    } catch (err) {
      next(err);
    }
  },
);

// A head is never DELETEd. It is deactivated, because every voucher ever filed
// under it still names it, and the FK from ledger_entries is ON DELETE RESTRICT.
// The absence of a DELETE route here is the point, not an omission.

// ---------------------------------------------------------------------------
// Daily closing
// ---------------------------------------------------------------------------

router.get('/closing', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const businessDate = typeof req.query['date'] === 'string' ? req.query['date'] : businessDateStr();
    res.json({ closing: await getDayClosing(businessDate) });
  } catch (err) {
    next(err);
  }
});

router.get('/closing/history', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query['days'] ?? 30)));
    const closings = await listDayClosings(days);
    res.json({ closings, total: closings.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/closing — close and lock a business date.
 *
 * `approve`, not `configure`: closing a day is signing off its figures, which is
 * the same class of act as approving a voucher, and a Finance Manager should be
 * able to do it without also being able to rewrite the share percentages.
 */
router.post(
  '/closing',
  requireFinance('approve'),
  validate(CloseFinanceDaySchema),
  async (req: AuthRequest, res, next) => {
    try {
      const closing = await closeFinanceDay(req.body.businessDate, actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'day_closing',
        entityRef: req.body.businessDate,
        action: 'locked',
        newValues: {
          openingBalance: closing.openingBalance,
          totalIncome: closing.totalIncome,
          totalExpenses: closing.totalExpenses,
          closingBalance: closing.closingBalance,
          cashInHand: closing.cashInHand,
          bankBalance: closing.bankBalance,
          entryCount: closing.entryCount,
        },
      });
      res.status(201).json({ closing });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', requireFinance('view'), async (_req: AuthRequest, res, next) => {
  try {
    res.json({ settings: await getFinanceSettings() });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/settings',
  requireFinance('configure'),
  validate(UpdateFinanceSettingsSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { settings, previous, postedVouchers } = await updateFinanceSettings(
        req.body,
        actorOf(req),
        businessDateStr(),
      );

      const watched = [
        'companySharePct', 'branchSharePct', 'shareBasis',
        'openingCashBalance', 'openingBankBalance',
        'autoImportBranchIncome', 'requireAdminVerification', 'allowSuperAdminWrite',
      ] as const;

      await logFinanceAudit(req, {
        entity: 'settings',
        entityRef: 'finance_settings',
        action: 'settings_updated',
        previousValues: auditSnapshot(previous as unknown as Record<string, unknown>, [...watched]),
        newValues: {
          ...auditSnapshot(settings as unknown as Record<string, unknown>, [...watched]),
          // Changing an opening balance posts a real voucher for the difference —
          // record which, so the trail explains where that entry came from.
          ...(postedVouchers.length > 0 ? { openingBalanceVouchers: postedVouchers } : {}),
        },
      });

      res.json({ settings, postedVouchers });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

router.get('/audit', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const { logs, total } = await listFinanceAudit({
      entity: q['entity'],
      entityId: q['entityId'],
      action: q['action'],
      actorId: q['actorId'],
      from: q['from'],
      to: q['to'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    });
    res.json({ logs, total });
  } catch (err) {
    next(err);
  }
});
