import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import {
  BRANCH_ROLES,
  isBranchRole,
  businessDateStr,
  computeClosingTotals,
  type Order,
  type Expense,
} from '../shared';
import { computeBranchStockHistory } from '../services/stock.service';
import { genericExcel, genericCSV } from '../services/production-export.service';
import { rowToApi } from '../utils/case';

export const router = Router();

/**
 * Export of the Branch Closing sheet over a window — one row per business day.
 *
 * BRANCH_ROLES is included deliberately, and it is why this does not live on
 * /api/reports: that surface is manager-and-above, while the Closing page is
 * explicitly openable by a shift account (it writes nothing). An export button a
 * branch_user can see and cannot use would be worse than no button.
 */
router.use(authenticate, requireRole('super_admin', ...BRANCH_ROLES));

/** Widest window one export will build, in days. */
const MAX_WINDOW_DAYS = 180;

function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayCount(fromStr: string, toStr: string): number {
  return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The from/to window as business dates. Defaults to the last 7 days ending
 * today, and a reversed pair is swapped rather than silently returning nothing —
 * the same handling the production reports use.
 */
function exportRange(from: unknown, to: unknown): { fromStr: string; toStr: string } {
  const today = businessDateStr();
  const clean = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const a = clean(from) || shiftDate(today, -6);
  const b = clean(to) || today;
  return a <= b ? { fromStr: a, toStr: b } : { fromStr: b, toStr: a };
}

// GET /api/branch-closing/export?from=&to=&type=excel|csv
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const exportType = String(req.query['type'] || 'excel');
    const { fromStr, toStr } = exportRange(req.query['from'], req.query['to']);

    // A branch account exports its own shop and cannot ask about another; a super
    // admin has no branch of their own, so they must name one. Refused rather
    // than defaulting to "all branches": these figures reconcile against one
    // physical cash drawer, and a total spanning several shops reconciles with
    // nothing.
    let branchId: string;
    if (isBranchRole(req.user!.role)) {
      if (!req.user!.branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
      branchId = req.user!.branchId;
    } else {
      const asked = req.query['branchId'];
      if (typeof asked !== 'string' || !asked) { res.status(400).json({ error: 'Branch context required' }); return; }
      branchId = asked;
    }

    if (dayCount(fromStr, toStr) > MAX_WINDOW_DAYS) {
      res.status(400).json({ error: `That range is longer than ${MAX_WINDOW_DAYS} days. Export it in smaller windows.` });
      return;
    }

    const [ordersRes, expensesRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('*')
        .eq('branch_id', branchId)
        .gte('business_date', fromStr)
        .lte('business_date', toStr),
      supabaseAdmin
        .from('expenses')
        .select('*')
        .eq('branch_id', branchId)
        .gte('business_date', fromStr)
        .lte('business_date', toStr),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (expensesRes.error) throw expensesRes.error;

    // Grouped on the stored business_date rather than on created_at, so a sale
    // rung up at 01:30 counts against the day it belongs to — the 2 AM rollover
    // is already baked into that column at insert time.
    const ordersByDay = new Map<string, Order[]>();
    for (const row of (ordersRes.data ?? []) as Record<string, unknown>[]) {
      const day = String(row['business_date']);
      const order = rowToApi<Order>(row);
      const list = ordersByDay.get(day);
      if (list) list.push(order); else ordersByDay.set(day, [order]);
    }
    const expensesByDay = new Map<string, Expense[]>();
    for (const row of (expensesRes.data ?? []) as Record<string, unknown>[]) {
      const day = String(row['business_date']);
      // The API contract calls it `date`; the column is business_date, and
      // rowToApi only camelCases keys. Same remap the list route does.
      const { businessDate, ...rest } = rowToApi<Expense & { businessDate: string }>(row);
      const expense = { ...rest, date: businessDate } as Expense;
      const list = expensesByDay.get(day);
      if (list) list.push(expense); else expensesByDay.set(day, [expense]);
    }

    // Closing stock per day, from the same ledger walk the Branch Stock History
    // card uses. It can only count backwards from today's live balance, so the
    // window it needs is "today back to fromStr", not the requested span.
    const today = businessDateStr();
    const balanceByDay = new Map<string, number>();
    let stockCapped = false;
    if (fromStr <= today) {
      const history = await computeBranchStockHistory(branchId, dayCount(fromStr, today));
      stockCapped = history.capped;
      for (const row of history.rows) balanceByDay.set(row.date, row.balanceQty);
    }

    const rows: (string | number)[][] = [];
    const totals = { sales: 0, discounts: 0, expenses: 0, net: 0, cashSales: 0, cashExpenses: 0, cashInHand: 0, orders: 0, cancelled: 0 };
    for (let d = fromStr; d <= toStr; d = shiftDate(d, 1)) {
      const t = computeClosingTotals(ordersByDay.get(d) ?? [], expensesByDay.get(d) ?? []);
      totals.sales += t.sales;
      totals.discounts += t.discounts;
      totals.expenses += t.expenses;
      totals.net += t.net;
      totals.cashSales += t.cashSales;
      totals.cashExpenses += t.cashExpenses;
      totals.cashInHand += t.cashInHand;
      totals.orders += t.orderCount;
      totals.cancelled += t.cancelled;
      rows.push([
        d,
        Math.round(t.sales),
        Math.round(t.discounts),
        Math.round(t.expenses),
        Math.round(t.net),
        Math.round(t.cashSales),
        Math.round(t.cashExpenses),
        Math.round(t.cashInHand),
        t.orderCount,
        t.cancelled,
        balanceByDay.get(d) ?? 0,
      ]);
    }

    // Stock on Hand is left blank on the TOTAL row on purpose: it is a balance,
    // not a flow. Adding up each day's closing shelf count would produce a large
    // number that means nothing — the last day's figure is the one that is true.
    rows.push([
      'TOTAL',
      Math.round(totals.sales),
      Math.round(totals.discounts),
      Math.round(totals.expenses),
      Math.round(totals.net),
      Math.round(totals.cashSales),
      Math.round(totals.cashExpenses),
      Math.round(totals.cashInHand),
      totals.orders,
      totals.cancelled,
      '',
    ]);
    if (stockCapped) {
      rows.push(['Stock history hit its row cap, so Stock on Hand may be short on the earliest days.', '', '', '', '', '', '', '', '', '', '']);
    }

    const headers = ['Date', 'Sales', 'Discounts', 'Expenses', 'Net', 'Cash Sales', 'Cash Expenses', 'Cash in Hand', 'Orders', 'Cancelled', 'Stock on Hand'];
    const title = 'Branch Closing';
    const window = fromStr === toStr ? fromStr : `${fromStr}_to_${toStr}`;
    const filename = `mountain-bakes-closing-${window}`;

    if (exportType === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(genericCSV(headers, rows));
      return;
    }
    const buffer = await genericExcel(title, headers, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});
