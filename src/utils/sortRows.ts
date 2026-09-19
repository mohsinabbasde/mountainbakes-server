/**
 * Sort helper for the handful of list endpoints that cannot express their
 * ordering as a single `.order()` — a cross-table join resolved in JS
 * (payroll's `outstandingOnly` advances), or rows built/aggregated in memory
 * (a report). Everywhere else, prefer a real `.order()` on the query.
 *
 * Null handling mirrors the frontend's `useTableSort.applyClientSort`
 * (`frontend/src/lib/table/useTableSort.ts`) so a value that is missing sorts
 * the same way whether the table got there via the DB or via JS.
 */
export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const aNil = a == null;
  const bNil = b == null;
  if (aNil && bNil) return 0;
  if (aNil) return 1; // nulls last, regardless of direction — sortRows flips this for desc
  if (bNil) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Sorts a copy of `rows` by `accessor`. `accessor === null` means no valid
 * sort key was requested (an unrecognized `sortBy`, or none given) — returns
 * `rows` unchanged rather than guessing at a default here, since every
 * caller already has its own default `.order()`/comparator for that case.
 */
export function sortRows<T>(
  rows: T[],
  accessor: ((row: T) => string | number | null | undefined) | null,
  dir: 'asc' | 'desc',
): T[] {
  if (!accessor) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * compareValues(accessor(a), accessor(b)));
}
