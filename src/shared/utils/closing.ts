import type { Order } from '../types/order.types';
import type { Expense } from '../types/expense.types';

/**
 * The end-of-day money figures for one business day.
 *
 * Shared because two surfaces state them and they must agree: the Branch Closing
 * screen a shift hands over on, and the Excel export of the same window. These
 * numbers reconcile against the cash drawer, so a screen and a spreadsheet that
 * disagree by one staff sale is not a cosmetic problem.
 */
export interface ClosingTotals {
  /** Money actually charged, after discount. Excludes staff and cancelled. */
  sales: number;
  /** Given away off list price. Already deducted from `sales`, never added back. */
  discounts: number;
  expenses: number;
  /** sales − expenses. */
  net: number;
  /** Live orders (everything not cancelled), including unpaid staff ones. */
  orderCount: number;
  cancelled: number;
  /** Cash taken at the counter. Card and wallet takings never enter the till. */
  cashSales: number;
  /** Paid out of the till. */
  cashExpenses: number;
  /** What should physically be in the drawer: cashSales − cashExpenses. */
  cashInHand: number;
}

/**
 * Two rules do all the work here, and both are easy to get wrong separately:
 *
 * - A **cancelled** order is not a sale and not an order. It is counted only as
 *   the `cancelled` tally.
 * - A **staff** order is a real record that took no money. It counts as an order
 *   and it can carry a discount, but it must never reach a revenue total — which
 *   is why `sales` filters staff out while `discounts` and `orderCount` do not.
 */
export function computeClosingTotals(orders: Order[], expenses: Expense[]): ClosingTotals {
  const live = orders.filter((o) => o.status !== 'cancelled');
  const paid = live.filter((o) => o.paymentMethod !== 'staff');

  const sales = paid.reduce((s, o) => s + (o.grandTotal || 0), 0);
  const discounts = live.reduce((s, o) => s + (o.discountTotal || 0), 0);
  const expenseTotal = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  const cashSales = paid
    .filter((o) => o.paymentMethod === 'cash')
    .reduce((s, o) => s + (o.grandTotal || 0), 0);
  const cashExpenses = expenses
    .filter((e) => e.paymentMethod === 'cash')
    .reduce((s, e) => s + (e.amount || 0), 0);

  return {
    sales,
    discounts,
    expenses: expenseTotal,
    net: sales - expenseTotal,
    orderCount: live.length,
    cancelled: orders.length - live.length,
    cashSales,
    cashExpenses,
    cashInHand: cashSales - cashExpenses,
  };
}
