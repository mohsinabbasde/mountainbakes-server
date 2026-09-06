import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { ReviewBranchDiscountSchema, businessDaysAgoStr } from '../shared';
import { notify } from '../services/push.service';
import { rowToApi } from '../utils/case';

/**
 * Production → Discounts: the queue of money branches are claiming back.
 *
 * The deliberate twin of production-returns.routes.ts. Same four states, same
 * three decisions, same atomic check-and-set on review — so that Production
 * learns one board and reads two.
 *
 * WHAT IS NOT HERE IS THE POINT. A return review has to get stock right: which
 * side has already moved, what acceptance credits, what rejection puts back, and
 * an idempotency key under all of it because the movements commit in a separate
 * transaction from the status. A discount moves nothing. Approving one is a
 * status write and a notification. There is no pool to credit, no branch balance
 * to unwind, and so nothing here that can leave stock and paperwork disagreeing.
 *
 * That is why 'returned' is offered unconditionally, where the returns route has
 * to refuse it on Production-recorded rows: every claim in this table was raised
 * by a branch, so there is always branch paperwork to hand back.
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

/**
 * One DB row → the API's BranchDiscount shape.
 *
 * Two fixes, both of which are silent failures if skipped:
 *
 * - `business_date` → `date`. rowToApi only camelCases keys, so without this
 *   remap every row's `date` is undefined and the client renders formatDate's
 *   '—' placeholder on all of them — the same bug GET /api/production-orders and
 *   the returns list each had to fix.
 * - `amount` through Number(). PostgREST can hand a `numeric` column back as a
 *   STRING, and `BranchDiscount.amount` is typed `number`; a string would flow
 *   all the way to formatCurrency, whose toLocaleString options a string
 *   silently ignores, and the branch would read a raw unformatted figure with no
 *   error anywhere.
 */
function toApi(rows: unknown): Record<string, unknown>[] {
  const camel = rowToApi<Record<string, unknown>[]>((rows ?? []) as Record<string, unknown>[]);
  return camel.map(({ businessDate, amount, ...rest }) => ({
    ...rest,
    amount: Number(amount),
    date: businessDate,
  }));
}

// GET /api/production-discounts — last 30 days, most recent first.
//
// The same window the returns board uses, and it is a window rather than a page
// for the same reason: the client table is unpaginated, so this is what keeps the
// response finite as the table grows.
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('branch_discounts')
      .select('*')
      .gte('business_date', businessDaysAgoStr(29))
      .order('created_at', { ascending: false });
    if (error) throw error;

    const discounts = toApi(data);
    res.json({ discounts, total: discounts.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-discounts/:id/review — approve, reject, or send back.
//
// Three outcomes, none of which move anything:
//
//   approved   the claim is allowed. Final.
//   rejected   the claim is refused. Final.
//   returned   handed back for the branch to correct. NOT final — the branch
//              revises it and it comes back here as 'pending'.
//
// The whole decision is the status and the note. Where the money is settled — a
// credit note, the next invoice, the branch's closing — is downstream of this
// record and outside this table; nothing here books a figure anywhere, which is
// exactly what makes the claim safe to review twice if the first attempt races.
router.put('/:id/review', validate(ReviewBranchDiscountSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, reviewNote } = req.body as {
      status: 'approved' | 'rejected' | 'returned';
      reviewNote?: string;
    };
    const id = req.params['id']!;

    // Atomic check-and-set. The `.eq('status', 'pending')` predicate is the gate
    // on double review, exactly as it is on production_returns: a zero-row result
    // means someone else decided this between the board rendering and the button
    // being pressed. It also excludes 'returned' — a claim already handed back is
    // the branch's to act on, and deciding one out from under them would settle a
    // correction they are in the middle of making.
    //
    // `reviewed_*` is stamped on all three, 'returned' included: a send-back is a
    // review and this is the record of who last looked. The branch's own PUT
    // clears the three again when it corrects the claim.
    const { data: reviewed, error } = await supabaseAdmin
      .from('branch_discounts')
      .update({
        status,
        review_note: reviewNote ?? null,
        reviewed_by: req.user!.uid,
        reviewed_by_name: req.user!.email,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error) throw error;

    if (!reviewed) {
      // Not-found and already-decided are one 409 on purpose. Distinguishing them
      // would need a second read to say "no such claim" about a row the caller
      // just clicked, and the operator's next move — refresh the board — is the
      // same either way.
      res.status(409).json({ error: 'Discount already reviewed' });
      return;
    }

    const amount = Number(reviewed.amount);
    const outcome = {
      approved: {
        title: 'Discount Approved',
        message: `${amount} on ${reviewed.demand_number} was approved`,
      },
      rejected: {
        title: 'Discount Rejected',
        message: `${amount} on ${reviewed.demand_number} was rejected`,
      },
      returned: {
        title: 'Discount Sent Back',
        message: `${amount} on ${reviewed.demand_number} needs correcting before production can approve it`,
      },
    }[status];

    await notify({
      type: 'branch_discount_reviewed',
      title: outcome.title,
      message: outcome.message,
      // The branch, not a role broadcast: this is one shop's claim and the
      // notifications RLS matches on branch_id, so naming it is what gets the row
      // to the manager who raised it.
      targetRole: 'branch_manager',
      branchId: reviewed.branch_id,
      relatedId: id,
    });

    res.json(toApi([reviewed])[0]);
  } catch (err) {
    next(err);
  }
});
