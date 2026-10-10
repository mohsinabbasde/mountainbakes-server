import { dbFor } from '../db';
import {
  businessDateStr,
  type FinanceDashboardDay,
  type FinanceDashboardLedgerRow,
  type FinanceDashboardMetric,
  type FinanceDashboardMonthTrend,
  type FinanceDashboardPreviousBalance,
  type FinanceDashboardRecord,
  type FinanceDashboardRecordsPage,
  type FinanceMonthlyDashboard,
} from '../shared';
import { round2 } from './finance-settings.service';

const db = dbFor('finance-monthly-dashboard');

/**
 * The monthly Finance Dashboard — production income against ledger receipts,
 * per branch per business month, plus the source records behind each figure.
 *
 * Every sum is taken in Postgres (migration 128: `finance_monthly_dashboard`,
 * `finance_dashboard_records`); this service only picks the windows, adds the
 * ledger's own totals from `finance_ledger_totals`, and folds the daily rows
 * into the summary. The rules each figure follows, and where they were lifted
 * from, are in docs/finance-dashboard-audit.md.
 *
 * Three RPCs per load, in parallel: the selected window (with ledger heads),
 * the six whole months ending at the selected one (trend + last month's
 * balance), and the ledger totals. Nothing downloads transactions.
 */

const num = (v: unknown) => Number(v ?? 0);

/** 'YYYY-MM' shifted by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, '0')}` };
}

interface RawDashboard {
  days: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
}

async function callDashboard(from: string, to: string, branchId: string | null, includeHeads: boolean): Promise<RawDashboard> {
  const { data, error } = await db.rpc('finance_monthly_dashboard', {
    p_from: from,
    p_to: to,
    p_branch_id: branchId,
    p_include_heads: includeHeads,
  });
  if (error) throw error;
  const raw = (data ?? {}) as Partial<RawDashboard>;
  return { days: raw.days ?? [], ledger: raw.ledger ?? [] };
}

function toDay(r: Record<string, unknown>): FinanceDashboardDay {
  return {
    date: String(r['date']),
    branchId: (r['branchId'] as string | null) ?? null,
    demand: num(r['demand']),
    companyShare: num(r['companyShare']),
    received: num(r['received']),
    returns: num(r['returns']),
    discount: num(r['discount']),
    orders: num(r['orders']),
    unpricedLines: num(r['unpricedLines']),
    receipts: num(r['receipts']),
    returnCount: num(r['returnCount']),
    discountCount: num(r['discountCount']),
  };
}

function toLedgerRow(r: Record<string, unknown>): FinanceDashboardLedgerRow {
  return {
    date: String(r['date']),
    branchId: (r['branchId'] as string | null) ?? null,
    ledgerHeadId: String(r['ledgerHeadId']),
    ledgerHeadName: String(r['ledgerHeadName'] ?? ''),
    amount: num(r['amount']),
    entries: num(r['entries']),
  };
}

const sum = <T>(rows: T[], pick: (r: T) => number) => round2(rows.reduce((s, r) => s + pick(r), 0));

export async function getFinanceMonthlyDashboard(params: {
  month: string;
  from?: string;
  to?: string;
  branchId: string | null;
}): Promise<FinanceMonthlyDashboard> {
  const { month, branchId } = params;
  const bounds = monthBounds(month);
  const from = params.from ?? bounds.first;
  const to = params.to ?? bounds.last;
  const previousMonth = shiftMonth(month, -1);
  const trendFrom = monthBounds(shiftMonth(month, -5)).first;

  const [current, window6, ledgerTotals, branchesRes] = await Promise.all([
    callDashboard(from, to, branchId, true),
    callDashboard(trendFrom, bounds.last, branchId, false),
    db.rpc('finance_ledger_totals', { p_from: from, p_to: to, p_branch_id: branchId }),
    db.from('branches').select('id, name, is_active').order('name'),
  ]);
  if (ledgerTotals.error) throw ledgerTotals.error;
  if (branchesRes.error) throw branchesRes.error;

  const days = current.days.map(toDay);
  const ledger = current.ledger.map(toLedgerRow);
  const trendDays = window6.days.map(toDay);

  // Six whole months, oldest first — a month with no rows is a real zero month
  // inside a window that has data, so it is emitted rather than skipped.
  const trend: FinanceDashboardMonthTrend[] = [];
  for (let i = -5; i <= 0; i++) {
    const m = shiftMonth(month, i);
    const rows = trendDays.filter((d) => d.date.startsWith(m));
    const companyShare = sum(rows, (r) => r.companyShare);
    const received = sum(rows, (r) => r.received);
    trend.push({
      month: m,
      demand: sum(rows, (r) => r.demand),
      companyShare,
      received,
      balance: round2(companyShare - received),
      returns: sum(rows, (r) => r.returns),
      discount: sum(rows, (r) => r.discount),
    });
  }

  // Last month's balance per branch (and for unassigned receipts). A branch with
  // no rows at all last month gets null — "no records", not a fabricated zero.
  const prevRows = trendDays.filter((d) => d.date.startsWith(previousMonth));
  const prevByBranch = new Map<string | null, FinanceDashboardDay[]>();
  for (const r of prevRows) {
    const list = prevByBranch.get(r.branchId);
    if (list) list.push(r);
    else prevByBranch.set(r.branchId, [r]);
  }
  const previous: FinanceDashboardPreviousBalance[] = [...prevByBranch].map(([b, rows]) => ({
    branchId: b,
    balance: round2(sum(rows, (r) => r.companyShare) - sum(rows, (r) => r.received)),
  }));

  const companyShare = sum(days, (r) => r.companyShare);
  const received = sum(days, (r) => r.received);
  const lt = (Array.isArray(ledgerTotals.data) ? ledgerTotals.data[0] : ledgerTotals.data) as Record<string, unknown> | null;
  const ledgerIncome = round2(num(lt?.['total_debit']));
  const ledgerExpenseTotal = round2(num(lt?.['total_credit']));

  return {
    month,
    previousMonth,
    from,
    to,
    branchId,
    businessDate: businessDateStr(),
    generatedAt: new Date().toISOString(),
    branches: ((branchesRes.data ?? []) as { id: string; name: string; is_active: boolean }[]).map((b) => ({
      id: b.id,
      name: b.name,
      isActive: b.is_active,
    })),
    summary: {
      demand: sum(days, (r) => r.demand),
      companyShare,
      received,
      balance: round2(companyShare - received),
      lastMonthBalance: prevRows.length
        ? round2(sum(prevRows, (r) => r.companyShare) - sum(prevRows, (r) => r.received))
        : null,
      ledgerExpense: sum(ledger, (r) => r.amount),
      returns: sum(days, (r) => r.returns),
      discount: sum(days, (r) => r.discount),
      orders: sum(days, (r) => r.orders),
      receipts: sum(days, (r) => r.receipts),
      ledgerEntries: sum(ledger, (r) => r.entries),
      returnCount: sum(days, (r) => r.returnCount),
      discountCount: sum(days, (r) => r.discountCount),
      unpricedLines: sum(days, (r) => r.unpricedLines),
      ledgerIncome,
      ledgerExpenseTotal,
      ledgerNet: round2(ledgerIncome - ledgerExpenseTotal),
    },
    days,
    ledger,
    previous,
    trend,
  };
}

export async function getFinanceDashboardRecords(params: {
  metric: FinanceDashboardMetric;
  from: string;
  to: string;
  branchId: string | null;
  noBranch: boolean;
  ledgerHeadId: string | null;
  search: string | null;
  page: number;
  pageSize: number;
}): Promise<FinanceDashboardRecordsPage> {
  const { data, error } = await db.rpc('finance_dashboard_records', {
    p_metric: params.metric,
    p_from: params.from,
    p_to: params.to,
    p_branch_id: params.branchId,
    p_no_branch: params.noBranch,
    p_head_id: params.ledgerHeadId,
    p_search: params.search,
    p_limit: params.pageSize,
    p_offset: (params.page - 1) * params.pageSize,
  });
  if (error) throw error;
  const raw = (data ?? {}) as { total?: unknown; amount?: unknown; rows?: Record<string, unknown>[] };
  return {
    total: num(raw.total),
    amount: round2(num(raw.amount)),
    page: params.page,
    pageSize: params.pageSize,
    rows: (raw.rows ?? []).map(
      (r): FinanceDashboardRecord => ({
        id: String(r['id']),
        reference: (r['reference'] as string | null) ?? null,
        date: String(r['date']),
        branchId: (r['branchId'] as string | null) ?? null,
        branchName: (r['branchName'] as string | null) ?? null,
        source: String(r['source'] ?? ''),
        detail: (r['detail'] as string | null) ?? null,
        status: String(r['status'] ?? ''),
        amount: num(r['amount']),
        createdBy: (r['createdBy'] as string | null) ?? null,
        approvedBy: (r['approvedBy'] as string | null) ?? null,
      }),
    ),
  };
}
