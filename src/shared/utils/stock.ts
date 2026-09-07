// Shared stock-status helpers used by both the API (validation, notifications)
// and the web app (colour bands, warnings) so the two never drift apart.

/**
 * A product is "low on stock" once its available balance drops below this many
 * units — the branch is prompted to raise a Production Order. Distinct from the
 * colour bands below: this is the alert threshold, those are the visual scale.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Colour band for an available balance. Maps to the spec's four levels:
 *  - `healthy`  > 20   (green)
 *  - `moderate` 6–20   (orange)
 *  - `critical` 1–5    (red)
 *  - `out`      0      (dark red)
 */
export type StockLevel = 'healthy' | 'moderate' | 'critical' | 'out';

export function stockLevel(available: number): StockLevel {
  if (available <= 0) return 'out';
  if (available <= 5) return 'critical';
  if (available <= 20) return 'moderate';
  return 'healthy';
}

/** True when a product is running low but not yet out (1 .. threshold-1). */
export function isLowStock(available: number): boolean {
  return available > 0 && available < LOW_STOCK_THRESHOLD;
}

/**
 * True when a product's day is worth a row on a stock sheet: any of the five
 * heads a sheet prints — Opening, New (received), Sold, Returned, Balance — is
 * non-zero. Balance alone is not enough — a product that opened at 5 and sold 5
 * closes at 0 and still has to be shown — and `adjustment` is not tested
 * separately because it cannot be the only non-zero figure: the row reconciles
 * as opening + new − sold − returned + adjustment = balance, so an adjustment
 * with every other head at zero is itself zero.
 *
 * Shared because two surfaces apply it and must agree on which products they
 * list: the API filters the Branch Closing sheet with it (`activityOnly`), and
 * the branch Stock page filters its table with it in the browser. Compared on
 * the derived numeric values, not on a rounded display string, so a fractional
 * quantity is never mistaken for nothing.
 */
export function hasStockActivity(r: {
  opening: number;
  newQty: number;
  sold: number;
  returned: number;
  balance: number;
}): boolean {
  return r.opening !== 0 || r.newQty !== 0 || r.sold !== 0 || r.returned !== 0 || r.balance !== 0;
}
