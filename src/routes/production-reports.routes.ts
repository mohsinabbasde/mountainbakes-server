import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { getProductionStockRows } from '../services/production-stock.service';
import { genericPDF, genericExcel, genericCSV } from '../services/production-export.service';
import { format } from 'date-fns';

export const router = Router();

// Production-only reporting surface — deliberately separate from /api/reports
// (sales/financials), which Production users must not access.
router.use(authenticate, requireRole('super_admin', 'production_user'));

export type ProductionReportType =
  | 'production'
  | 'prepared-detail'
  | 'branch-demand'
  | 'approved-orders'
  | 'pending-balance'
  | 'returned-products'
  | 'production-stock'
  | 'branch-stock';

/** Karachi date-string range for a named period (anchored to today). */
function periodDateRange(period: string): { fromStr: string; toStr: string } {
  const todayStr = businessDateStr();
  if (period === 'daily') return { fromStr: todayStr, toStr: todayStr };
  if (period === 'weekly') {
    const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay();
    return { fromStr: businessDaysAgoStr((dow + 6) % 7), toStr: todayStr };
  }
  if (period === 'yearly') return { fromStr: `${todayStr.slice(0, 4)}-01-01`, toStr: todayStr };
  // monthly (default)
  return { fromStr: `${todayStr.slice(0, 7)}-01`, toStr: todayStr };
}

/**
 * Ceiling on the prepare-ledger rows one "Prepared Items" read will pull. The
 * report aggregates in Node, so an unbounded window is an unbounded memory read;
 * 20 000 rows is roughly a year of every product being prepared every day.
 */
const PREPARED_ROW_CAP = 20_000;

/** Reports driven by an explicit from/to window instead of the period dropdown. */
function usesDateRange(report: string): boolean {
  return report === 'prepared-detail';
}

/**
 * The explicit `from`/`to` window the date-wise reports run on. Both default to
 * today (the common case: "what did we prepare today?") and a reversed pair is
 * swapped rather than silently returning nothing.
 */
function explicitDateRange(from: unknown, to: unknown): { fromStr: string; toStr: string } {
  const todayStr = businessDateStr();
  const clean = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const a = clean(from) || clean(to) || todayStr;
  const b = clean(to) || clean(from) || todayStr;
  return a <= b ? { fromStr: a, toStr: b } : { fromStr: b, toStr: a };
}

interface RItem { qty: number; approved_qty?: number | null; total_required_qty?: number | null; remaining_balance_qty?: number | null }
interface RDoc { branch_id: string; branch_name: string; business_date: string; status: string; approved_by_name?: string | null; items: RItem[] }

const ORDER_WITH_ITEMS =
  'branch_id, branch_name, business_date, status, approved_by_name, items:production_order_items(qty, approved_qty, total_required_qty, remaining_balance_qty)';

/** Build a titled, tabular report dataset for the given type + period. */
async function buildReport(
  report: string,
  period: string,
  range?: { fromStr: string; toStr: string },
): Promise<{ title: string; headers: string[]; rows: (string | number)[][] }> {
  // `prepared-detail` is driven by an explicit from/to window rather than the
  // period dropdown; every other report still anchors to the named period.
  const { fromStr, toStr } = range ?? periodDateRange(period);
  const inRange = (d: string) => d >= fromStr && d <= toStr;

  switch (report) {
    case 'prepared-detail': {
      // One line per PRODUCT over the window — the same item prepared on several
      // days collapses into a single row carrying the window's total, so a range
      // reads as "what did we make, and how much of it". Read straight off the
      // pool ledger rather than from getProductionStockRows, which can only
      // answer for a single date.
      //
      // Deltas are summed SIGNED: a day can hold several prep batches, and an
      // admin lowering "Prepared Today" appends a negative 'prepare' movement.
      // abs() here would report a correction as extra production.
      const { data, error } = await supabaseAdmin
        .from('production_stock_history')
        .select('product_id, product_name, delta, business_date')
        .eq('type', 'prepare')
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        .order('business_date', { ascending: true })
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;

      const movements = (data ?? []) as
        { product_id: string; product_name: string; delta: number | string; business_date: string }[];

      // Item code + category come off the catalogue — the ledger stores neither.
      const productIds = [...new Set(movements.map((m) => m.product_id))];
      const meta = new Map<string, { code: string; category: string }>();
      if (productIds.length > 0) {
        const { data: prods, error: prodErr } = await supabaseAdmin
          .from('products')
          .select('id, stock_code, category_name')
          .in('id', productIds);
        if (prodErr) throw prodErr;
        for (const pr of (prods ?? []) as { id: string; stock_code: string | null; category_name: string | null }[]) {
          meta.set(pr.id, { code: pr.stock_code ?? '—', category: pr.category_name ?? '' });
        }
      }

      const byProduct = new Map<string, { productId: string; name: string; qty: number }>();
      for (const m of movements) {
        const cur = byProduct.get(m.product_id)
          ?? { productId: m.product_id, name: m.product_name, qty: 0 };
        cur.qty += Number(m.delta ?? 0);
        byProduct.set(m.product_id, cur);
      }

      // A product whose corrections cancel its batches netted to nothing over the
      // window and did not get prepared — dropping it keeps the sheet to real
      // production.
      const detail = [...byProduct.values()]
        .filter((r) => r.qty !== 0)
        .sort((a, b) => a.name.localeCompare(b.name));

      const body: (string | number)[][] = detail.map((r) => [
        meta.get(r.productId)?.code ?? '—',
        r.name,
        meta.get(r.productId)?.category ?? '',
        r.qty,
      ]);
      if (detail.length > 0) {
        body.push(['Total', '', '', detail.reduce((sum, r) => sum + r.qty, 0)]);
      }

      return {
        title: fromStr === toStr
          ? `Prepared Items — ${fromStr}`
          : `Prepared Items — ${fromStr} to ${toStr}`,
        headers: ['Item Code', 'Product', 'Category', 'Qty Prepared'],
        rows: body,
      };
    }
    case 'production-stock': {
      const rows = await getProductionStockRows();
      // The same nine columns, in the same order, as the Production Stock page —
      // exported from the SAME query, so the sheet and the screen cannot disagree.
      return {
        title: 'Production Stock',
        headers: [
          'Product', 'Opening Stock', 'Prepared Stock', 'Total Stock',
          'Branch Demand Stock', 'Sale', 'Return Stock', 'Adjustment', 'Balance',
        ],
        rows: rows.map((r) => [
          r.productName,
          r.opening,
          r.preparedToday,
          r.totalStock,
          r.branchDemand,
          r.soldToday,
          r.returned,
          r.adjustment,
          r.balance,
        ]),
      };
    }
    case 'branch-stock': {
      const [stockRes, branchesRes, productsRes] = await Promise.all([
        supabaseAdmin.from('stock').select('branch_id, product_id, balance'),
        supabaseAdmin.from('branches').select('id, name').eq('is_active', true),
        supabaseAdmin.from('products').select('id, name').eq('is_active', true),
      ]);
      for (const r of [stockRes, branchesRes, productsRes]) { if (r.error) throw r.error; }

      const branches = ((branchesRes.data ?? []) as { id: string; name: string }[])
        .map((b) => ({ id: b.id, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const balances: Record<string, Record<string, number>> = {};
      for (const s of (stockRes.data ?? []) as { branch_id: string; product_id: string; balance: number }[]) {
        (balances[s.product_id] ||= {})[s.branch_id] = Number(s.balance ?? 0);
      }
      const products = ((productsRes.data ?? []) as { id: string; name: string }[])
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        title: 'Branch Stock',
        headers: ['Product', ...branches.map((b) => b.name)],
        rows: products.map((p) => [p.name, ...branches.map((b) => balances[p.id]?.[b.id] ?? 0)]),
      };
    }
    case 'branch-demand': {
      // Every row counts here regardless of status, so a demand the branch
      // deleted has to be dropped at the query or it inflates that branch's
      // demand and order count.
      const { data, error } = await supabaseAdmin.from('production_orders').select(ORDER_WITH_ITEMS).gte('business_date', fromStr).neq('status', 'cancelled');
      if (error) throw error;
      const orders = ((data ?? []) as unknown as RDoc[]).filter((o) => inRange(o.business_date));
      const map: Record<string, { name: string; qty: number; required: number; pending: number; orders: number }> = {};
      for (const o of orders) {
        const items = o.items ?? [];
        const qty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
        const required = items.reduce((s, i) => s + Number(i.total_required_qty ?? i.qty ?? 0), 0);
        const pending = items.reduce((s, i) => s + Number(i.remaining_balance_qty ?? 0), 0);
        if (!map[o.branch_id]) map[o.branch_id] = { name: o.branch_name, qty: 0, required: 0, pending: 0, orders: 0 };
        map[o.branch_id]!.qty += qty;
        map[o.branch_id]!.required += required;
        map[o.branch_id]!.pending += pending;
        map[o.branch_id]!.orders += 1;
      }
      return {
        title: 'Branch Demand',
        headers: ['Branch', 'Total Demand Qty', 'Total Required', 'Pending Balance', 'Orders'],
        rows: Object.values(map).sort((a, b) => b.qty - a.qty).map((b) => [b.name, b.qty, b.required, b.pending, b.orders]),
      };
    }
    case 'approved-orders': {
      const { data, error } = await supabaseAdmin.from('production_orders').select(ORDER_WITH_ITEMS).gte('business_date', fromStr);
      if (error) throw error;
      const orders = ((data ?? []) as unknown as RDoc[]).filter((o) => o.status === 'approved' && inRange(o.business_date));
      return {
        title: 'Approved Orders',
        headers: ['Date', 'Branch', 'Products', 'Total Required', 'Approved Qty', 'Pending', 'Approved By'],
        rows: orders.map((o) => {
          const items = o.items ?? [];
          return [
            o.business_date,
            o.branch_name,
            items.length,
            items.reduce((s, i) => s + Number(i.total_required_qty ?? i.qty), 0),
            items.reduce((s, i) => s + Number(i.approved_qty ?? i.qty), 0),
            items.reduce((s, i) => s + Number(i.remaining_balance_qty ?? 0), 0),
            o.approved_by_name || '',
          ];
        }),
      };
    }
    case 'pending-balance': {
      // Snapshot of outstanding carry-forward balances (not period-filtered).
      const { data, error } = await supabaseAdmin
        .from('production_balances')
        .select('branch_name, product_name, pending_qty, updated_at');
      if (error) throw error;
      const rows = ((data ?? []) as { branch_name?: string; product_name: string; pending_qty: number; updated_at?: string }[])
        .filter((b) => Number(b.pending_qty ?? 0) > 0)
        .sort((a, b) => (a.branch_name ?? '').localeCompare(b.branch_name ?? '') || a.product_name.localeCompare(b.product_name));
      return {
        title: 'Pending Balance',
        headers: ['Branch', 'Product', 'Pending Qty', 'Updated'],
        rows: rows.map((r) => [r.branch_name ?? '', r.product_name, Number(r.pending_qty ?? 0), (r.updated_at ?? '').slice(0, 10)]),
      };
    }
    case 'returned-products': {
      const { data, error } = await supabaseAdmin
        .from('production_returns')
        .select('business_date, branch_name, product_name, qty, reason, status')
        .gte('business_date', fromStr);
      if (error) throw error;
      const returns = ((data ?? []) as { business_date: string; branch_name: string; product_name: string; qty: number; reason: string; status: string }[])
        .filter((r) => inRange(r.business_date));
      return {
        title: 'Returned Products',
        headers: ['Date', 'Branch', 'Product', 'Qty', 'Reason', 'Status'],
        rows: returns.map((r) => [r.business_date, r.branch_name, r.product_name, r.qty, r.reason, r.status]),
      };
    }
    case 'production':
    default: {
      // Prepared production by day.
      const { data, error } = await supabaseAdmin
        .from('production_stock_history')
        .select('type, delta, business_date')
        .gte('business_date', fromStr);
      if (error) throw error;
      const byDay: Record<string, number> = {};
      for (const h of (data ?? []) as { type: string; delta: number; business_date: string }[]) {
        if (h.type !== 'prepare' || !inRange(h.business_date)) continue;
        byDay[h.business_date] = (byDay[h.business_date] || 0) + Math.abs(Number(h.delta) || 0);
      }
      return {
        title: 'Production',
        headers: ['Date', 'Prepared Qty'],
        rows: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty]) => [date, qty]),
      };
    }
  }
}

// GET /api/production-reports/summary?report=&period=&from=&to= — JSON preview
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const range = usesDateRange(report) ? explicitDateRange(req.query['from'], req.query['to']) : undefined;
    const data = await buildReport(report, period, range);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/production-reports/export?report=&period=&from=&to=&type=pdf|excel|csv
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const exportType = String(req.query['type'] || 'excel');
    const range = usesDateRange(report) ? explicitDateRange(req.query['from'], req.query['to']) : undefined;
    const { title, headers, rows } = await buildReport(report, period, range);
    // A range report names the window it covers, so two exports taken the same
    // day for different windows don't land on the same filename.
    const dateLabel = range
      ? (range.fromStr === range.toStr ? range.fromStr : `${range.fromStr}_to_${range.toStr}`)
      : format(new Date(), 'yyyy-MM-dd');
    const filename = `mountain-bakes-${report}-${dateLabel}`;

    if (exportType === 'pdf') {
      const buffer = await genericPDF(title, headers, rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.send(buffer);
    } else if (exportType === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(genericCSV(headers, rows));
    } else {
      const buffer = await genericExcel(title, headers, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
