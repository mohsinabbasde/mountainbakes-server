import { Router } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  PrepareProductionSchema,
  CreateProductionAdjustmentSchema,
  ProductionMovementQuerySchema,
  businessDateStr,
  type ProductionAdjustmentType,
} from '../shared';
import {
  prepareProducts,
  getProductionStockRows,
  getProductionStockFigures,
  getProductionAvailability,
  recordProductionAdjustment,
  CorrectionUnavailableError,
} from '../services/production-stock.service';
import { getStockLedger, getProductDayLedger } from '../services/production-ledger.service';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-stock?date=YYYY-MM-DD — production pool table (defaults to today)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const date = typeof req.query['date'] === 'string' && req.query['date'] ? String(req.query['date']) : businessDateStr();
    const rows = await getProductionStockRows(date);
    res.json({ rows, date });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-stock/prepare — record "Today's Prepared Products"
router.post('/prepare', validate(PrepareProductionSchema), async (req: AuthRequest, res, next) => {
  try {
    const { items } = req.body as { items: { productId: string; qty: number }[] };

    // Resolve product names server-side (names/prices are Admin-owned). One query
    // rather than N point reads.
    const productIds = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    const resolved = items.map((i) => {
      const name = nameById.get(i.productId);
      if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return { productId: i.productId, productName: name, qty: i.qty };
    });

    // A fresh id per submission keeps each prep batch idempotent yet additive
    // (the ref_id half of the production_stock_history idempotency key).
    const refId = randomUUID();
    await prepareProducts(refId, resolved, { id: req.user!.uid, name: req.user!.email });

    res.status(201).json({ id: refId, count: resolved.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-stock/movements — the Stock Ledger (§13).
//
// Every filter and the free-text search are applied server-side; see
// production-ledger.service.ts for why the page must never filter a full
// download. Paged, newest first.
router.get('/movements', async (req: AuthRequest, res, next) => {
  try {
    const q = ProductionMovementQuerySchema.parse(req.query);
    res.json(await getStockLedger(q));
  } catch (err) {
    next(err);
  }
});

// GET /api/production-stock/movements/:productId — one product, one day, as §14
// draws it: OPENING, the day's movements, any outstanding reservation, CLOSING.
router.get('/movements/:productId', async (req: AuthRequest, res, next) => {
  try {
    const productId = req.params['productId']!;
    const date = typeof req.query['date'] === 'string' && req.query['date']
      ? String(req.query['date'])
      : businessDateStr();
    const [figures, movements] = await Promise.all([
      getProductionStockFigures(productId, date),
      getProductDayLedger(productId, date),
    ]);
    res.json({ productId, date, figures, movements });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-stock/availability — balance / reserved / available per
// product, from the one SQL definition the counter sale and demand guard share.
router.get('/availability', async (_req: AuthRequest, res, next) => {
  try {
    const map = await getProductionAvailability();
    res.json({
      rows: [...map.entries()].map(([productId, v]) => ({ productId, ...v })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-stock/adjustment — an authorised manual correction (§11).
//
// Books ONE signed movement with a mandatory reason. It does not, and cannot, set
// a balance: §38's rule is that stock is never a collection of editable numbers,
// so a wrong figure is answered with another movement and the original stays in
// the audit trail.
router.post('/adjustment', validate(CreateProductionAdjustmentSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as {
      productId: string;
      adjustmentType: ProductionAdjustmentType;
      qty: number;
      reason: string;
      remarks?: string;
      approvedBy?: string;
    };

    // The name is resolved here, not taken from the client — the ledger keeps a
    // name snapshot and it should read as the name at the time of the adjustment.
    const { data: product, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .eq('id', body.productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

    const result = await recordProductionAdjustment({
      productId: body.productId,
      productName: product.name as string,
      qty: body.qty,
      adjustmentType: body.adjustmentType,
      reason: body.reason,
      remarks: body.remarks,
      approvedBy: body.approvedBy,
      actorId: req.user!.uid,
      actorName: req.user!.email,
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof CorrectionUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    next(err);
  }
});
