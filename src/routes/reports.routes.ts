import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { exportToPDF, exportToExcel, exportToCSV } from '../services/export.service';
import { businessRange, type PaymentMethodBreakdown } from '../shared';
import { startOfMonth, endOfMonth, format } from 'date-fns';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'branch_manager'));

/**
 * Orders with their line items.
 *
 * The line items live in their own `order_items` table (migration 03), so the
 * aggregation below reads them through this embed rather than off the order row.
 *
 * NOTE the aggregation still runs in Node over the whole selected range. That is
 * a deliberate, faithful port of the previous behaviour — the date and branch
 * filters DO run in Postgres now, which is the bulk of the win. Moving the
 * group-bys into SQL (a `report_*` RPC per rollup) is the follow-up, deferred so
 * reports do not depend on an unapplied migration.
 */
const ORDER_SELECT = `
  id, status, grand_total, discount_total, branch_id, branch_name, payment_method,
  business_date, created_at,
  items:order_items(product_id, product_name, category_name, qty, line_total)
`;

interface OrderRow {
  id: string;
  status: string;
  grand_total: number | string;
  discount_total: number | string;
  branch_id: string;
  branch_name: string | null;
  payment_method: string | null;
  business_date: string;
  created_at: string;
  items: { product_id: string | null; product_name: string; category_name: string | null; qty: number | string; line_total: number | string }[] | null;
}

// Day/week/month/year boundaries follow the business day (rolls over at 2 AM Karachi).
function getDateRange(period: string, from?: string, to?: string) {
  if (period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'yearly') {
    const r = businessRange(period);
    return { from: r.fromISO, to: r.toISO };
  }
  const m = businessRange('monthly');
  return { from: from || m.fromISO, to: to || m.toISO };
}

router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const period = String(req.query['period'] || 'monthly');
    const { from, to } = getDateRange(period, String(req.query['from'] || ''), String(req.query['to'] || ''));

    let query = supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .gte('created_at', from)
      .lte('created_at', to);

    // Branch managers see their branch only
    if (req.user!.role === 'branch_manager') {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;
    const orders = (data ?? []) as unknown as OrderRow[];

    // numeric(14,2) can arrive as a string over PostgREST; normalise once.
    const total = (v: number | string | null | undefined) => Number(v ?? 0);
    const live = orders.filter((o) => o.status !== 'cancelled');
    // A 'staff' sale is exempt from payment: the goods left the production counter
    // but no money came in. It is a real order (it moved stock, and it carries the
    // required comment saying who took what), so it stays in the order counts and
    // in the payment-method breakdown — but every MONEY figure below is computed
    // from `paid`, or profit would be overstated by whatever staff consumed.
    const paid = live.filter((o) => o.payment_method !== 'staff');
    const staffTotal = live
      .filter((o) => o.payment_method === 'staff')
      .reduce((s, o) => s + total(o.grand_total), 0);

    const totalOrders = orders.length;
    const totalRevenue = paid.reduce((s, o) => s + total(o.grand_total), 0);
    // Discount given away, over the same `paid` set as totalRevenue — a cancelled
    // or staff order's discount never cost the branch anything.
    const totalDiscount = paid.reduce((s, o) => s + total(o.discount_total), 0);
    const totalCancelled = orders.filter((o) => o.status === 'cancelled').length;
    const totalPending = orders.filter((o) => o.status === 'pending').length;

    // Daily aggregation.
    //
    // Grouped on the STORED business_date, not recomputed from created_at. The
    // write path records the business day at 2 AM-rollover time; deriving it
    // again here could disagree with what was actually stored for an order
    // placed either side of the boundary.
    const dayMap: Record<string, { totalOrders: number; totalRevenue: number; totalCancelled: number }> = {};
    for (const o of orders) {
      const day = o.business_date;
      if (!dayMap[day]) dayMap[day] = { totalOrders: 0, totalRevenue: 0, totalCancelled: 0 };
      dayMap[day]!.totalOrders++;
      if (o.status !== 'cancelled' && o.payment_method !== 'staff') dayMap[day]!.totalRevenue += total(o.grand_total);
      if (o.status === 'cancelled') dayMap[day]!.totalCancelled++;
    }

    // Branch aggregation (admin only)
    const branchMap: Record<string, { branchId: string; branchName: string; totalOrders: number; totalRevenue: number }> = {};
    for (const o of paid) {
      if (!branchMap[o.branch_id]) {
        branchMap[o.branch_id] = { branchId: o.branch_id, branchName: o.branch_name ?? '', totalOrders: 0, totalRevenue: 0 };
      }
      branchMap[o.branch_id]!.totalOrders++;
      branchMap[o.branch_id]!.totalRevenue += total(o.grand_total);
    }

    // Top products — reads the embedded order_items rows.
    const productMap: Record<string, { productId: string; productName: string; categoryName: string; totalQty: number; totalRevenue: number }> = {};
    for (const o of paid) {
      for (const item of o.items ?? []) {
        // product_id is nullable (ON DELETE SET NULL); fall back to the name
        // snapshot so a deleted product still aggregates instead of collapsing
        // every such line into one 'null' bucket.
        const key = item.product_id ?? `name:${item.product_name}`;
        if (!productMap[key]) {
          productMap[key] = {
            productId: item.product_id ?? '',
            productName: item.product_name,
            categoryName: item.category_name ?? '',
            totalQty: 0,
            totalRevenue: 0,
          };
        }
        productMap[key]!.totalQty += total(item.qty);
        productMap[key]!.totalRevenue += total(item.line_total);
      }
    }

    // Payment-method breakdown (non-cancelled sales)
    const pmMap: Record<string, PaymentMethodBreakdown> = {};
    for (const o of live) {
      const method = o.payment_method || 'cash';
      if (!pmMap[method]) pmMap[method] = { method, total: 0, count: 0 };
      pmMap[method]!.total += total(o.grand_total);
      pmMap[method]!.count++;
    }

    // Expenses in range (branch-scoped when applicable)
    const scopeBranchId = req.user!.role === 'branch_manager'
      ? req.user!.branchId
      : (req.query['branchId'] as string | undefined) || null;

    let expenseQuery = supabaseAdmin
      .from('expenses')
      .select('amount, business_date')
      .gte('created_at', from)
      .lte('created_at', to);
    if (scopeBranchId) expenseQuery = expenseQuery.eq('branch_id', scopeBranchId);

    const { data: expenseData, error: expenseErr } = await expenseQuery;
    if (expenseErr) throw expenseErr;

    const expenses = (expenseData ?? []) as { amount: number | string; business_date: string }[];
    const totalExpenses = expenses.reduce((s, e) => s + total(e.amount), 0);
    const totalProfit = totalRevenue - totalExpenses;

    // Same reasoning as dayMap — group on the stored business_date.
    const expenseByDay: Record<string, number> = {};
    for (const e of expenses) {
      expenseByDay[e.business_date] = (expenseByDay[e.business_date] || 0) + total(e.amount);
    }

    // Merge order-days and expense-days for the sales-vs-expenses chart
    const allDays = new Set([...Object.keys(dayMap), ...Object.keys(expenseByDay)]);
    const dailyData = [...allDays].sort((a, b) => a.localeCompare(b)).map((date) => {
      const v = dayMap[date] || { totalOrders: 0, totalRevenue: 0, totalCancelled: 0 };
      const exp = expenseByDay[date] || 0;
      return { date, totalOrders: v.totalOrders, totalRevenue: v.totalRevenue, totalCancelled: v.totalCancelled, expenses: exp, profit: v.totalRevenue - exp };
    });

    // Branch budget (only when a single branch is in scope)
    let budget: { daily: number; weekly: number; monthly: number } | undefined;
    if (scopeBranchId) {
      const { data: branch, error: branchErr } = await supabaseAdmin
        .from('branches')
        .select('daily_budget, weekly_budget, monthly_budget')
        .eq('id', scopeBranchId)
        .maybeSingle();
      if (branchErr) throw branchErr;
      if (branch) {
        budget = {
          daily: total(branch.daily_budget),
          weekly: total(branch.weekly_budget),
          monthly: total(branch.monthly_budget),
        };
      }
    }

    res.json({
      period, from, to,
      totalOrders,
      totalRevenue,
      totalDiscount,
      staffTotal,
      totalCancelled,
      totalPending,
      averageOrderValue: totalOrders ? totalRevenue / (totalOrders - totalCancelled || 1) : 0,
      totalExpenses,
      totalProfit,
      dailyData,
      branchData: Object.values(branchMap).map(b => ({ ...b, averageOrderValue: b.totalOrders ? b.totalRevenue / b.totalOrders : 0 })),
      topProducts: Object.values(productMap).sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 10),
      paymentMethodBreakdown: Object.values(pmMap),
      budget,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/reports/packing-usage — Daily Packing Material Usage.
 *
 * One row per (business date, branch, material), aggregated across however many
 * demands that branch submitted that day.
 *
 * `deliveredQty` is DERIVED, not stored. There is no delivery step separate from
 * approval in this workflow — approving a demand is what sends it — so delivered
 * equals approved on an approved order and 0 on a pending or rejected one. If a
 * real delivery confirmation is ever added, this is the single place that changes.
 *
 * Filters: from / to (business dates), branchId, packingMaterialId.
 */
router.get('/packing-usage', async (req: AuthRequest, res, next) => {
  try {
    const from = String(req.query['from'] || format(startOfMonth(new Date()), 'yyyy-MM-dd'));
    const to = String(req.query['to'] || format(endOfMonth(new Date()), 'yyyy-MM-dd'));

    let query = supabaseAdmin
      .from('production_orders')
      .select(`
        business_date, branch_id, branch_name, status,
        packingItems:production_order_packing_items(packing_material_id, material_name, qty, approved_qty)
      `)
      .gte('business_date', from)
      .lte('business_date', to)
      .order('business_date', { ascending: false });

    // Branch managers are scoped to their own branch, same rule as every other
    // handler in this router.
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', String(req.query['branchId']));
    }

    const { data, error } = await query;
    if (error) throw error;

    const materialFilter = req.query['packingMaterialId'] ? String(req.query['packingMaterialId']) : null;
    const num = (v: unknown) => Number(v ?? 0);

    type OrderRow = {
      business_date: string;
      branch_id: string;
      branch_name: string | null;
      status: string;
      packingItems: {
        packing_material_id: string | null;
        material_name: string;
        qty: number | string;
        approved_qty: number | string | null;
      }[] | null;
    };

    const rows = new Map<string, {
      date: string; branchId: string; branchName: string;
      packingMaterialId: string | null; materialName: string;
      requestedQty: number; approvedQty: number; deliveredQty: number;
    }>();

    for (const o of (data ?? []) as unknown as OrderRow[]) {
      for (const it of o.packingItems ?? []) {
        if (materialFilter && it.packing_material_id !== materialFilter) continue;

        // A deleted material leaves packing_material_id null but keeps the name
        // snapshot, so key on the name in that case rather than collapsing every
        // deleted material into one row.
        const key = `${o.business_date}|${o.branch_id}|${it.packing_material_id ?? `name:${it.material_name}`}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            date: o.business_date,
            branchId: o.branch_id,
            branchName: o.branch_name ?? '',
            packingMaterialId: it.packing_material_id,
            materialName: it.material_name,
            requestedQty: 0,
            approvedQty: 0,
            deliveredQty: 0,
          };
          rows.set(key, row);
        }

        const approved = num(it.approved_qty);
        row.requestedQty += num(it.qty);
        // Only an approved order has meaningful approved/delivered quantities; a
        // pending one has approved_qty null and a rejected one sent nothing.
        if (o.status === 'approved') {
          row.approvedQty += approved;
          row.deliveredQty += approved;
        }
      }
    }

    const usage = [...rows.values()].sort(
      (a, b) => b.date.localeCompare(a.date) || a.materialName.localeCompare(b.materialName),
    );
    res.json({ usage, from, to, total: usage.length });
  } catch (err) {
    next(err);
  }
});

router.get('/branch-comparison', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const from = String(req.query['from'] || startOfMonth(new Date()).toISOString());
    const to = String(req.query['to'] || endOfMonth(new Date()).toISOString());

    // `status != 'cancelled'` alongside a range filter is just an ordinary
    // predicate here.
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('branch_id, branch_name, grand_total')
      .gte('created_at', from)
      .lte('created_at', to)
      .neq('status', 'cancelled')
      // Staff sales take no money, so they are not revenue to compare branches on.
      .neq('payment_method', 'staff');
    if (error) throw error;

    const orders = (data ?? []) as { branch_id: string; branch_name: string | null; grand_total: number | string }[];
    const branchMap: Record<string, { branchId: string; branchName: string; totalRevenue: number; totalOrders: number }> = {};

    for (const o of orders) {
      if (!branchMap[o.branch_id]) {
        branchMap[o.branch_id] = { branchId: o.branch_id, branchName: o.branch_name ?? '', totalRevenue: 0, totalOrders: 0 };
      }
      branchMap[o.branch_id]!.totalRevenue += Number(o.grand_total ?? 0);
      branchMap[o.branch_id]!.totalOrders++;
    }

    res.json({ comparison: Object.values(branchMap), from, to });
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const exportType = String(req.query['type'] || 'excel');
    const period = String(req.query['period'] || 'monthly');
    const { from, to } = getDateRange(period, String(req.query['from'] || ''), String(req.query['to'] || ''));

    let query = supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .gte('created_at', from)
      .lte('created_at', to);

    if (req.user!.role === 'branch_manager') query = query.eq('branch_id', req.user!.branchId);
    else if (req.query['branchId']) query = query.eq('branch_id', req.query['branchId']);

    const { data, error } = await query;
    if (error) throw error;

    // export.service.ts formats the camelCase API shape (it predates the port and
    // is backend-agnostic), so convert before handing the rows over.
    const orders = rowToApi(data ?? []) as unknown as Parameters<typeof exportToPDF>[0];

    const dateLabel = format(new Date(), 'yyyy-MM-dd');

    if (exportType === 'pdf') {
      const buffer = await exportToPDF(orders);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.pdf"`);
      res.send(buffer);
    } else if (exportType === 'csv') {
      const csv = exportToCSV(orders);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.csv"`);
      res.send(csv);
    } else {
      const buffer = await exportToExcel(orders);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
