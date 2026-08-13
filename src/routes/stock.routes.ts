import { Router } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { businessDateStr, CreateBranchReturnSchema, type StockAuditLog, BRANCH_ROLES, isBranchRole } from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { commitBranchReturn, computeStockRows, InsufficientStockError } from '../services/stock.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { requireInsideGeofence } from '../middleware/requireInsideGeofence';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

// GET /api/stock/audit — blocked-sale attempts (Admin: all; branch manager: own branch)
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    // Ordering and the 200-row cap happen in Postgres (stock_audit_log_branch_idx
    // is already (branch_id, created_at desc)); this used to fetch every row and
    // sort/slice in memory.
    let query = supabaseAdmin
      .from('stock_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (isBranchRole(req.user!.role)) {
      if (!req.user!.branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    const logs = rowToApi<StockAuditLog[]>(data ?? []);
    res.json({ logs, total: logs.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/stock?date=YYYY-MM-DD — Opening/New/Sold/Balance per product for a branch (today by default)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : (req.query['branchId'] as string | undefined) ?? null;

    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const date = (req.query['date'] as string | undefined) || businessDateStr();
    const rows = await computeStockRows(branchId, date);
    res.json({ date, rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock/return — branch returns unsold/damaged stock to production.
// Applied immediately: branch balance ↓, production pool ↑ (Returned), and an
// accepted return record + real-time notification for the Production dashboard.
//
// Takes MANY products in one submission: a branch closing out an evening hands
// back everything unsold at once, and Production wants one notification for that,
// not one per line.
//
// ATOMICITY, HONESTLY: commit_branch_return is a per-product RPC and PostgREST
// gives each call its own transaction, so a batch is not all-or-nothing. The
// pre-validation pass below closes the realistic failure (asking for more than is
// on hand) BEFORE anything is written. A concurrent sale landing between validate
// and commit can still fail a later row — the RPC refuses rather than driving the
// branch negative, and the 409 names what did commit. Those stay committed:
// they are real stock movements, and silently reversing them would be worse.
// True all-or-nothing needs a commit_branch_return_batch(p_items jsonb) function.
router.post('/return', requireRole('super_admin', ...BRANCH_ROLES), validate(CreateBranchReturnSchema), requireInsideGeofence('stock.return'), async (req: AuthRequest, res, next) => {
  try {
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : ((req.body as { branchId?: string }).branchId ?? null);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const { items, reason } = req.body as { items: { productId: string; qty: number }[]; reason: string };

    await assertBusinessDayOpen(businessDateStr(), req.user!.role);

    // One query per entity rather than a pair per product: the product names come
    // back in a single `in` lookup however many rows the return carries.
    const productIds = items.map((i) => i.productId);
    const [branchRes, productsRes] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      supabaseAdmin.from('products').select('id, name').in('id', productIds),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productsRes.error) throw productsRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }

    const branchName = branchRes.data.name as string;
    const nameById = new Map((productsRes.data ?? []).map((p) => [p.id as string, p.name as string]));
    const missing = productIds.filter((id) => !nameById.has(id));
    if (missing.length) { res.status(400).json({ error: 'Product not found', details: missing }); return; }

    // PRE-VALIDATE EVERY ROW BEFORE WRITING ANYTHING. One balance read covers the
    // whole return, and every offending line is reported together — previously the
    // branch discovered an over-return one product at a time, after the earlier
    // ones had already moved.
    const stockRows = await computeStockRows(branchId);
    const balanceById = new Map(stockRows.map((r) => [r.productId, r.balance]));
    const shortfalls = items
      .map((it) => ({
        productId: it.productId,
        productName: nameById.get(it.productId)!,
        requested: it.qty,
        available: balanceById.get(it.productId) ?? 0,
      }))
      .filter((s) => s.requested > s.available);
    if (shortfalls.length) {
      res.status(409).json({
        error: 'Return quantity cannot be greater than available stock.',
        details: shortfalls,
      });
      return;
    }

    const now = new Date().toISOString();
    const committed: { id: string; productId: string; productName: string; qty: number }[] = [];

    for (const it of items) {
      const productName = nameById.get(it.productId)!;
      // One id per product, minted up front: it is the shared refId across branch
      // stock, the production pool and the record — and the idempotency key on
      // both stock_history and production_stock_history — so all three movements
      // for a product must agree on it, and two products must never share one.
      const returnId = randomUUID();

      // 1) Decrement branch stock (validates qty <= balance atomically).
      try {
        await commitBranchReturn({ branchId, productId: it.productId, productName, qty: it.qty, refId: returnId });
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          // Lost a race with a sale after the pre-check above. Report precisely
          // what already went through rather than pretending nothing happened.
          res.status(409).json({
            error: `Stock for ${productName} changed while the return was being saved.`,
            details: err.shortfalls,
            committed: committed.map((c) => ({ id: c.id, productName: c.productName, qty: c.qty })),
          });
          return;
        }
        throw err;
      }

      // 2) Add the units back into the central production pool (feeds "Returned").
      await returnIntoPool(returnId, { productId: it.productId, productName, qty: it.qty });

      committed.push({ id: returnId, productId: it.productId, productName, qty: it.qty });
    }

    // 3) Record accepted returns so they surface on the Production Returns page.
    //    One row per product (the table is product-scoped) but a single insert.
    //    Ids are supplied rather than generated, to match the refIds above.
    const { error: insertErr } = await supabaseAdmin.from('production_returns').insert(
      committed.map((c) => ({
        id: c.id,
        branch_id: branchId,
        branch_name: branchName,
        product_id: c.productId,
        product_name: c.productName,
        qty: c.qty,
        reason: reason || '',
        status: 'accepted',
        source: 'branch',
        business_date: businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
        reviewed_by: req.user!.uid,
        reviewed_by_name: req.user!.email,
        reviewed_at: now,
      })),
    );
    if (insertErr) throw insertErr;

    // 4) Notify Production in real time — ONCE for the whole return. branchId
    // null: production_user has no branch claim, and the notifications RLS filters
    // out a role broadcast whose branch_id doesn't match the recipient's. The
    // branch is named in the message.
    const totalUnits = committed.reduce((s, c) => s + c.qty, 0);
    await notify({
      type: 'production_return',
      title: 'Stock Returned',
      message: committed.length === 1
        ? `${committed[0].qty} × ${committed[0].productName} from ${branchName}`
        : `${committed.length} products (${totalUnits} units) from ${branchName}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: committed[0].id,
    });

    res.status(201).json({ ids: committed.map((c) => c.id) });
  } catch (err) {
    next(err);
  }
});
