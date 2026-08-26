import type { BranchProductionOrderItem } from '../types/production-order.types';

/**
 * Money on a production order — one definition, used by the branch order form,
 * the verification screen, the print preview and the server.
 *
 * ── THE RATE IS THE SNAPSHOT, NEVER THE LIVE PRICE ──────────────────────────
 * Every function here reads `item.unitPrice`, which the server wrote onto the
 * line when the branch submitted (§18). None of them takes a product or a price
 * list, and that is deliberate: given the live price these would happily
 * recompute a six-week-old order at today's rate and report a total the branch
 * never agreed to. Not having the live price available makes that mistake
 * unavailable too.
 *
 * ── A MISSING RATE IS NOT ZERO ──────────────────────────────────────────────
 * `unitPrice` is absent on lines raised before the column existed and on any the
 * migration-89 backfill could not resolve. `amountOf` returns null there rather
 * than 0, because 0 renders as "free" and reads as a real figure. Totals skip
 * those lines and `hasCompleteRates` says whether any were skipped, so a screen
 * can mark the total as partial instead of quietly understating it.
 */

/** The rate to bill this line at, or null when the line never recorded one. */
export function rateOf(item: Pick<BranchProductionOrderItem, 'unitPrice'>): number | null {
  const rate = item.unitPrice;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
}

/** rate × qty, or null when the rate is unknown. */
export function amountOf(
  item: Pick<BranchProductionOrderItem, 'unitPrice'>,
  qty: number,
): number | null {
  const rate = rateOf(item);
  if (rate === null) return null;
  const n = Number(qty);
  return Number.isFinite(n) ? rate * n : null;
}

/**
 * Total quantity and amount over a set of lines, at whatever quantity the caller
 * decides each line stands for.
 *
 * `qtyOf` is passed in rather than assumed because the same lines are totalled
 * two different ways: the branch's Create form totals the REQUESTED quantity
 * (§17/§18), while Awaiting Verification totals the VERIFIED one (§21/§22). One
 * function, two callers, no second copy of `rate × qty` to drift.
 */
export function totalsFor<T extends Pick<BranchProductionOrderItem, 'unitPrice'>>(
  items: readonly T[],
  qtyOf: (item: T) => number,
): { qty: number; amount: number; hasCompleteRates: boolean } {
  let qty = 0;
  let amount = 0;
  let hasCompleteRates = true;

  for (const item of items) {
    const lineQty = Number(qtyOf(item)) || 0;
    qty += lineQty;
    const lineAmount = amountOf(item, lineQty);
    // A line with no rate contributes its QUANTITY but not an amount — the count
    // is still true, and flagging the gap is more use than inventing a figure.
    if (lineAmount === null) hasCompleteRates = false;
    else amount += lineAmount;
  }

  return { qty, amount, hasCompleteRates };
}
