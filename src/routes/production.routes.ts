import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { notify } from '../services/push.service';
import { getReturnStockTotal } from '../services/return-stock.service';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

interface DemandOverview {
  waitingOrders: number;
  totalDemandQty: number;
  approvedOrders: number;
  changedOrders: number;
  demandByDay: { date: string; qty: number; orders: number }[];
  demandByMonth: { month: string; qty: number }[];
  branchDemand: { branchId: string; branchName: string; qty: number }[];
  topProducts: { productId: string | null; productName: string; qty: number }[];
}

type DashboardPeriod = 'today' | 'week' | 'month';

/** `YYYY-MM-DD` shifted by whole months, the day clamped to the target month's length. */
function shiftMonthsStr(dateStr: string, months: number, day?: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day ?? d, last));
  return first.toISOString().slice(0, 10);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/production/overview — dashboard cards + chart series for Production.
router.get('/overview', async (req, res, next) => {
  try {
    const todayStr = businessDateStr();
    const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const monthStartStr = `${todayStr.slice(0, 7)}-01`;
    const daysSinceMonday = (dow + 6) % 7;
    const weekStartStr = businessDaysAgoStr(daysSinceMonday); // Monday of this week
    // Week-to-date against the SAME weekdays of last week — Monday..Wednesday is
    // compared with last Monday..Wednesday, never with a full seven days.
    const prevWeekStartStr = businessDaysAgoStr(daysSinceMonday + 7);
    const prevWeekEndStr = businessDaysAgoStr(7);
    // Anything that is not a uuid is treated as "all branches" rather than a 400:
    // the filter is a chip on a dashboard, and a stale id should not blank it.
    const period: DashboardPeriod = req.query.period === 'today' || req.query.period === 'month'
      ? req.query.period
      : 'week';
    // Each period is compared with the same stretch of the one before it:
    // today with yesterday, Monday..today with last Monday..the same weekday,
    // the 1st..today with the 1st..the same day of last month.
    const win = period === 'today'
      ? { from: todayStr, prevFrom: businessDaysAgoStr(1), prevTo: businessDaysAgoStr(1) }
      : period === 'month'
        ? { from: monthStartStr, prevFrom: shiftMonthsStr(monthStartStr, -1), prevTo: shiftMonthsStr(todayStr, -1) }
        : { from: weekStartStr, prevFrom: prevWeekStartStr, prevTo: prevWeekEndStr };
    const branchId = typeof req.query.branchId === 'string' && UUID_RE.test(req.query.branchId)
      ? req.query.branchId
      : null;
    const last7 = businessDaysAgoStr(6);
    const historyFrom = weekStartStr < monthStartStr ? weekStartStr : monthStartStr;
    const demandFrom = businessDaysAgoStr(179); // ~6 months for the monthly chart
    const dayFrom = businessDaysAgoStr(29); // 30-day daily/weekly window

    const [demandRes, weekRes, seriesRes, prepHistRes, availRes, returnsRes, branchesRes, productsRes] = await Promise.all([
      // Was: fetch every non-cancelled production_orders row (with embedded
      // items) in the 180-day window and reduce it in Node on every call — the
      // same shape GET /api/reports/summary had before it was fixed, except
      // every field here IS rendered (ProductionDashboard.tsx), so there was no
      // unused-field shortcut. production_demand_overview (migration 112) does
      // the identical aggregation in SQL instead — same window, same
      // status<>'cancelled' exclusion, same qty column; verified field-for-field
      // against this route's prior Node logic before the swap.
      supabaseAdmin.rpc('production_demand_overview', {
        p_demand_from: demandFrom, p_day_from: dayFrom, p_last7: last7,
      }),
      // The period block of the dashboard (migration 140; "week" is its
      // default period, the function itself takes any pair of windows).
      // Aggregated in SQL for the same reason as the call above.
      supabaseAdmin.rpc('production_dashboard_week', {
        p_from: win.from, p_to: todayStr,
        p_prev_from: win.prevFrom, p_prev_to: win.prevTo,
        p_branch_id: branchId,
      }),
      // 12 months of demand beside output, and today by the hour (migration 141).
      supabaseAdmin.rpc('production_dashboard_series', {
        p_month_from: shiftMonthsStr(monthStartStr, -11), p_today: todayStr,
        p_branch_id: branchId,
      }),
      supabaseAdmin.from('production_stock_history').select('type, delta, business_date').gte('business_date', historyFrom),
      // AVAILABLE, not the raw pool balance: goods a branch has already been
      // promised are still on the shelf but are not free to sell or re-promise.
      // One SQL definition (migration 90) shared with the counter sale and the
      // Production Stock page's Balance column, so the card cannot drift from the
      // table it sits above.
      supabaseAdmin.rpc('production_stock_availability'),
      supabaseAdmin.from('production_returns').select('qty, status').eq('business_date', todayStr),
      supabaseAdmin.from('branches').select('id, name').eq('is_active', true).order('name'),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ]);
    for (const r of [demandRes, weekRes, seriesRes, prepHistRes, availRes, returnsRes, branchesRes, productsRes]) {
      if (r.error) throw r.error;
    }
    // Its own card, never added to `availableProductionStock`: returned goods are
    // a separate inventory until someone explicitly transfers them (migration 139).
    const branchReturnStock = await getReturnStockTotal();

    const demand = demandRes.data as unknown as DemandOverview;
    const { waitingOrders, totalDemandQty, approvedOrders, changedOrders } = demand;
    const deliveredOrders = approvedOrders; // Approve = Delivered

    let todayProduction = 0, weeklyProduction = 0, monthlyProduction = 0;
    for (const h of (prepHistRes.data ?? []) as { type: string; delta: number; business_date: string }[]) {
      if (h.type !== 'prepare') continue;
      const q = Math.abs(Number(h.delta) || 0);
      if (h.business_date === todayStr) todayProduction += q;
      if (h.business_date >= weekStartStr) weeklyProduction += q;
      if (h.business_date >= monthStartStr) monthlyProduction += q;
    }

    // Can go NEGATIVE, and that is a real answer: branches are owed more than the
    // pool holds, and the difference is production still to do.
    const availableProductionStock = ((availRes.data ?? []) as { available: number | string }[])
      .reduce((s, a) => s + Number(a.available ?? 0), 0);
    const returnedProducts = ((returnsRes.data ?? []) as { qty: number; status: string }[])
      .filter((r) => r.status === 'accepted')
      .reduce((s, r) => s + Number(r.qty || 0), 0);

    const branches = ((branchesRes.data ?? []) as { id: string; name: string }[])
      .map((b) => ({ branchId: b.id, branchName: b.name }));

    res.json({
      cards: {
        waitingOrders, approvedOrders, deliveredOrders, changedOrders,
        returnedProducts, todayProduction, weeklyProduction, monthlyProduction,
        totalBranches: branches.length, totalProducts: productsRes.count ?? 0,
        totalDemandQty, availableProductionStock, branchReturnStock,
      },
      demandByDay: demand.demandByDay,
      demandByMonth: demand.demandByMonth,
      branchDemand: demand.branchDemand,
      topProducts: demand.topProducts,
      branches,
      week: {
        period,
        from: win.from, to: todayStr,
        prevFrom: win.prevFrom, prevTo: win.prevTo,
        branchId,
        ...(weekRes.data as unknown as Record<string, unknown>),
        ...(seriesRes.data as unknown as Record<string, unknown>),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/production/branch-stock — Product × Branch balance matrix.
router.get('/branch-stock', async (_req, res, next) => {
  try {
    const [stockRes, branchesRes, productsRes] = await Promise.all([
      supabaseAdmin.from('stock').select('branch_id, product_id, balance'),
      supabaseAdmin.from('branches').select('id, name').eq('is_active', true),
      supabaseAdmin.from('products').select('id, name').eq('is_active', true),
    ]);
    for (const r of [stockRes, branchesRes, productsRes]) {
      if (r.error) throw r.error;
    }

    const branches = ((branchesRes.data ?? []) as { id: string; name: string }[])
      .map((b) => ({ branchId: b.id, branchName: b.name }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName));

    // productId -> branchId -> balance
    const balances: Record<string, Record<string, number>> = {};
    for (const s of (stockRes.data ?? []) as { branch_id: string; product_id: string; balance: number }[]) {
      (balances[s.product_id] ||= {})[s.branch_id] = Number(s.balance ?? 0);
    }

    // The whole matrix ships unpaginated, so ordering is the frontend's call —
    // `BranchStockMatrix.tsx` sorts client-side (defaulting to total-stock
    // descending, matching what this endpoint used to do server-side, so the
    // first render looks unchanged).
    const rows = ((productsRes.data ?? []) as { id: string; name: string }[])
      .map((p) => ({ productId: p.id, productName: p.name, byBranch: balances[p.id] || {} }));

    res.json({ branches, rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/production/queue — all pending/preparing/ready orders grouped by branch
router.get('/queue', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, items:order_items(product_id, product_name, qty, unit_price, line_total, line_no)')
      .in('status', ['pending', 'preparing', 'ready'])
      .order('created_at', { ascending: true })
      .order('line_no', { referencedTable: 'order_items', ascending: true });
    if (error) throw error;

    type OrderDoc = { id: string; branchId: string; branchName: string; status: string; [k: string]: unknown };
    const orders = rowToApi<OrderDoc[]>(data ?? []);

    // Group by branch
    const byBranch: Record<string, OrderDoc[]> = {};
    for (const order of orders) {
      if (!byBranch[order.branchId]) byBranch[order.branchId] = [];
      byBranch[order.branchId]!.push(order);
    }

    // Stats
    const stats = {
      waitingCount: orders.filter((o) => o.status === 'pending').length,
      preparingCount: orders.filter((o) => o.status === 'preparing').length,
      readyCount: orders.filter((o) => o.status === 'ready').length,
      totalActive: orders.length,
    };

    res.json({ queue: byBranch, stats });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production/:id/status
router.put('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body;

    if (!['preparing', 'ready', 'delivered'].includes(status)) {
      res.status(400).json({ error: 'Invalid production status' });
      return;
    }

    const id = req.params['id']!;
    // updated_at is maintained by the orders_touch trigger.
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('order_number, branch_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Order not found' }); return; }

    if (status === 'ready') {
      await notify({
        type: 'order_ready',
        title: 'Order Ready',
        message: `Order ${data.order_number} is ready for delivery`,
        targetRole: 'branch_manager',
        branchId: data.branch_id,
        relatedId: id,
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
