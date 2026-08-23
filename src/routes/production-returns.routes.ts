import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionReturnSchema,
  ReviewProductionReturnSchema,
  businessDateStr,
  businessDaysAgoStr,
} from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { applyStockMovement } from '../services/stock.service';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-returns — last 30 days, most recent first
router.get('/', async (_req, res, next) => {
  try {
    const cutoff = businessDaysAgoStr(29);
    const { data, error } = await supabaseAdmin
      .from('production_returns')
      .select('*')
      .gte('business_date', cutoff)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // The DB column is business_date; the API contract (ProductionReturn) exposes
    // it as date. rowToApi only camelCases keys, so remap it here — same fix as
    // GET /api/production-orders. Without it every row's date is undefined and
    // the Return Date column renders formatDate's "—" placeholder on all of them.
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const returns = rows.map(({ businessDate, ...rest }) => ({ ...rest, date: businessDate }));
    res.json({ returns, total: returns.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-returns — Production records a branch return (pending review)
router.post('/', validate(CreateProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, productId, qty, reason } = req.body as { branchId: string; productId: string; qty: number; reason: string };

    const [branchRes, productRes] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      supabaseAdmin.from('products').select('name').eq('id', productId).maybeSingle(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productRes.error) throw productRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productRes.data) { res.status(400).json({ error: 'Product not found' }); return; }

    // created_at comes from the column default; reviewed_* stay null until review.
    const { data: created, error: insErr } = await supabaseAdmin
      .from('production_returns')
      .insert({
        branch_id: branchId,
        branch_name: branchRes.data.name,
        product_id: productId,
        product_name: productRes.data.name,
        qty,
        reason,
        status: 'pending',
        business_date: businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    // branchId null: production_user has no branch claim, and the notifications RLS
    // filters out a role broadcast whose branch_id doesn't match the recipient's.
    // The source branch is already named in the message.
    await notify({
      type: 'production_return',
      title: 'Product Return Recorded',
      message: `${qty} × ${productRes.data.name} from ${branchRes.data.name}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: created.id,
    });

    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-returns/:id/review — approve, reject, or send back.
//
// THREE OUTCOMES, and which stock moves depends on `source` — on how much of the
// return has already happened by the time Production sees it:
//
//                   source 'branch'                   source null (recorded here)
//                   branch already debited at raise    nothing moved yet
//   accepted        pool ↑                             pool ↑ AND branch ↓
//   rejected        branch ↑ — units go back           nothing to undo
//   returned        nothing; back to the branch        refused (see below)
//
// The `source = 'branch'` column is what makes the split necessary rather than
// cosmetic. Since auto-approval was dropped, `POST /api/stock/return` takes the
// units off the branch as the return is raised and stops there; doing it again
// on acceptance would debit the shop twice for one return. A Production-recorded
// return has moved nothing at all, so acceptance still owes both movements —
// that is the original behaviour, unchanged.
//
// 'returned' is refused on a Production-recorded row. It means "your paperwork
// is wrong, fix it and send it again", and there is no branch paperwork to hand
// back — Production would be sending their own record to a branch that has no
// screen to correct it on and no way to return it.
router.put('/:id/review', validate(ReviewProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body as { status: 'accepted' | 'rejected' | 'returned' };
    const id = req.params['id']!;

    // Read before write, only to answer "may this row take this decision" — the
    // update below is still the atomic gate on double review, so a row that slips
    // from pending between these two statements is caught there, not here.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('production_returns')
      .select('id, source, status')
      .eq('id', id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) { res.status(404).json({ error: 'Return not found' }); return; }

    const fromBranch = (existing as { source: string | null }).source === 'branch';
    if (status === 'returned' && !fromBranch) {
      res.status(400).json({ error: 'This return was recorded here, so there is no branch record to send back. Accept or reject it.' });
      return;
    }

    // Atomic check-and-set: the `.eq('status', 'pending')` predicate is what makes
    // a double review a no-op (migration 05). A zero-row result means the return
    // was reviewed by someone else in between — the not-found case was already
    // ruled out above.
    //
    // `reviewed_*` is stamped on all three, 'returned' included: it is the record
    // of who last looked at the row, and a send-back is a review. It is cleared
    // again when the branch resubmits (`branch-returns.service.ts`), because a
    // row waiting on Production must not name a reviewer.
    const { data: reviewed, error: updErr } = await supabaseAdmin
      .from('production_returns')
      .update({
        status,
        reviewed_by: req.user!.uid,
        reviewed_by_name: req.user!.email,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('branch_id, product_id, product_name, qty')
      .maybeSingle();
    if (updErr) throw updErr;

    if (!reviewed) {
      res.status(409).json({ error: 'Return already reviewed' });
      return;
    }

    const qty = Number(reviewed.qty);

    // Accepted returns flow INTO the production pool. Idempotent by ref_id, so
    // the separate-transaction gap carried over from the original is retry-safe.
    // The refId is the return's own id, which is also what the raise path minted
    // for it — one product's return credits the pool once however often this runs.
    if (status === 'accepted') {
      await returnIntoPool(id, { productId: reviewed.product_id, productName: reviewed.product_name, qty });

      // Branch side ONLY for a return Production recorded itself. See the table
      // above: a branch-raised return debited the shop when it was raised.
      if (!fromBranch) {
        await applyStockMovement({
          branchId: reviewed.branch_id,
          productId: reviewed.product_id,
          productName: reviewed.product_name,
          delta: -Math.abs(qty),
          // 'return', not 'adjustment'. This is the same business event as a
          // branch-initiated return (`POST /api/stock/return` -> commitBranchReturn,
          // which has always written 'return'); only the party who recorded it
          // differs. Typing it 'adjustment' put the units in the Stock page's
          // Adjustment column instead of Returned, so a branch that returned stock
          // saw Returned stay 0 and read that as "my return was never taken off".
          //
          // It also broke the Support Center: apply_stock_correction (migration 33)
          // takes an ABSOLUTE target for `returned` and sizes its compensating
          // movement against the live figure. With these units filed as
          // 'adjustment', getProductStockFigures reported returned=0, so an admin
          // correcting Returned to the true figure appended a SECOND 'return'
          // movement and took the stock off twice.
          type: 'return',
          refId: `return_${id}`,
        });
      }
    }

    // A rejected branch return puts the units back on the shop's balance — they
    // were taken off when it was raised and Production is refusing them, so the
    // stock is the branch's again. `+delta` on type 'return' nets them back out
    // of the Returned column rather than appearing as stock from nowhere; the
    // reasoning is spelled out in branch-returns.service.ts's header.
    //
    // A distinct refId prefix from the acceptance path above, because the two are
    // different movements on the same return id and share the ('return', product)
    // half of the idempotency key — reuse would make whichever ran second a
    // silent no-op.
    if (status === 'rejected' && fromBranch) {
      await applyStockMovement({
        branchId: reviewed.branch_id,
        productId: reviewed.product_id,
        productName: reviewed.product_name,
        delta: Math.abs(qty),
        type: 'return',
        refId: `return_rejected_${id}`,
      });
    }

    // Every outcome is now news the branch has to act on, not just acceptance —
    // a rejected return has changed their balance back and a sent-back one is
    // waiting on them to correct it.
    const outcome = {
      accepted: { title: 'Return Accepted', message: `${qty} × ${reviewed.product_name} returned to production` },
      rejected: { title: 'Return Rejected', message: `${qty} × ${reviewed.product_name} is back in your branch stock` },
      returned: { title: 'Return Sent Back', message: `${qty} × ${reviewed.product_name} needs correcting before production can accept it` },
    }[status];

    await notify({
      type: 'production_return',
      title: outcome.title,
      message: outcome.message,
      targetRole: 'branch_manager',
      branchId: reviewed.branch_id,
      relatedId: id,
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
