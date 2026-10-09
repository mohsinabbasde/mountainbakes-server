import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { idempotent } from '../middleware/idempotency';
import {
  CreateSpecialOrderSchema,
  PrepareSpecialOrderSchema,
  VerifySpecialOrderSchema,
  BRANCH_ROLES,
  isBranchRole,
  businessDateStr,
  businessDaysAgoStr,
  type CreateSpecialOrderInput,
} from '../shared';
import { bindAttachments, listAttachmentsFor } from '../services/attachments.service';
import { notify } from '../services/push.service';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { rowToApi } from '../utils/case';
import { invalidate } from '../utils/cache';

const db = dbFor('special-orders');

/**
 * Special Orders — a branch's one-off, sent straight to Production.
 *
 *   POST /                branch raises it              → pending
 *   PUT  /:id/prepare     Production prepared it        → awaiting_verification
 *                                                         + PRODUCTION STOCK
 *   PUT  /:id/verify      branch verifies & approves,   → approved
 *                         WITH PHOTO                      + BRANCH STOCK
 *   PUT  /:id/approve     legacy only — finishes an order verified before
 *                         migration 145
 *
 * NOT a demand, and nothing here touches `production_orders`: see migration 143
 * for why that separation is structural rather than a flag. There is also no
 * stock endpoint in this file, by design — each stock movement is written by
 * the step that causes it (migration 145), so there is no second, manual way to
 * add the same units to either stock.
 *
 * Every state change is an RPC that does its own check-and-set in one
 * transaction; the handlers below authorise, validate and translate.
 */
export const router = Router();

router.use(authenticate);

const PRODUCTION_ROLES = ['super_admin', 'production_user'] as const;

/** Statuses still in somebody's queue — always listed, however old. */
const OPEN_STATUSES = ['pending', 'awaiting_verification', 'verified'] as const;

const ORDER_SELECT = `
  *,
  items:special_order_items(
    id, product_id, item_name, qty, prepared_qty, verified_qty, amount, description, line_no,
    stock_movement_id, stock_transaction_no
  )
`;

const ITEMS_ORDER = { referencedTable: 'special_order_items', ascending: true } as const;

/**
 * Hang both kinds of photo off a page of orders — two queries for the page, not
 * two per order. The request photo belongs to the ITEM; the verification photo
 * belongs to the ORDER, under a different entity. They are read separately and
 * returned under separate keys.
 */
async function toApi(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const orders = rowToApi<Record<string, unknown>[]>(rows);
  const itemIds = orders.flatMap((o) => ((o['items'] ?? []) as { id: string }[]).map((i) => i.id));

  const [requestPhotos, verificationPhotos] = await Promise.all([
    itemIds.length > 0 ? listAttachmentsFor('production_order_special_item', itemIds) : Promise.resolve(new Map()),
    orders.length > 0
      ? listAttachmentsFor('special_order_verification', orders.map((o) => String(o['id'])))
      : Promise.resolve(new Map()),
  ]);

  return orders.map(({ businessDate, ...o }) => {
    // numeric columns arrive from PostgREST as strings — coerce once, here.
    const qtyOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const items = ((o['items'] ?? []) as Record<string, unknown>[]).map((i) => ({
      ...i,
      qty: Number(i['qty'] ?? 0),
      preparedQty: qtyOrNull(i['preparedQty']),
      verifiedQty: qtyOrNull(i['verifiedQty']),
      amount: Number(i['amount'] ?? 0),
      requestPhotos: requestPhotos.get(String(i['id'])) ?? [],
    }));
    return {
      ...o,
      date: businessDate,
      items,
      totalAmount: items.reduce((sum, i) => sum + i.amount, 0),
      verificationPhotos: verificationPhotos.get(String(o['id'])) ?? [],
    };
  });
}

/** 404/409 for an RPC that refused because of where the order is in its life. */
function statusProblem(result: { status: string; current?: string }, wanted: string): { code: number; error: string } {
  if (result.status === 'not_found') return { code: 404, error: 'Special Order not found' };
  return { code: 409, error: `This Special Order is ${String(result.current).replace(/_/g, ' ')} — it must be ${wanted} first` };
}

// POST /api/special-orders — the branch raises a Special Order.
//
// `idempotent` makes this safe to retry: the mobile app queues it offline and
// re-sends under one Idempotency-Key until it lands, and a repeat replays the
// first response instead of raising a second order.
router.post('/', requireRole(...BRANCH_ROLES), idempotent('special_order.create'), validate(CreateSpecialOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    // The branch is the token's, never the body's.
    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { items, requiredDate, businessDate: claimedDate } = req.body as CreateSpecialOrderInput;

    // Every request photo is checked BEFORE the order is written. Binding
    // enforces the same three predicates (staged, this user's, this entity), but
    // it runs after the order exists — and a failure there would leave an order
    // saved while the caller is told it failed, which a retry then duplicates.
    const photoIds = [...new Set(items.flatMap((i) => i.attachmentIds ?? []))];
    if (photoIds.length > 0) {
      const { data: staged, error: stagedErr } = await db
        .from('attachments')
        .select('id')
        .in('id', photoIds)
        .eq('entity', 'production_order_special_item')
        .eq('uploaded_by', req.user!.uid)
        .is('entity_id', null);
      if (stagedErr) throw stagedErr;
      if ((staged ?? []).length !== photoIds.length) {
        res.status(409).json({ error: 'One of the attached photos is no longer available. Retake it and submit again.' });
        return;
      }
    }

    const businessDate = await resolveClientBusinessDate(claimedDate, req.user!.role, new Date());

    // Order + items + any hidden product, in one transaction. `amount` is sent
    // exactly as entered and stored on the item; nothing reads a price list.
    const { data, error } = await db.rpc('create_special_order', {
      p_branch_id: branchId,
      p_branch_name: req.user!.branchName || '',
      p_business_date: businessDate,
      p_created_by: req.user!.uid,
      p_created_by_name: req.user!.email,
      p_items: items.map((i) => ({ name: i.name, qty: i.qty, amount: i.amount, description: i.description ?? '' })),
      p_required_date: requiredDate ?? null,
    });
    if (error) throw error;

    const result = data as
      | { status: 'ok'; id: string; orderNumber: string; items: { id: string; lineNo: number }[] }
      | { status: 'invalid'; error: string };
    if (result.status === 'invalid') { res.status(400).json({ error: result.error }); return; }

    // A new special name mints a hidden product, which changes what
    // GET /api/products?includeSpecial=true returns.
    invalidate('products');

    // Each row's photo is bound to ITS item, matched by line number rather than
    // by array position.
    const itemIdByLine = new Map(result.items.map((i) => [i.lineNo, i.id]));
    for (const [idx, item] of items.entries()) {
      const itemId = itemIdByLine.get(idx + 1);
      if (!itemId || (item.attachmentIds ?? []).length === 0) continue;
      await bindAttachments({
        entity: 'production_order_special_item',
        entityId: itemId,
        attachmentIds: item.attachmentIds,
        actor: { uid: req.user!.uid },
      });
    }

    // branchId null for the reason production-orders.routes.ts gives: production
    // users carry no branch claim, and a branch-stamped role broadcast would be
    // filtered out for every one of them.
    await notify({
      type: 'production_demand',
      title: `SPECIAL ORDER ${result.orderNumber}`,
      message:
        `${req.user!.branchName || 'A branch'} sent a Special Order — ` +
        items.map((i) => `${i.name} × ${i.qty}`).join(', '),
      targetRole: 'production_user',
      branchId: null,
      relatedId: result.id,
    });

    res.status(201).json({ id: result.id, orderNumber: result.orderNumber });
  } catch (err) {
    next(err);
  }
});

// GET /api/special-orders — everything still open, plus the last 7 business
// days of finished ones. A branch role sees ONLY its own branch; that scope is
// the token's branch and cannot be widened by a query parameter.
router.get('/', requireRole(...BRANCH_ROLES, ...PRODUCTION_ROLES), async (req: AuthRequest, res, next) => {
  try {
    let query = db
      .from('special_orders')
      .select(ORDER_SELECT)
      .or(`status.in.(${OPEN_STATUSES.join(',')}),business_date.gte.${businessDaysAgoStr(6)}`)
      .order('submitted_at', { ascending: false })
      .order('line_no', ITEMS_ORDER);

    if (isBranchRole(req.user!.role)) {
      if (!req.user!.branchId) { res.json({ orders: [], total: 0 }); return; }
      query = query.eq('branch_id', req.user!.branchId);
    } else if (typeof req.query['branchId'] === 'string' && req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    const orders = await toApi((data ?? []) as Record<string, unknown>[]);
    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/special-orders/:id/prepare — Production marks it prepared and hands
// it to the branch to verify. The prepared quantity goes into Production Stock
// here, in the same transaction — nobody enters it into stock separately.
//
// The body is optional: with none, every item is prepared in full. A prepared
// quantity is stored beside the requested one, never over it.
router.put('/:id/prepare', requireRole(...PRODUCTION_ROLES), validate(PrepareSpecialOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { items = [] } = req.body as { items?: { itemId: string; preparedQty: number }[] };
    const { data, error } = await db.rpc('prepare_special_order', {
      p_order_id: id,
      p_by: req.user!.uid,
      p_by_name: req.user!.email,
      p_items: items,
      p_business_date: businessDateStr(),
    });
    if (error) throw error;

    const result = data as { status: string; current?: string; error?: string; branchId?: string; orderNumber?: string };
    if (result.status === 'invalid') { res.status(400).json({ error: result.error }); return; }
    if (result.status !== 'ok') {
      const p = statusProblem(result, 'waiting for preparation');
      res.status(p.code).json({ error: p.error });
      return;
    }

    await notify({
      type: 'production_reviewed',
      title: `Special Order ${result.orderNumber} Prepared — Please Verify`,
      message: 'Production has prepared your Special Order. Check what you received and upload a photo to verify — it is added to your stock when you do.',
      targetRole: 'branch_manager',
      branchId: result.branchId!,
      relatedId: id,
    });

    res.json({ success: true, status: 'awaiting_verification' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/special-orders/:id/verify — the branch's VERIFY & APPROVE: it
// confirms what it received and attaches its photo. Scoped to the owning branch.
// This is the step that puts the item in BRANCH STOCK, where it is sold from.
//
// Safe to repeat. `idempotent` replays the first answer to a re-send under the
// same key (the offline queue), and without a key a repeat — a second tap on a
// slow connection — is answered as the success it already was, without touching
// a ledger. Either way branch stock is credited once.
router.put('/:id/verify', requireRole(...BRANCH_ROLES), idempotent('special_order.verify'), validate(VerifySpecialOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { attachmentIds, items = [] } = req.body as {
      attachmentIds: string[];
      items?: { itemId: string; receivedQty: number }[];
    };

    // Checked before the photo is bound, so a photo can never be attached to
    // another branch's order or to one that is not waiting for it. The RPC
    // re-checks all of this under a row lock; this read is what keeps a refused
    // request from leaving a bound photo behind.
    const { data: order, error: orderErr } = await db
      .from('special_orders')
      .select('id, branch_id, status')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Special Order not found' }); return; }
    if (!req.user!.branchId || order.branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'This Special Order belongs to a different branch' });
      return;
    }
    // Already done — by an earlier tap or an earlier attempt of this request.
    if (order.status === 'approved') {
      res.json({ success: true, status: 'approved', alreadyVerified: true });
      return;
    }
    if (order.status !== 'awaiting_verification') {
      const p = statusProblem({ status: 'invalid_status', current: order.status as string }, 'prepared by Production');
      res.status(p.code).json({ error: p.error });
      return;
    }

    // A retry after a half-finished attempt arrives with photos this order
    // already holds. Bind only the ones it does not, so the retry completes
    // instead of failing on its own earlier success.
    const { data: already, error: alreadyErr } = await db
      .from('attachments')
      .select('id')
      .in('id', attachmentIds)
      .eq('entity', 'special_order_verification')
      .eq('entity_id', id);
    if (alreadyErr) throw alreadyErr;
    const bound = new Set((already ?? []).map((a) => a.id as string));

    await bindAttachments({
      entity: 'special_order_verification',
      entityId: id,
      attachmentIds: attachmentIds.filter((a) => !bound.has(a)),
      actor: { uid: req.user!.uid },
    });

    const { data, error } = await db.rpc('verify_special_order', {
      p_order_id: id,
      p_branch_id: req.user!.branchId,
      p_by: req.user!.uid,
      p_by_name: req.user!.email,
      p_items: items,
      p_business_date: businessDateStr(),
    });
    if (error) throw error;

    const result = data as {
      status: string;
      current?: string;
      error?: string;
      orderNumber?: string;
      movements?: { itemName: string; requestedQty: number | string; preparedQty: number | string; verifiedQty: number | string }[];
    };
    if (result.status === 'already_verified') {
      res.json({ success: true, status: 'approved', alreadyVerified: true });
      return;
    }
    if (result.status === 'invalid') { res.status(400).json({ error: result.error }); return; }
    if (result.status === 'forbidden') {
      res.status(403).json({ error: 'This Special Order belongs to a different branch' });
      return;
    }
    if (result.status === 'photo_required') {
      res.status(400).json({ error: 'A verification photo is required' });
      return;
    }
    if (result.status !== 'ok') {
      const p = statusProblem(result, 'prepared by Production');
      res.status(p.code).json({ error: p.error });
      return;
    }

    const movements = (result.movements ?? []).map((m) => ({
      itemName: m.itemName,
      requestedQty: Number(m.requestedQty),
      preparedQty: Number(m.preparedQty),
      verifiedQty: Number(m.verifiedQty),
    }));

    await notify({
      type: 'production_order_verified',
      title: `Special Order ${result.orderNumber} Verified & Approved`,
      message:
        `${req.user!.branchName || 'A branch'} verified its Special Order with a photo — ` +
        movements.map((m) => `${m.itemName}: received ${m.verifiedQty} of ${m.preparedQty} prepared`).join(' · '),
      targetRole: 'production_user',
      branchId: null,
      relatedId: id,
    });

    res.json({ success: true, status: 'approved', movements });
  } catch (err) {
    next(err);
  }
});

// PUT /api/special-orders/:id/approve — LEGACY. Finishes an order that was
// verified before migration 145 and is still waiting on Production: it flips
// verified → approved and books that order's stock in one transaction
// (migration 144). Nothing raised since can reach 'verified' — the branch's own
// verification now approves the order and moves its stock — so for a new order
// this route has nothing to do and refuses.
//
// Safe to retry. The RPC only acts on a 'verified' order, so a repeat finds it
// already 'approved', moves nothing, and is answered as the success it already
// was — never a second stock movement, and not an error the caller has to
// puzzle over.
router.put('/:id/approve', requireRole(...PRODUCTION_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { data, error } = await db.rpc('approve_special_order', {
      p_order_id: id,
      p_by: req.user!.uid,
      p_by_name: req.user!.email,
      p_business_date: businessDateStr(),
    });
    if (error) throw error;

    const result = data as {
      status: string;
      current?: string;
      branchId?: string;
      orderNumber?: string;
      movements?: { itemName: string; qty: number | string; stockTransactionNo: string | null }[];
    };

    if (result.status === 'invalid_status' && result.current === 'approved') {
      res.json({ success: true, status: 'approved', alreadyApproved: true });
      return;
    }
    if (result.status !== 'ok') {
      const p = statusProblem(result, 'verified by the branch');
      res.status(p.code).json({ error: p.error });
      return;
    }

    await notify({
      type: 'production_reviewed',
      title: `Special Order ${result.orderNumber} Approved`,
      message: 'Your verified Special Order has been approved and added to your stock.',
      targetRole: 'branch_manager',
      branchId: result.branchId!,
      relatedId: id,
    });

    res.json({
      success: true,
      status: 'approved',
      movements: (result.movements ?? []).map((m) => ({ ...m, qty: Number(m.qty) })),
    });
  } catch (err) {
    next(err);
  }
});
