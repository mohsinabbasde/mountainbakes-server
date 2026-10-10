import { Router } from 'express';
import { randomUUID } from 'crypto';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { idempotent } from '../middleware/idempotency';
import { TransferReturnStockSchema, businessDateStr, type TransferReturnStockInput } from '../shared';
import {
  getReturnStockRows,
  getReturnStockMovements,
  transferReturnStockToProduction,
  InsufficientReturnStockError,
} from '../services/return-stock.service';

const db = dbFor('return-stock');

export const router = Router();

// Branch Return Stock — the inventory of goods branches sent back. A separate
// surface from /api/production-stock on purpose: the two balances are never
// served as one number.
router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/return-stock?date=YYYY-MM-DD — return stock table (defaults to today)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const date = typeof req.query['date'] === 'string' && req.query['date'] ? String(req.query['date']) : businessDateStr();
    const rows = await getReturnStockRows(date);
    res.json({ rows, date });
  } catch (err) {
    next(err);
  }
});

// GET /api/return-stock/movements — the Return Stock ledger, newest first.
router.get('/movements', async (req: AuthRequest, res, next) => {
  try {
    const str = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : undefined);
    const num = (k: string) => (str(k) !== undefined && Number.isFinite(Number(str(k))) ? Number(str(k)) : undefined);
    const type = str('type');
    if (type !== undefined && type !== 'return_in' && type !== 'transfer_out') {
      res.status(400).json({ error: 'type must be return_in or transfer_out' });
      return;
    }
    const from = str('from'), to = str('to'), productId = str('productId'), branchId = str('branchId');
    const limit = num('limit'), offset = num('offset');
    const result = await getReturnStockMovements({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(productId ? { productId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(type ? { type } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/return-stock/transfer — move units from Return Stock into Production
// Stock. The ONLY way a returned unit becomes production stock, so it is
// admin-only, needs a reason, and is refused beyond what Return Stock holds.
//
// The Idempotency-Key, when sent, is also the ledger ref: a retried request is
// replayed by the middleware, and one that slips past it still cannot move the
// units twice because both ledgers key on the same ref.
router.post('/transfer', requireRole('super_admin'), idempotent('return-stock.transfer'), validate(TransferReturnStockSchema), async (req: AuthRequest, res, next) => {
  try {
    const { productId, qty, reason } = req.body as TransferReturnStockInput;

    const { data: product, error: prodErr } = await db
      .from('products')
      .select('id, name')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) { res.status(400).json({ error: `Product ${productId} not found` }); return; }

    const key = req.header('Idempotency-Key');
    const refId = `return_transfer:${key ?? randomUUID()}`;

    const result = await transferReturnStockToProduction({
      productId,
      productName: product.name as string,
      qty,
      reason,
      refId,
      actorId: req.user!.uid,
      actorName: req.user!.email,
    });

    res.status(201).json({ id: refId, productId, qty, ...result });
  } catch (err) {
    if (err instanceof InsufficientReturnStockError) {
      res.status(409).json({
        error: err.message,
        code: 'INSUFFICIENT_RETURN_STOCK',
        requested: err.requested,
        available: err.available,
      });
      return;
    }
    next(err);
  }
});
