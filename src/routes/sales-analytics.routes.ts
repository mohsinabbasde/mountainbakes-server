import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { getSalesAnalytics, type SalesAnalyticsParams } from '../services/sales-analytics.service';
import {
  salesAnalyticsCSV,
  salesAnalyticsExcel,
  salesAnalyticsPDF,
} from '../services/sales-analytics-export.service';
import { businessDateStr, isBranchRole, SALES_TOP_PRODUCT_LIMITS } from '../shared';

/**
 * Daily Sales analytics — `/api/sales-analytics`.
 *
 * Its own router rather than another handler on `/api/reports`, for two reasons
 * that both matter at the call site: it aggregates in Postgres (migration 100)
 * where that one aggregates whole orders in Node, and it is read by a dashboard
 * card that refetches on every filter change, so it must not inherit the report
 * endpoint's cost or its order-shaped payload.
 *
 * Same grant as the reports router — `super_admin` and `branch_manager`. A
 * `branch_user` is a shift account with no dashboard at all (`getRoleHome`), and
 * the shared BRANCH_ROLES note is explicit that reporting surfaces name
 * `branch_manager` literally so the narrower grant stays visible here.
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', 'branch_manager'));

/**
 * Decide whose sales the caller is asking about — from the JWT, never from the
 * query string.
 *
 * A branch role is pinned to its own `branchId` and the `branchId` parameter is
 * DISCARDED, not validated and rejected: rejecting it would still be a channel,
 * telling an attacker which ids exist by the difference between 403 and 200.
 * Only a super_admin's parameter is read at all, and omitting it means every
 * branch consolidated.
 *
 * `isBranchRole` rather than `role === 'branch_manager'`: the test here means
 * "scope this to the caller's own branch", which is exactly the case the shared
 * helper exists for, and it stays correct if a shift account is ever granted a
 * dashboard.
 */
async function resolveScope(req: AuthRequest): Promise<{ branchId: string | null; branchName: string | null }> {
  if (isBranchRole(req.user!.role)) {
    // A branch account with no branch claim can see nothing rather than
    // everything — fail closed, exactly as `authenticate` does for a missing role.
    if (!req.user!.branchId) {
      throw Object.assign(new Error('Your account is not assigned to a branch'), { status: 403 });
    }
    return { branchId: req.user!.branchId, branchName: req.user!.branchName };
  }

  const requested = String(req.query['branchId'] ?? '').trim();
  if (!requested) return { branchId: null, branchName: null };

  // The name is for the export header and the card's subtitle. A branch id that
  // does not exist returns no rows from the RPC anyway; the lookup simply leaves
  // the name null rather than inventing one.
  const { data, error } = await supabaseAdmin
    .from('branches')
    .select('id, name')
    .eq('id', requested)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Branch not found'), { status: 404 });

  return { branchId: data.id as string, branchName: data.name as string };
}

/** `topLimit` is an offered choice, not free input — anything else falls back to the smallest. */
function topLimit(raw: unknown): number {
  const n = Number(raw);
  return (SALES_TOP_PRODUCT_LIMITS as readonly number[]).includes(n) ? n : SALES_TOP_PRODUCT_LIMITS[0];
}

async function readParams(req: AuthRequest): Promise<SalesAnalyticsParams> {
  const scope = await resolveScope(req);
  const today = businessDateStr();
  return {
    from: String(req.query['from'] ?? today),
    to: String(req.query['to'] ?? today),
    branchId: scope.branchId,
    branchName: scope.branchName,
    topLimit: topLimit(req.query['topLimit']),
    // Opt-in: the comparison costs a second scan of a second window, and the
    // card only shows it when the user asks for it.
    compare: String(req.query['compare'] ?? '') === 'true',
  };
}

/**
 * GET /api/sales-analytics
 *
 * from / to      business dates, YYYY-MM-DD (default: today)
 * branchId       super_admin only; omitted = every branch
 * topLimit       5 | 10
 * compare        'true' to include the previous-period comparison
 */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    res.json(await getSalesAnalytics(await readParams(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sales-analytics/export?type=excel|pdf|csv
 *
 * Exports exactly the window and branch the caller is authorised for, because
 * it reads the same `readParams` the screen does — there is no separate export
 * scope to get out of step with the one the API enforces.
 */
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const params = await readParams(req);
    const analytics = await getSalesAnalytics(params);

    const type = String(req.query['type'] ?? 'excel');
    const scope = analytics.from === analytics.effectiveTo
      ? analytics.from
      : `${analytics.from}_to_${analytics.effectiveTo}`;
    const filename = `mountain-bakes-daily-sales-${scope}`;

    if (type === 'pdf') {
      const buffer = await salesAnalyticsPDF(analytics);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.send(buffer);
    } else if (type === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(salesAnalyticsCSV(analytics));
    } else {
      const buffer = await salesAnalyticsExcel(analytics);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
