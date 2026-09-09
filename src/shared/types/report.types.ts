export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type ExportFormat = 'pdf' | 'excel' | 'csv';

export interface DailySalesData {
  date: string;
  totalOrders: number;
  totalRevenue: number;
  totalCancelled: number;
  expenses?: number;
  profit?: number;
}

export interface PaymentMethodBreakdown {
  method: string;
  total: number;
  count: number;
}

export interface BudgetSummary {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BranchSalesData {
  branchId: string;
  branchName: string;
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
}

/**
 * Revenue grouped by the category snapshot on the sold line.
 *
 * Deliberately NOT derivable from `topProducts`: that array is capped at the ten
 * best sellers, so folding it into categories would report a fraction of each
 * category's revenue under the category's own name — a wrong number that reads
 * exactly like a right one. This is computed over every line in range.
 *
 * `categoryName` is the snapshot stored on `order_items`, not a join to the live
 * category, so a renamed or deleted category still reports under the name it was
 * sold as. Lines whose snapshot is empty are grouped as `Uncategorised` rather
 * than dropped, or the parts will not sum to the total.
 */
export interface CategoryBreakdown {
  categoryName: string;
  totalQty: number;
  totalRevenue: number;
}

export interface TopProduct {
  productId: string;
  productName: string;
  categoryName: string;
  totalQty: number;
  totalRevenue: number;
}

export interface ReportSummary {
  period: ReportPeriod;
  from: string;
  to: string;
  totalOrders: number;
  totalRevenue: number;
  /** Discount given on non-cancelled, non-staff sales in range. Already deducted from totalRevenue. */
  totalDiscount: number;
  /** Value of staff (unpaid) sales in range. Excluded from totalRevenue and profit. */
  staffTotal: number;
  totalCancelled: number;
  totalPending: number;
  averageOrderValue: number;
  totalExpenses: number;
  totalProfit: number;
  dailyData: DailySalesData[];
  /**
   * `branchData` / `topProducts` / `categoryBreakdown` / `paymentMethodBreakdown`
   * are all optional for the same reason: `GET /api/reports/summary?fields=basic`
   * (the Branch Dashboard's request — see BranchDashboard.tsx) skips computing
   * all four server-side and omits them from the response entirely, rather than
   * sending empty arrays a caller could mistake for "computed and zero". Also
   * covers a client newer than the API it is talking to — the mobile app ships
   * on its own cycle and `categoryBreakdown` arrived after some builds were
   * already in shops. Either way: treat "absent" as "not reported", never as zero.
   */
  branchData?: BranchSalesData[];
  topProducts?: TopProduct[];
  categoryBreakdown?: CategoryBreakdown[];
  paymentMethodBreakdown?: PaymentMethodBreakdown[];
  budget?: BudgetSummary;
}
