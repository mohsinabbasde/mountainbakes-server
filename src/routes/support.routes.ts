import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateSupportTicketSchema,
  EditSupportTicketSchema,
  ResolveSupportTicketSchema,
  ChangeFiguresSchema,
  EditSaleItemsSchema,
  businessDateStr,
  type PaymentMethod,
  type StockFigures,
  type SupportReference,
  type SupportReferenceType,
} from '../shared';
import { notify } from '../services/push.service';
import {
  applyStockCorrection,
  getProductStockFigures,
  NegativeBalanceError,
  type StockCorrectionResult,
  type StockCorrectionTargets,
} from '../services/stock.service';
import { getProductionStockRows } from '../services/production-stock.service';
import { getProductionBranchId } from '../utils/productionBranch';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

// ---------------------------------------------------------------------------
// Reference lookup — resolve a typed ID (MB-/DMD-/EXP-/STK-) to its detail, scoped
// to the caller's role/branch. Throws { status } errors that map to HTTP codes.
// ---------------------------------------------------------------------------
class LookupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const money = (v: unknown) => `Rs.${Number(v ?? 0).toLocaleString('en-PK')}`;

/** The stock figures an admin may correct, labelled as the Stock page shows them. */
const STOCK_FIGURE_LABELS = {
  newQty: 'New Stock',
  sold: 'Sold',
  returned: 'Returned',
  balance: 'Balance',
} as const;

/** "Sold 10 → 12, Balance 40 → 38" — only the figures that actually moved. */
function describeStockChange(result: StockCorrectionResult): string {
  return (Object.keys(STOCK_FIGURE_LABELS) as (keyof typeof STOCK_FIGURE_LABELS)[])
    .filter((k) => result.before[k] !== result.after[k])
    .map((k) => `${STOCK_FIGURE_LABELS[k]} ${result.before[k]} → ${result.after[k]}`)
    .join(', ');
}

function refType(refId: string): SupportReferenceType {
  const id = refId.toUpperCase();
  if (id.startsWith('MB-')) return 'sale';
  if (id.startsWith('DMD-')) return 'demand';
  if (id.startsWith('EXP-')) return 'expense';
  if (id.startsWith('STK-')) return 'stock';
  throw new LookupError(
    'Unknown ID. Use a sale (MB-…), demand (DMD-…), expense (EXP-…), or stock (STK-…) ID.',
    400,
  );
}

/**
 * `scopeBranch` lets a super_admin resolve a STOCK reference against a specific
 * branch — the Support Center passes the ticket's branch so the admin sees (and
 * corrects) that branch's live figures rather than an all-branches total. Ignored
 * for branch managers, who are always pinned to their own branch.
 */
async function resolveReference(
  user: AuthRequest['user'],
  rawRef: string,
  scopeBranch?: string | null,
): Promise<SupportReference> {
  const referenceId = rawRef.trim().toUpperCase();
  const type = refType(referenceId);
  const role = user!.role;
  const branchId = user!.branchId;

  // --- SALE (orders.order_number) -----------------------------------------
  if (type === 'sale') {
    // Resolving the sentinel does double duty: it is the production role's branch
    // scope, and it is how ANY caller (an admin included) recognises a sale whose
    // units came out of the pool rather than a branch ledger. Cached, so this is
    // at most one `branches` read per TTL.
    const productionBranchId = await getProductionBranchId();

    let q = supabaseAdmin
      .from('orders')
      .select('id, order_number, customer_name, branch_name, branch_id, grand_total, payment_method, status, business_date')
      .eq('order_number', referenceId)
      .limit(1);
    if (role === 'branch_manager') {
      // Fail CLOSED. Without the guard a manager whose account carries no branch
      // would scope to nothing at all and see every branch's sales.
      if (!branchId) throw new LookupError('No branch is assigned to this account.', 403);
      q = q.eq('branch_id', branchId);
    } else if (role === 'production_user') {
      // Mirrors the branch_manager scoping: production sees the counter's own
      // sales (migration 37's sentinel branch), never a shop's.
      q = q.eq('branch_id', productionBranchId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) throw new LookupError(`No sale found for ${referenceId}.`, 404);

    // Derived from the ROW's branch, not the caller's role, so an admin looking up
    // the same counter sale gets the same read-only verdict.
    const isProductionSale = data.branch_id === productionBranchId;

    // Line items are editable in the Support Center: the admin can change a
    // line's product, qty, or unit price, and it applies live via edit_sale_items.
    const { data: items, error: itemsErr } = await supabaseAdmin
      .from('order_items')
      .select('product_id, product_name, category_id, category_name, unit_price, qty, discount')
      .eq('order_id', data.id)
      .order('line_no', { ascending: true });
    if (itemsErr) throw itemsErr;

    return {
      type,
      referenceId,
      entityId: data.id,
      title: `Sale ${referenceId} — ${data.customer_name ?? 'Walk-in'} · ${money(data.grand_total)}`,
      fields: [
        { label: 'Customer', value: data.customer_name ?? 'Walk-in' },
        { label: 'Branch', value: data.branch_name ?? '—' },
        { label: 'Grand Total', value: money(data.grand_total) },
        { label: 'Payment', value: String(data.payment_method ?? '—') },
        { label: 'Status', value: String(data.status ?? '—') },
        { label: 'Date', value: String(data.business_date ?? '—') },
      ],
      saleItems: (items ?? []).map((it) => ({
        productId: it.product_id,
        productName: it.product_name,
        categoryId: it.category_id,
        categoryName: it.category_name,
        unitPrice: Number(it.unit_price),
        qty: Number(it.qty),
        discount: Number(it.discount ?? 0),
      })),
      // Also editable in the Support Center. Historical rows may carry a legacy
      // tender ('card' / 'online') that is no longer offered — it is shown as-is
      // and simply not one of the choices the admin can pick.
      paymentMethod: (data.payment_method ?? undefined) as PaymentMethod | undefined,
      // Order totals are recomputed from the line edits by edit_sale_items — the
      // flat editableFields path (expenses) does not apply to sales.
      editableFields: [],
      // A counter sale drew its units from `production_stock`, but edit_sale_items
      // reconciles branch `stock` keyed on orders.branch_id — and the sentinel
      // branch has no stock rows. Applying one would 409 on any increase and
      // INSERT phantom branch inventory on any decrease, leaving the pool wrong
      // either way. So it is answered, not corrected.
      ...(isProductionSale ? { readOnly: true } : {}),
    };
  }

  // --- DEMAND (production_orders.demand_number) ----------------------------
  // READ-ONLY by nature: a demand is a workflow document, not a ledger. Correcting
  // one means re-reviewing it on the Production Orders page, where
  // review_production_order moves the approved quantities and the pool atomically.
  // Patching columns from here would desynchronise the two.
  if (type === 'demand') {
    // An explicit column list rather than production-orders.routes.ts's `*`: this
    // snapshot is frozen into the ticket as jsonb forever, so it should not carry
    // legacy ids, print flags or audit uuids.
    let q = supabaseAdmin
      .from('production_orders')
      .select(`
        id, demand_number, branch_id, branch_name, business_date, submitted_time,
        status, was_changed, change_reason, created_by_name, approved_by_name,
        items:production_order_items(qty, approved_qty),
        packingItems:production_order_packing_items(qty, approved_qty)
      `)
      .eq('demand_number', referenceId)
      .limit(1);
    // super_admin and production_user see every branch's demand — production
    // reviews all of them, matching GET /api/production-orders, which applies no
    // branch filter for that role. A branch manager sees only its own, fail-closed.
    if (role === 'branch_manager') {
      if (!branchId) throw new LookupError('No branch is assigned to this account.', 403);
      q = q.eq('branch_id', branchId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) throw new LookupError(`No demand found for ${referenceId}.`, 404);

    type QtyRow = { qty: number | string; approved_qty: number | string | null };
    const items = (data.items ?? []) as QtyRow[];
    const packing = (data.packingItems ?? []) as QtyRow[];
    // numeric(14,3) can arrive as a string from PostgREST — coerce, as the sale
    // block does for its line items.
    const sum = (rows: QtyRow[], key: keyof QtyRow) =>
      rows.reduce((total, r) => total + Number(r[key] ?? 0), 0);
    // approved_qty stays NULL until review, so a 0 here would read as "Production
    // approved nothing" rather than "not looked at yet".
    const reviewed = items.some((i) => i.approved_qty != null);

    return {
      type,
      referenceId,
      entityId: data.id,
      // No entityTable: `entityTable` + a non-empty `allowed` set is exactly what
      // drives the blind UPDATE in PATCH /:id/figures. Omitting it is a second,
      // independent guard behind the readOnly flag.
      title: `Demand ${referenceId} — ${data.branch_name ?? '—'} · ${data.business_date}`,
      fields: [
        { label: 'Branch', value: data.branch_name ?? '—' },
        { label: 'Date', value: String(data.business_date) },
        { label: 'Time', value: data.submitted_time ?? '—' },
        { label: 'Status', value: String(data.status) },
        { label: 'Products', value: String(items.length) },
        { label: 'Requested Qty', value: String(sum(items, 'qty')) },
        { label: 'Approved Qty', value: reviewed ? String(sum(items, 'approved_qty')) : '—' },
        { label: 'Packing Items', value: String(packing.length) },
        { label: 'Submitted By', value: data.created_by_name ?? '—' },
        { label: 'Reviewed By', value: data.approved_by_name ?? '—' },
        { label: 'Changed', value: data.was_changed ? (data.change_reason || 'Yes') : 'No' },
      ],
      editableFields: [],
      readOnly: true,
    };
  }

  // --- EXPENSE (expenses / production_expenses .expense_number) ------------
  if (type === 'expense') {
    // Branch managers see only their branch's shop expenses; production users
    // see only production expenses; admins see either.
    if (role !== 'production_user') {
      let q = supabaseAdmin
        .from('expenses')
        .select('id, expense_number, description, amount, payment_method, branch_id, branch_name, business_date')
        .eq('expense_number', referenceId)
        .limit(1);
      if (role === 'branch_manager' && branchId) q = q.eq('branch_id', branchId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          type,
          referenceId,
          entityId: data.id,
          entityTable: 'expenses',
          title: `Expense ${referenceId} — ${data.description} · ${money(data.amount)}`,
          fields: [
            { label: 'Description', value: data.description },
            { label: 'Amount', value: money(data.amount) },
            { label: 'Payment', value: String(data.payment_method ?? '—') },
            { label: 'Branch', value: data.branch_name ?? '—' },
            { label: 'Date', value: String(data.business_date ?? '—') },
          ],
          editableFields: [
            { key: 'amount', label: 'Amount', kind: 'number', value: Number(data.amount) },
            { key: 'description', label: 'Description', kind: 'text', value: data.description },
          ],
        };
      }
    }
    if (role !== 'branch_manager') {
      const { data, error } = await supabaseAdmin
        .from('production_expenses')
        .select('id, expense_number, category, description, amount, payment_method, supplier, business_date')
        .eq('expense_number', referenceId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          type,
          referenceId,
          entityId: data.id,
          entityTable: 'production_expenses',
          title: `Production Expense ${referenceId} — ${data.category} · ${money(data.amount)}`,
          fields: [
            { label: 'Category', value: data.category },
            { label: 'Description', value: data.description ?? '—' },
            { label: 'Amount', value: money(data.amount) },
            { label: 'Payment', value: String(data.payment_method ?? '—') },
            { label: 'Supplier', value: data.supplier ?? '—' },
            { label: 'Date', value: String(data.business_date ?? '—') },
          ],
          editableFields: [
            { key: 'amount', label: 'Amount', kind: 'number', value: Number(data.amount) },
            { key: 'description', label: 'Description', kind: 'text', value: data.description ?? '' },
          ],
        };
      }
    }
    throw new LookupError(`No expense found for ${referenceId}.`, 404);
  }

  // --- STOCK (products.stock_code) ----------------------------------------
  const { data: product, error: prodErr } = await supabaseAdmin
    .from('products')
    .select('id, name, sku, stock_code, price')
    .eq('stock_code', referenceId)
    .maybeSingle();
  if (prodErr) throw prodErr;
  if (!product) throw new LookupError(`No stock item found for ${referenceId}.`, 404);

  const fields: SupportReference['fields'] = [
    { label: 'Product', value: product.name },
    { label: 'SKU', value: product.sku ?? '—' },
    { label: 'Price', value: money(product.price) },
  ];
  const editableFields: SupportReference['editableFields'] = [];
  let stockFigures: StockFigures | undefined;

  // One date for the whole block. Read twice it could straddle the 2 AM Karachi
  // rollover and label a day's figures with the next day's date.
  const today = businessDateStr();

  // Production runs off the branch-agnostic pool, so neither branch path below
  // applies — a production user would otherwise fall through both and get a bare
  // Product/SKU/Price with no figures at all. Returning early rather than joining
  // the chain makes it structurally impossible for a branch-shaped `stockFigures`
  // or `branchId` to end up on a pool reference.
  //
  // READ-ONLY: applyStockCorrection sizes its compensating movement against ONE
  // branch ledger, and the pool has none.
  if (role === 'production_user') {
    // Reused rather than queried directly so the Help Desk and the Production
    // Stock page derive these six figures from one definition — the alternative is
    // re-folding the movement types here and eventually disagreeing with the page.
    const poolRow = (await getProductionStockRows(today)).find((r) => r.productId === product.id);
    fields.push(
      { label: 'Prepared Today', value: String(poolRow?.preparedToday ?? 0) },
      { label: 'Total Stock', value: String(poolRow?.totalStock ?? 0) },
      { label: 'Approved Qty', value: String(poolRow?.approvedQty ?? 0) },
      { label: 'Sold', value: String(poolRow?.soldToday ?? 0) },
      { label: 'Returned', value: String(poolRow?.returned ?? 0) },
      { label: 'Balance', value: String(poolRow?.balance ?? 0) },
    );
    return {
      type,
      referenceId,
      entityId: product.id,
      title: `Production Stock ${referenceId} — ${product.name}`,
      fields,
      editableFields: [],
      readOnly: true,
      // No branch ledger for a correction to land on. `stockFigures` is omitted
      // entirely — it is the BRANCH row shape and does not describe the pool.
      branchId: null,
      businessDate: today,
    };
  }

  // Whose stock is this about? A branch manager's own branch, or — when the admin
  // re-resolves a ticket to correct it — the branch the ticket was raised from.
  // A correction needs exactly one branch's ledger to land on.
  const scopeBranchId = role === 'branch_manager' ? branchId : (scopeBranch ?? null);

  if (scopeBranchId) {
    // The whole derived row, not just the balance: the admin corrects whichever
    // figure is wrong (units never delivered, a mis-keyed sale, an unrecorded
    // return), and each one is a different compensating movement. Same definitions
    // as the branch's Stock page, so both sides read the same numbers.
    const f = await getProductStockFigures(scopeBranchId, product.id, today);
    fields.push(
      { label: 'Opening Stock', value: String(f.opening) },
      { label: 'New Stock', value: String(f.newQty) },
      { label: 'Sold', value: String(f.sold) },
      { label: 'Returned', value: String(f.returned) },
      { label: 'Adjustment', value: f.adjustment > 0 ? `+${f.adjustment}` : String(f.adjustment) },
      { label: 'Balance', value: String(f.balance) },
    );
    // Opening is deliberately absent: it is the previous day's closing, so
    // correcting it would mean rewriting a day that has already been closed.
    editableFields.push(
      { key: 'newQty', label: 'New Stock', kind: 'number', value: f.newQty },
      { key: 'sold', label: 'Sold', kind: 'number', value: f.sold },
      { key: 'returned', label: 'Returned', kind: 'number', value: f.returned },
      { key: 'balance', label: 'Balance', kind: 'number', value: f.balance },
    );
    stockFigures = f;
  } else if (role === 'super_admin') {
    const { data: rows } = await supabaseAdmin.from('stock').select('balance').eq('product_id', product.id);
    const total = (rows ?? []).reduce((s, r) => s + Number(r.balance ?? 0), 0);
    fields.push({ label: 'Total Balance (all branches)', value: String(total) });
    // Not editable: an all-branches total has no single ledger to correct. The
    // admin corrects stock from the branch's own ticket, which carries a branch.
  }

  return {
    type,
    referenceId,
    entityId: product.id,
    title: `Stock ${referenceId} — ${product.name}`,
    fields,
    editableFields,
    branchId: scopeBranchId,
    businessDate: today,
    stockFigures,
  };
}

// GET /api/support/lookup?ref=EXP-000012 — used by the Help Desk to auto-show detail.
// &branchId= scopes a stock lookup to one branch (admin only; see resolveReference)
// and is how the Support Center re-reads a ticket's LIVE figures before correcting
// them — the snapshot on the ticket is from when the query was raised.
router.get('/lookup', async (req: AuthRequest, res, next) => {
  try {
    const ref = String(req.query['ref'] || '').trim();
    if (!ref) { res.status(400).json({ error: 'Reference ID is required' }); return; }
    const scopeBranch = req.user!.role === 'super_admin' ? (req.query['branchId'] as string | undefined) : undefined;
    const reference = await resolveReference(req.user, ref, scopeBranch ?? null);
    res.json({ reference });
  } catch (err) {
    if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

// GET /api/support — admin sees the whole queue; a raiser sees only their own tickets
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (req.user!.role !== 'super_admin') {
      query = query.eq('raised_by', req.user!.uid);
    } else if (req.query['status']) {
      query = query.eq('status', String(req.query['status']));
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ tickets: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// POST /api/support — raise a query (branches + production). Snapshots the reference.
router.post('/', requireRole('branch_manager', 'production_user'), validate(CreateSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { referenceId, message } = req.body;
    let reference: SupportReference;
    try {
      reference = await resolveReference(req.user, referenceId);
    } catch (err) {
      if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        reference_type: reference.type,
        reference_id: reference.referenceId,
        reference_snapshot: reference,
        message,
        branch_id: req.user!.branchId,
        branch_name: req.user!.branchName,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    // In-app notification to admins — best-effort, never fails the mutation.
    try {
      await notify({
        type: 'support_query',
        title: `New support query ${data.ticket_number}`,
        message: `${req.user!.branchName || req.user!.email} raised a query on ${reference.referenceId}`,
        targetRole: 'super_admin',
        branchId: req.user!.branchId,
        relatedId: data.id,
      });
    } catch { /* notification failure must not fail ticket creation */ }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// Helper: load a ticket or 404.
async function getTicket(id: string) {
  const { data, error } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// PATCH /api/support/:id — admin edits the ticket text (Edit button)
router.patch('/:id', requireRole('super_admin'), validate(EditSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.message !== undefined) patch['message'] = req.body.message;
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }
    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/resolve — admin resolves or rejects (Reject button + Resolve)
router.patch('/:id/resolve', requireRole('super_admin'), validate(ResolveSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, resolutionNote } = req.body;
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update({
        status,
        resolution_note: resolutionNote || null,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} ${status}`,
          message: resolutionNote || `Your query on ${data.reference_id} was ${status}.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/figures — admin "Change" button. Applies a live edit to an
// expense's amount/description, or a correction to a branch's stock figures (New /
// Sold / Returned / Balance, as absolute targets). Anything with no correctable
// figure is recorded on the ticket for manual follow-up. Either way the ticket is
// marked resolved.
//
// A figure the caller omits is LEFT ALONE — that is what makes it safe for the
// Support Center to send only what the admin touched, so a sale rung up while the
// dialog was open is not reverted by a stale target.
router.patch('/:id/figures', requireRole('super_admin'), validate(ChangeFiguresSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;

    // Read-only references have nothing to write back. Enforced HERE and not only
    // in the UI, because the stock branch below keys on `type === 'stock'` and a
    // production pool ticket is exactly that. A production account may legally
    // carry a branchId (the user schema makes it merely nullable), which
    // POST /api/support stamps onto the ticket — so without this guard a pool
    // query would drive applyStockCorrection against a real, unrelated shop's
    // ledger. The caller's role cannot catch that; only the snapshot's flag can.
    if (snapshot?.readOnly) {
      res.status(400).json({
        error: 'This reference is informational only and cannot be corrected here. Reply to the query and resolve it instead.',
      });
      return;
    }

    const { edits, note } = req.body as { edits: Record<string, string | number>; note: string };
    const allowed = new Set((snapshot?.editableFields ?? []).map((f) => f.key));

    let applied = false;
    // Set when the stock path ran, so the note and the response report the REAL
    // before/after rather than echoing back what the admin typed.
    let stockResult: (StockCorrectionResult & { productName: string }) | null = null;

    // Gated on the reference TYPE, not on `allowed`: tickets raised before stock
    // became correctable carry an empty editableFields, and those queries still
    // need answering.
    if (snapshot?.type === 'stock') {
      // The branch comes from the TICKET. The figures describe one branch's
      // ledger — the raiser's — and that is the only one this correction may move.
      const branchId = ticket.branch_id as string | null;
      if (!branchId) {
        res.status(400).json({ error: 'This query has no branch, so there is no branch stock to correct.' });
        return;
      }

      // Absolute targets, not deltas: the admin enters the figures as they should
      // read. Only the four correctable keys are honoured — `opening` is the
      // previous day's closing and is not correctable from here.
      const targets: StockCorrectionTargets = {};
      for (const key of ['newQty', 'sold', 'returned', 'balance'] as const) {
        const raw = edits[key];
        if (raw === undefined || raw === '') continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          res.status(400).json({ error: `${STOCK_FIGURE_LABELS[key]} must be a number of 0 or more.` });
          return;
        }
        targets[key] = value;
      }
      if (Object.keys(targets).length === 0) {
        res.status(400).json({ error: 'Enter at least one stock figure to correct.' });
        return;
      }

      // Re-read the name rather than trusting the snapshot's — stock_history keeps
      // a name snapshot, and it should read as the name at correction time.
      const { data: product, error: prodErr } = await supabaseAdmin
        .from('products')
        .select('name')
        .eq('id', snapshot.entityId)
        .maybeSingle();
      if (prodErr) throw prodErr;
      if (!product) { res.status(404).json({ error: 'The linked product no longer exists' }); return; }

      try {
        const result = await applyStockCorrection({
          branchId,
          productId: snapshot.entityId,
          productName: product.name as string,
          targets,
          ticketId: ticket.id as string,
        });
        stockResult = { ...result, productName: product.name as string };
        applied = result.applied;
      } catch (err) {
        if (err instanceof NegativeBalanceError) {
          res.status(409).json({ error: `${err.message} A branch balance cannot go below zero.` });
          return;
        }
        throw err;
      }
    } else if (snapshot?.entityTable && allowed.size > 0) {
      // Live mutation — only expense columns are ever in `allowed` here.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(edits)) {
        if (!allowed.has(k)) continue;
        patch[k] = k === 'amount' ? Number(v) : v;
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin.from(snapshot.entityTable).update(patch).eq('id', snapshot.entityId);
        if (error) throw error;
        applied = true;
      }
    }

    // Compose an audit-friendly resolution note describing what changed. The stock
    // path words its own: `applied` is false there when the figures already matched,
    // which is a no-op rather than a pending manual follow-up.
    const changeLines = Object.entries(edits)
      .filter(([k]) => allowed.size === 0 || allowed.has(k))
      .map(([k, v]) => `${k} → ${v}`);
    const summary = stockResult
      ? stockResult.applied
        ? `Branch stock corrected for ${stockResult.productName}: ${describeStockChange(stockResult)}`
        : `Branch stock for ${stockResult.productName} already matched — nothing to correct`
      : `${applied ? 'Figures updated' : 'Correction recorded (manual follow-up)'}: ${changeLines.join(', ')}`;
    const resolutionNote = [note, summary].filter(Boolean).join(' — ');

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data), applied, stock: stockResult });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/sale-items — admin "Change" for a SALE query. Applies a
// live edit to the order's line items (product / qty / unit price, add / remove),
// recomputing order totals and reconciling stock atomically via edit_sale_items,
// optionally re-tenders the sale (paymentMethod), then resolves the ticket.
// Overdrawing a branch balance is rejected (409).
router.patch('/:id/sale-items', requireRole('super_admin'), validate(EditSaleItemsSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (ticket.reference_type !== 'sale') { res.status(400).json({ error: 'Only sale queries support line-item edits' }); return; }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;

    // A Production counter sale. edit_sale_items reconciles branch `stock` keyed on
    // orders.branch_id, and the sentinel branch these are booked to has no stock
    // rows — so a qty increase would 409 with a bogus "not enough stock" and a
    // decrease would INSERT phantom branch inventory, while the pool the units
    // actually came from stayed untouched.
    if (snapshot?.readOnly) {
      res.status(400).json({
        error: 'This sale was rung up at the Production counter, so its items cannot be corrected here. Reply to the query and resolve it instead.',
      });
      return;
    }

    const orderId = snapshot?.entityId;
    if (!orderId) { res.status(400).json({ error: 'This ticket has no linked sale to edit' }); return; }

    const { items, paymentMethod, note } = req.body as {
      items: unknown[];
      paymentMethod?: PaymentMethod;
      note: string;
    };

    const { data: result, error } = await supabaseAdmin.rpc('edit_sale_items', {
      p_order_id: orderId,
      p_items: items,
      p_business_date: businessDateStr(),
    });
    if (error) throw error;

    const outcome = (result ?? {}) as { status?: string; shortfalls?: unknown; grandTotal?: number };
    if (outcome.status === 'not_found') { res.status(404).json({ error: 'The linked sale no longer exists' }); return; }
    if (outcome.status === 'insufficient') {
      const shortfalls = (outcome.shortfalls ?? []) as Array<{ productName: string; requested: number; available: number }>;
      const detail = shortfalls.map((s) => `${s.productName} (need ${s.requested}, have ${s.available})`).join('; ');
      res.status(409).json({ error: `Not enough stock: ${detail}`, shortfalls: outcome.shortfalls });
      return;
    }

    // Payment method rides alongside the line edit but is deliberately NOT part of
    // edit_sale_items: it touches no stock, no line total and no grand total, so it
    // needs none of that function's locking. `.neq` makes the write self-checking —
    // rows come back only when the tender actually moved, so the resolution note
    // can't claim a change that did not happen (the snapshot may be stale).
    //
    // Ordered after the RPC on purpose: the item edit is the part that can fail
    // (insufficient stock → 409), and it must fail before anything else is written.
    // If this update itself errors the ticket stays open and the admin retries —
    // re-running edit_sale_items with the same lines is a no-op (delta 0 moves no
    // stock and the recomputed totals are identical).
    let paymentChanged = false;
    if (paymentMethod) {
      const { data: repaid, error: payErr } = await supabaseAdmin
        .from('orders')
        .update({ payment_method: paymentMethod })
        .eq('id', orderId)
        .neq('payment_method', paymentMethod)
        .select('id');
      if (payErr) throw payErr;
      paymentChanged = (repaid ?? []).length > 0;
    }

    // Record what changed and resolve the ticket in one update.
    const resolutionNote = [
      note,
      `Sale items updated (new total ${money(outcome.grandTotal)})`,
      paymentChanged ? `Payment method → ${paymentMethod}` : '',
    ].filter(Boolean).join(' — ');
    const { data, error: updErr } = await supabaseAdmin
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (updErr) throw updErr;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data), applied: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/support/:id — admin removes a ticket (Delete button)
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { error } = await supabaseAdmin.from('support_tickets').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
