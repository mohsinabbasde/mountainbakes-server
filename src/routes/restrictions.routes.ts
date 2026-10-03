import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  BRANCH_ROLES,
  CreateRestrictionRequestSchema,
  DecideRestrictionRequestSchema,
  RESTRICTION_GROUPS,
  RestrictionGroupSchemas,
  businessDateStr,
  financeCan,
  isBranchRole,
  type CreateRestrictionRequestInput,
  type RestrictionGroup,
} from '../shared';
import { getFinanceSettings } from '../services/finance-settings.service';
import {
  checkCashDeposit,
  checkDemand,
  checkFinanceEntry,
  checkSale,
  countPendingRestrictionRequests,
  createRestrictionRequest,
  decideRestrictionRequest,
  getRestrictionMonitor,
  getRestrictionRulesState,
  listRestrictionEvents,
  listRestrictionRequests,
  saveRestrictionGroup,
} from '../services/restriction.service';

/**
 * Restriction Rules (migration 136).
 *
 * THREE AUDIENCES ON ONE ROUTER, each gated per route:
 *
 *   /check/*    the popups' preflight — "what will the server say if I submit?".
 *               Read-only and advisory: the write paths run the same evaluation
 *               again and are the ones that count.
 *   /requests   a branch or finance user asking Admin to lift a rule once.
 *   everything  else is the Admin Settings screen, super_admin only. A branch
 *               user cannot read the rules, the monitor or the audit trail.
 *
 * Branch and user always come from the token. No route here accepts a branch
 * id, a user id or an approval flag from a branch role.
 */
export const router = Router();

router.use(authenticate);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actorOf = (req: AuthRequest) => ({ uid: req.user!.uid, name: req.user!.email });

/** A 'YYYY-MM-DD' query value, or undefined when absent or malformed. */
function dateParam(req: AuthRequest, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && DATE.test(v) ? v : undefined;
}

// ─── Preflight ───────────────────────────────────────────────────────────────

// GET /api/restrictions/check/demand?requiredDate=YYYY-MM-DD
router.get('/check/demand', requireRole(...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }
    const { check } = await checkDemand({ branchId, requiredDate: dateParam(req, 'requiredDate') });
    res.json(check);
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/check/sale
router.get('/check/sale', requireRole('super_admin', ...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    // The hourly rule is about a branch's own entry pattern; an admin keying a
    // sale for a branch is not what it measures.
    if (!isBranchRole(req.user!.role) || !req.user!.branchId) { res.json({ allowed: true, restriction: null }); return; }
    const { check } = await checkSale({ branchId: req.user!.branchId });
    res.json(check);
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/check/cash-deposit?businessDate=YYYY-MM-DD
router.get('/check/cash-deposit', requireRole('super_admin', ...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query['branchId'];
    const branchId = isBranchRole(req.user!.role) ? req.user!.branchId : typeof q === 'string' && UUID.test(q) ? q : null;
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    const today = businessDateStr();
    const claimed = dateParam(req, 'businessDate');
    const { check } = await checkCashDeposit({ branchId, businessDate: claimed && claimed <= today ? claimed : today });
    res.json(check);
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/check/finance-entry?ledgerHeadId=&businessDate=&amount=
router.get('/check/finance-entry', async (req: AuthRequest, res, next) => {
  try {
    const { allowSuperAdminWrite } = await getFinanceSettings();
    if (!financeCan(req.user!.role, 'create', allowSuperAdminWrite)) {
      res.status(403).json({ error: 'Forbidden: your role may not create finance records.' });
      return;
    }
    // Admin is the approver of these rules, not their subject.
    if (req.user!.role === 'super_admin') { res.json({ allowed: true, restriction: null }); return; }

    const headId = req.query['ledgerHeadId'];
    const amount = Number(req.query['amount']);
    if (typeof headId !== 'string' || !UUID.test(headId)) { res.json({ allowed: true, restriction: null }); return; }
    const { check } = await checkFinanceEntry({
      userId: req.user!.uid,
      ledgerHeadId: headId,
      businessDate: dateParam(req, 'businessDate') ?? businessDateStr(),
      amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    });
    res.json(check);
  } catch (err) {
    next(err);
  }
});

// ─── Requests (branch / finance) ─────────────────────────────────────────────

// POST /api/restrictions/requests — ask Admin to lift a restriction once.
router.post('/requests', validate(CreateRestrictionRequestSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as CreateRestrictionRequestInput;
    const role = req.user!.role;

    // Each request type belongs to the people who can attempt that action.
    if (body.type === 'BACKDATED_DEMAND' || body.type === 'CASH_DEPOSIT_LIMIT') {
      if (!isBranchRole(role)) { res.status(403).json({ error: 'Forbidden: only a branch account can raise this request.' }); return; }
    } else {
      const { allowSuperAdminWrite } = await getFinanceSettings();
      if (role === 'super_admin' || !financeCan(role, 'create', allowSuperAdminWrite)) {
        res.status(403).json({ error: 'Forbidden: only a finance account can raise this request.' });
        return;
      }
    }

    const request = await createRestrictionRequest(body, {
      ...actorOf(req),
      branchId: req.user!.branchId,
      branchName: req.user!.branchName,
    });
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/requests/mine — the caller's own requests.
router.get('/requests/mine', async (req: AuthRequest, res, next) => {
  try {
    const requests = await listRestrictionRequests({ requestedBy: req.user!.uid, limit: 50 });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// ─── Admin Settings ──────────────────────────────────────────────────────────

router.use(requireRole('super_admin'));

// GET /api/restrictions/rules
router.get('/rules', async (_req, res, next) => {
  try {
    const [state, pendingRequests] = await Promise.all([getRestrictionRulesState(), countPendingRestrictionRequests()]);
    res.json({ ...state, pendingRequests });
  } catch (err) {
    next(err);
  }
});

// PUT /api/restrictions/rules/:group — replace one group's configuration.
router.put('/rules/:group', async (req: AuthRequest, res, next) => {
  try {
    const group = String(req.params['group']) as RestrictionGroup;
    if (!RESTRICTION_GROUPS.includes(group)) { res.status(404).json({ error: 'Unknown rule group' }); return; }

    const parsed = RestrictionGroupSchemas[group].safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }

    await saveRestrictionGroup(group, parsed.data, actorOf(req));
    res.json(await getRestrictionRulesState());
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/requests?type=&status=
router.get('/requests', async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const requests = await listRestrictionRequests({ type: q['type'], status: q['status'] });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// POST /api/restrictions/requests/:id/decide
router.post('/requests/:id/decide', validate(DecideRestrictionRequestSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = String(req.params['id']);
    if (!UUID.test(id)) { res.status(404).json({ error: 'Request not found' }); return; }
    const { decision, reason } = req.body as { decision: 'approved' | 'rejected'; reason?: string };
    const request = await decideRestrictionRequest(id, decision, reason, actorOf(req));
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/monitor
router.get('/monitor', async (_req, res, next) => {
  try {
    res.json({ branches: await getRestrictionMonitor() });
  } catch (err) {
    next(err);
  }
});

// GET /api/restrictions/events?ruleCode=
router.get('/events', async (req: AuthRequest, res, next) => {
  try {
    const ruleCode = req.query['ruleCode'];
    res.json({ events: await listRestrictionEvents({ ruleCode: typeof ruleCode === 'string' ? ruleCode : undefined }) });
  } catch (err) {
    next(err);
  }
});
