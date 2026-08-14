import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionOrderSchema,
  ReviewProductionOrderSchema,
  AddProductionOrderItemSchema,
  VerifyProductionOrderSchema,
  businessDateStr,
  businessDaysAgoStr,
  karachiTimeStr,
  karachiMinutesOfDay,
  isWithinOrderWindow,
  BRANCH_ROLES,
  isBranchRole,
  resolveShareSplit,
} from '../shared';
import { bindAttachments, listAttachmentsFor } from '../services/attachments.service';
import { notify } from '../services/push.service';
import { applyProductionToStock } from '../services/stock.service';
import { transferOutOnApproval } from '../services/production-stock.service';
import { getAppSettings, orderWindowMinutes } from '../services/settings.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { rowToApi } from '../utils/case';

export const router = Router();

/**
 * The branch-submitted items live in their own `production_order_items` table
 * (migration 05). The review-only columns are null until approval, which is what
 * `approved_qty IS NULL` means.
 *
 * Callers must also order the embedded rows by line_no — PostgREST gives no
 * ordering guarantee for an embedded resource on its own.
 */
const ORDER_SELECT = `
  *,
  items:production_order_items(
    product_id, product_name, qty, remarks,
    previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
  ),
  packingItems:production_order_packing_items(
    packing_material_id, material_name, qty, approved_qty, line_no
  )
`;

const ITEMS_ORDER = { referencedTable: 'production_order_items', ascending: true } as const;

/** Packing lines need their own ordering clause — see the ORDER_SELECT note above. */
const PACKING_ITEMS_ORDER = { referencedTable: 'production_order_packing_items', ascending: true } as const;

/**
 * Hang the demand and verification photos off a page of orders.
 *
 * Two queries and two signing calls for the whole page rather than per order —
 * an order list runs to a week of demands across every branch, and per-row
 * signing would dominate the response time. Photos are NOT part of ORDER_SELECT
 * because `attachments` has no foreign key to `production_orders` (the parent
 * table is chosen by `entity`), so PostgREST cannot embed it.
 */
async function withPhotos(orders: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const ids = orders.map((o) => String(o['id']));
  const [demand, verification] = await Promise.all([
    listAttachmentsFor('production_order_demand', ids),
    listAttachmentsFor('production_order_verification', ids),
  ]);
  return orders.map((o) => ({
    ...o,
    demandPhotos: demand.get(String(o['id'])) ?? [],
    verificationPhotos: verification.get(String(o['id'])) ?? [],
  }));
}

router.use(authenticate);

// POST /api/production-orders — branch submits a daily production request
router.post('/', requireRole(...BRANCH_ROLES), validate(CreateProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    // Branch production requests are only accepted inside the configured order
    // window (default 8:00 AM–2:00 AM Karachi, which wraps past midnight).
    const settings = await getAppSettings();
    const { openMin, closeMin } = orderWindowMinutes(settings);
    if (!isWithinOrderWindow(karachiMinutesOfDay(), openMin, closeMin)) {
      res.status(403).json({ error: `Ordering time has ended. New production orders will open again at ${settings.orderStartTime}.` });
      return;
    }

    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { items, packingItems = [], attachmentIds } = req.body as {
      items: { productId: string; qty: number; remarks: string }[];
      packingItems?: { packingMaterialId: string; qty: number }[];
      attachmentIds: string[];
    };

    // Resolve product names server-side — branch users never send names or
    // prices, those are Admin-controlled. One query rather than N point reads.
    const productIds = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    const resolvedItems = items.map((i) => {
      const name = nameById.get(i.productId);
      if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return { productId: i.productId, productName: name, qty: i.qty, remarks: i.remarks || '' };
    });

    // Same treatment for packing materials, with one extra condition: the query
    // filters on is_active, so an inactive material fails the name lookup below and
    // is rejected. The client's list can be stale (a material disabled while the
    // form was open), so "only active materials can be selected" has to be decided
    // here, not in the dropdown.
    let resolvedPacking: { packingMaterialId: string; materialName: string; qty: number }[] = [];
    if (packingItems.length > 0) {
      const materialIds = [...new Set(packingItems.map((i) => i.packingMaterialId))];
      const { data: materials, error: matErr } = await supabaseAdmin
        .from('packing_materials')
        .select('id, material_name')
        .eq('is_active', true)
        .in('id', materialIds);
      if (matErr) throw matErr;

      const materialNameById = new Map(
        (materials ?? []).map((m) => [m.id as string, m.material_name as string]),
      );
      resolvedPacking = packingItems.map((i) => {
        const name = materialNameById.get(i.packingMaterialId);
        if (!name) {
          throw Object.assign(
            new Error('One of the selected packing materials is no longer available. Please refresh and try again.'),
            { status: 400 },
          );
        }
        return { packingMaterialId: i.packingMaterialId, materialName: name, qty: i.qty };
      });
    }

    const now = new Date();
    await assertBusinessDayOpen(businessDateStr(now), req.user!.role);

    // submitted_at / created_at come from column defaults.
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('production_orders')
      .insert({
        branch_id: branchId,
        branch_name: req.user!.branchName || '',
        business_date: businessDateStr(now),
        submitted_time: karachiTimeStr(now),
        status: 'pending',
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (orderErr) throw orderErr;

    // Review-only columns stay null until approval.
    const { error: itemsErr } = await supabaseAdmin.from('production_order_items').insert(
      resolvedItems.map((it, idx) => ({
        production_order_id: order.id,
        product_id: it.productId,
        product_name: it.productName,
        qty: it.qty,
        remarks: it.remarks,
        line_no: idx + 1,
      })),
    );
    if (itemsErr) throw itemsErr;

    // Packing lines ride on the same order. approved_qty stays null until review,
    // exactly like the product lines' review-only columns.
    if (resolvedPacking.length > 0) {
      const { error: packErr } = await supabaseAdmin.from('production_order_packing_items').insert(
        resolvedPacking.map((it, idx) => ({
          production_order_id: order.id,
          packing_material_id: it.packingMaterialId,
          material_name: it.materialName,
          qty: it.qty,
          line_no: idx + 1,
        })),
      );
      if (packErr) throw packErr;
    }

    // Claim the photos the branch captured while filling the form. Done before
    // the notification so Production is never told about a demand whose photo
    // failed to bind — the whole point of the notification is "come and look at
    // this", and there would be nothing to look at.
    await bindAttachments({
      entity: 'production_order_demand',
      entityId: order.id,
      attachmentIds,
      actor: { uid: req.user!.uid },
    });

    // NOTE: branchId is deliberately null here. Production users are a central
    // role with no branch claim (only branch_manager carries a branchId), and the
    // notifications RLS narrows a role broadcast that carries a branch_id to that
    // branch — so setting branchId to the submitting branch would filter this out
    // for every production user. The branch is already named in the message and
    // linked via relatedId. Keep it null so all production users see the demand.
    await notify({
      type: 'production_demand',
      title: 'New Production Demand Received',
      message:
        `${req.user!.branchName || 'A branch'} submitted ${resolvedItems.length} item${resolvedItems.length === 1 ? '' : 's'}` +
        (resolvedPacking.length > 0
          ? ` and ${resolvedPacking.length} packing material${resolvedPacking.length === 1 ? '' : 's'}`
          : ''),
      targetRole: 'production_user',
      branchId: null,
      relatedId: order.id,
    });

    res.status(201).json({ id: order.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders — last 7 business days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // The 7-day cutoff is an indexed predicate now; it used to fetch the branch's
    // entire history and filter in memory.
    let query = supabaseAdmin
      .from('production_orders')
      .select(ORDER_SELECT)
      .gte('business_date', businessDaysAgoStr(6)) // inclusive last 7 business days
      .order('submitted_at', { ascending: false })
      .order('line_no', ITEMS_ORDER)
      .order('line_no', PACKING_ITEMS_ORDER);

    if (isBranchRole(req.user!.role) && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    // DB columns are business_date / submitted_time; the API contract
    // (BranchProductionOrder) exposes them as date / time. rowToApi only
    // camelCases keys, so remap those two here — otherwise the client's
    // date/time are undefined (blank columns, and slipReference → "PO--").
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const orders = await withPhotos(
      rows.map(({ businessDate, submittedTime, ...rest }) => ({
        ...rest,
        date: businessDate,
        time: submittedTime,
      })),
    );
    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/balances — outstanding pending balances per product.
// Branch managers are scoped to their own branch; others may pass ?branchId=.
// Defined as a literal path (no GET '/:id' route exists) so it never shadows.
router.get('/balances', async (req: AuthRequest, res, next) => {
  try {
    // pending_qty > 0 is served by production_balances_outstanding_idx.
    let query = supabaseAdmin.from('production_balances').select('*').gt('pending_qty', 0);

    if (isBranchRole(req.user!.role) && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ balances: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/:id/previous-balance — what the branch owes for its
// PREVIOUS delivery, for the company copy of this order's slip.
//
// Deliberately NOT production_balances: that table is unmet demand (goods the
// branch asked for and Production could not supply), i.e. value owed TO the
// branch — the opposite direction from a receivable.
//
// Bills the IMMEDIATELY PRECEDING delivered order, not the previous business
// day's total, and that distinction is load-bearing: branches routinely take
// several deliveries in one day (four on 2026-08-09 for one branch). Billing a
// day's total would reprint the same figure on every slip that day and invite
// collecting it more than once, whereas chaining slip→previous order bills each
// delivery exactly once. The tradeoff accepted here is that a slip can bill
// goods delivered only hours earlier rather than strictly "yesterday".
//
// Computed server-side because the company share lives in finance_settings (and
// per branch on branches.company_share_pct), and production users have no access
// to the finance module at any layer — only the service-role client can read it.
// The money maths stays server-side with it.
//
// NOTE: nothing records whether a previous order was actually settled, so this
// reports the same figure on every reprint. It is a "what this order was worth"
// statement, not a live outstanding balance.
router.get('/:id/previous-balance', requireRole('super_admin', 'production_user'), async (req, res, next) => {
  try {
    const id = req.params['id']!;

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('production_orders')
      .select('id, branch_id, business_date, submitted_at')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Production order not found' }); return; }

    // Only a DELIVERED order can be owed for. 'pending' shipped nothing yet and
    // 'rejected' never will, so both are skipped when walking back.
    const { data: prev, error: prevErr } = await supabaseAdmin
      .from('production_orders')
      .select('id, demand_number, business_date, submitted_at, items:production_order_items(product_id, approved_qty)')
      .eq('branch_id', order.branch_id)
      .in('status', ['awaiting_verification', 'approved'])
      .lt('submitted_at', order.submitted_at)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevErr) throw prevErr;

    // The branch's own percentage where it has one, the global finance setting
    // where it does not (migration 68) — the same resolution branch-income
    // approval uses, so the slip bills at the terms the branch is actually on.
    const [{ data: fin, error: finErr }, { data: branchRow, error: branchErr }] = await Promise.all([
      supabaseAdmin.from('finance_settings').select('company_share_pct').maybeSingle(),
      supabaseAdmin.from('branches').select('company_share_pct').eq('id', order.branch_id).maybeSingle(),
    ]);
    if (finErr) throw finErr;
    if (branchErr) throw branchErr;
    const { companySharePct } = resolveShareSplit(
      (branchRow?.company_share_pct ?? null) as number | null,
      Number(fin?.company_share_pct ?? 75),
    );

    if (!prev) {
      res.json({
        previous: null, deliveredValue: 0, companySharePct,
        companyShareValue: 0, returnsValue: 0, returnItems: [], amountToCollect: 0,
      });
      return;
    }

    const prevItems = (prev.items ?? []) as { product_id: string | null; approved_qty: number | string | null }[];
    const productIds = [...new Set(prevItems.map((i) => i.product_id).filter((p): p is string => !!p))];

    let deliveredValue = 0;
    if (productIds.length > 0) {
      const { data: products, error: prodErr } = await supabaseAdmin
        .from('products')
        .select('id, price')
        .in('id', productIds);
      if (prodErr) throw prodErr;
      const priceById = new Map((products ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
      deliveredValue = prevItems.reduce(
        (a, i) => a + Number(i.approved_qty ?? 0) * (i.product_id ? (priceById.get(i.product_id) ?? 0) : 0),
        0,
      );
    }

    // Returns that came back during the period this slip bills for: after the
    // previous order was placed, up to and including this one.
    //
    // Windowed on the billing period rather than on "the previous calendar day",
    // which is what this did first and which was wrong twice over. Branches take
    // several deliveries a day, so a day-based rule (a) credited returns against
    // an order they had nothing to do with, and worse (b) re-credited the SAME
    // returns on every slip of that day — four orders, one return deducted four
    // times. Bounding by the two orders' timestamps partitions returns exactly:
    // each falls in one window, so it is deducted once and never lost.
    const { data: returns, error: retErr } = await supabaseAdmin
      .from('production_returns')
      .select('product_id, product_name, qty')
      .eq('branch_id', order.branch_id)
      .eq('status', 'accepted')
      .gt('created_at', prev.submitted_at)
      .lte('created_at', order.submitted_at);
    if (retErr) throw retErr;

    let returnsValue = 0;
    let returnItems: { productName: string; qty: number; amount: number }[] = [];
    const returnRows = (returns ?? []) as { product_id: string; product_name: string; qty: number | string }[];
    if (returnRows.length > 0) {
      const retIds = [...new Set(returnRows.map((r) => r.product_id))];
      const { data: retProducts, error: retProdErr } = await supabaseAdmin
        .from('products')
        .select('id, price')
        .in('id', retIds);
      if (retProdErr) throw retProdErr;
      const retPriceById = new Map((retProducts ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
      // Itemised here rather than re-derived on the client, so the lines the slip
      // prints are by construction the ones the total was built from.
      returnItems = returnRows.map((r) => ({
        productName: r.product_name,
        qty: Number(r.qty ?? 0),
        amount: Number(r.qty ?? 0) * (retPriceById.get(r.product_id) ?? 0),
      }));
      returnsValue = returnItems.reduce((a, r) => a + r.amount, 0);
    }

    const companyShareValue = (deliveredValue * companySharePct) / 100;

    res.json({
      previous: { demandNumber: prev.demand_number, date: prev.business_date },
      deliveredValue,
      companySharePct,
      companyShareValue,
      returnsValue,
      returnItems,
      amountToCollect: companyShareValue - returnsValue,
    });
  } catch (err) {
    next(err);
  }
});

interface ReviewedItem {
  productId: string;
  productName: string;
  qty: number;
  previousBalanceQty: number;
  totalRequiredQty: number;
  approvedQty: number;
  remainingBalanceQty: number;
}

/** No balance fields: packing materials carry nothing forward (migration 39). */
interface ReviewedPackingItem {
  packingMaterialId: string;
  materialName: string;
  qty: number;
  approvedQty: number;
}

// PUT /api/production-orders/:id/review — production/admin submits for
// verification, or rejects. 'awaiting_verification' still transfers stock to
// the branch immediately (unchanged) — the branch's own /verify step is what
// finally moves the order to 'approved'.
router.put('/:id/review', requireRole('super_admin', 'production_user'), validate(ReviewProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status: rawStatus, approvedItems, approvedPackingItems, reason } = req.body as {
      status: 'awaiting_verification' | 'approved' | 'rejected';
      approvedItems?: { productId: string; approvedQty: number }[];
      approvedPackingItems?: { packingMaterialId: string; approvedQty: number }[];
      reason?: string;
    };
    const id = req.params['id']!;

    // Legacy alias: a still-cached old web bundle sends 'approved' for what is
    // now 'awaiting_verification'. Normalise it so those clients keep working
    // until they reload — see ReviewProductionOrderSchema.
    const status = rawStatus === 'approved' ? 'awaiting_verification' : rawStatus;

    // Status check-and-set, balance carry-forward and the item rewrite all happen
    // inside review_production_order (migration 16) — they must be one
    // transaction or a double review would apply the balance maths twice.
    const { data, error } = await supabaseAdmin.rpc('review_production_order', {
      p_order_id: id,
      p_status: status,
      p_overrides: approvedItems ?? [],
      p_reason: reason ?? null,
      p_reviewed_by: req.user!.uid,
      p_reviewed_by_name: req.user!.email,
      p_packing_overrides: approvedPackingItems ?? [],
    });
    if (error) throw error;

    const result = data as
      | {
          status: 'ok';
          branchId: string;
          branchName: string | null;
          items: ReviewedItem[];
          packingItems: ReviewedPackingItem[];
        }
      | { status: 'not_found' }
      | { status: 'already_reviewed' };

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Production order not found' });
      return;
    }
    if (result.status === 'already_reviewed') {
      res.status(409).json({ error: 'Order already reviewed' });
      return;
    }

    // NO stock movement here any more (migration 58). The pool is debited when
    // the branch verifies what physically arrived, for the quantity it actually
    // counted — so this step is paperwork, and there is no window where branch
    // stock claims goods nobody has confirmed receiving.

    // Notify the branch with a per-product Total Required / Approved / Pending summary.
    const productSummary = result.items
      .map((it) => `${it.productName}: Required ${it.totalRequiredQty}, Approved ${it.approvedQty}, Pending ${it.remainingBalanceQty}`)
      .join(' · ');
    // Packing lines have no Required/Pending — there is no carry-forward — so they
    // report just what was asked for and what was approved.
    const packingSummary = (result.packingItems ?? [])
      .map((it) => `${it.materialName}: Requested ${it.qty}, Approved ${it.approvedQty}`)
      .join(' · ');

    const message =
      status === 'awaiting_verification'
        ? [productSummary, packingSummary && `Packing — ${packingSummary}`, 'Please check items received and verify.']
            .filter(Boolean)
            .join(' | ')
        : 'Your production order was rejected';

    await notify({
      type: 'production_reviewed',
      title: status === 'awaiting_verification' ? 'Production Order Sent — Please Verify' : 'Production Order Rejected',
      message,
      targetRole: 'branch_manager',
      branchId: result.branchId,
      relatedId: id,
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/printed — mark the slip printed. Idempotent;
// printing never mutates stock or creates records, so re-printing is a safe no-op.
router.put('/:id/printed', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { data, error } = await supabaseAdmin
      .from('production_orders')
      .update({ printed: true, printed_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Production order not found' }); return; }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-orders/:id/items — Production adds an extra line to a
// still-'pending' order before submitting it for verification. Once submitted
// the order's items are frozen by review_production_order; this only inserts,
// it never touches stock (that happens for every item, old and new, in the
// same /review transfer once the order is submitted).
router.post('/:id/items', requireRole('super_admin', 'production_user'), validate(AddProductionOrderItemSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { productId, qty, remarks } = req.body as { productId: string; qty: number; remarks: string };

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('production_orders')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Production order not found' }); return; }
    if (order.status !== 'pending') {
      res.status(409).json({ error: 'This order has already been submitted — items can no longer be added' });
      return;
    }

    const { data: product, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('name')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) { res.status(400).json({ error: 'Product not found' }); return; }

    const { data: maxRow, error: maxErr } = await supabaseAdmin
      .from('production_order_items')
      .select('line_no')
      .eq('production_order_id', id)
      .order('line_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw maxErr;
    const nextLineNo = (maxRow?.line_no ?? 0) + 1;

    const { error: insErr } = await supabaseAdmin.from('production_order_items').insert({
      production_order_id: id,
      product_id: productId,
      product_name: product.name,
      qty,
      remarks: remarks || '',
      line_no: nextLineNo,
    });
    if (insErr) throw insErr;

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/verify — the branch confirms what it
// physically received against an 'awaiting_verification' demand, correcting
// any shortage/overage and/or adding lines that arrived unrequested. Moves the
// order to 'approved'. Scoped to the branch that owns the order — a branch
// manager can only verify their own branch's demands.
router.put('/:id/verify', requireRole(...BRANCH_ROLES), validate(VerifyProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { verifiedItems, newItems, attachmentIds } = req.body as {
      verifiedItems: { productId: string; verifiedQty: number }[];
      newItems: { productId: string; qty: number }[];
      attachmentIds: string[];
    };

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('production_orders')
      .select('id, branch_id, status')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Production order not found' }); return; }
    if (order.branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'This demand belongs to a different branch' });
      return;
    }

    // newItems only carry a productId from the client — resolve names the same
    // way order creation and /items do, so a stale/tampered name can never land.
    let resolvedNewItems: { productId: string; productName: string; qty: number }[] = [];
    if (newItems.length > 0) {
      const productIds = [...new Set(newItems.map((i) => i.productId))];
      const { data: products, error: prodErr } = await supabaseAdmin
        .from('products')
        .select('id, name')
        .in('id', productIds);
      if (prodErr) throw prodErr;
      const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
      resolvedNewItems = newItems.map((i) => {
        const name = nameById.get(i.productId);
        if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
        return { productId: i.productId, productName: name, qty: i.qty };
      });
    }

    // Bound BEFORE the RPC, unlike the demand photos on create.
    //
    // Verification is the step that moves stock. If binding ran after it and
    // failed, the goods would already be in branch inventory with no photo of
    // what arrived — the exact gap this feature exists to close, and
    // unrecoverable because the order is no longer 'awaiting_verification'.
    // Running it first means a binding failure aborts with nothing done.
    //
    // The cost is that a caller who loses the race — the RPC then answers
    // 'already_reviewed' — leaves its photos attached to an order someone else
    // verified. They are photos of the same delivery, so they belong there
    // anyway; the alternative is the failure mode above.
    await bindAttachments({
      entity: 'production_order_verification',
      entityId: id,
      attachmentIds,
      actor: { uid: req.user!.uid },
    });

    const { data, error } = await supabaseAdmin.rpc('verify_production_order', {
      p_order_id: id,
      p_verified_items: verifiedItems.map((v) => ({ productId: v.productId, verifiedQty: v.verifiedQty })),
      p_new_items: resolvedNewItems,
      p_verified_by: req.user!.uid,
      p_verified_by_name: req.user!.email,
    });
    if (error) throw error;

    const result = data as
      | { status: 'ok'; branchId: string; branchName: string | null; items: { productId: string; productName: string; qty: number }[] }
      | { status: 'not_found' }
      | { status: 'already_reviewed' };

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Production order not found' });
      return;
    }
    if (result.status === 'already_reviewed') {
      res.status(409).json({ error: 'This order is not awaiting verification (already verified, or not yet submitted)' });
      return;
    }

    // THE stock movement for this order — not a correction on top of an earlier
    // one. /review no longer moves anything, so the pool is debited once here,
    // for the quantity the branch actually counted.
    //
    // Both helpers are idempotent on (refId, productId, type). That also makes
    // this safe for any order left mid-flight by the previous behaviour: those
    // already carry a transfer_out under this same order id, so re-running is a
    // no-op rather than a second debit.
    //
    // Packing materials stay absent: not stock-tracked yet (migration 38).
    const moves = result.items
      .map((it) => ({ productId: it.productId, productName: it.productName, qty: Number(it.qty) }))
      .filter((m) => m.qty > 0);

    await transferOutOnApproval(id, moves);
    await Promise.all(
      moves.map((m) =>
        applyProductionToStock({
          branchId: order.branch_id,
          productId: m.productId,
          productName: m.productName,
          qty: m.qty,
          refId: id,
        }),
      ),
    );

    const correctionSummary = moves.map((m) => `${m.productName}: ${m.qty}`).join(' · ');

    await notify({
      type: 'production_order_verified',
      title: 'Production Order Verified — Awaiting Final Approval',
      message: `${req.user!.branchName || 'A branch'} verified receipt${correctionSummary ? ` — ${correctionSummary}` : ''}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: id,
    });

    res.json({ success: true, items: moves });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/final-approve — Production's closing sign-off
// on a demand the branch has verified. Status only: stock already moved at
// verification, which is also why there is no reject counterpart here — undoing
// it would mean clawing goods back out of branch inventory.
//
// The `.eq('status', 'verified')` predicate is the check-and-set: a second call
// matches no row and 409s rather than re-stamping the approval.
router.put('/:id/final-approve', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;

    const { data, error } = await supabaseAdmin
      .from('production_orders')
      .update({
        status: 'approved',
        approved_by: req.user!.uid,
        approved_by_name: req.user!.email,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'verified')
      .select('id, branch_id')
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      const { data: exists, error: exErr } = await supabaseAdmin
        .from('production_orders')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!exists) { res.status(404).json({ error: 'Production order not found' }); return; }
      res.status(409).json({ error: `Cannot approve an order that is ${exists.status} — it must be verified by the branch first` });
      return;
    }

    await notify({
      type: 'production_reviewed',
      title: 'Production Order Approved',
      message: 'Your verified demand has been approved by Production.',
      targetRole: 'branch_manager',
      branchId: data.branch_id,
      relatedId: id,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
