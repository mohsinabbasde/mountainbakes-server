import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { businessDateStr, type ProductionReturn } from '../shared';
import { rowToApi } from '../utils/case';
import { applyStockMovement, commitBranchReturn } from './stock.service';
import { applyProductionStockMovement } from './production-stock.service';
import { isBusinessDayClosed } from './daily-closing.service';

/**
 * Branch → Return Stock: reading, correcting and withdrawing a branch's own returns.
 *
 * The list side is a branch-scoped read of `production_returns`; the write side is
 * the part with teeth, and it exists because a branch-initiated return is applied
 * IMMEDIATELY. `POST /api/stock/return` inserts the record already `accepted` and
 * has moved the units before the response is written, so — unlike the
 * Production-recorded path, which sits at `pending` until reviewed — there is no
 * "not yet committed" state in which an edit is free. Changing or removing one is
 * therefore never a row update; it is a compensating pair of stock movements plus
 * the row.
 *
 * WHAT A RETURN ACTUALLY DID, and so what has to be undone:
 *
 *   1. branch `stock`            −qty   (`stock_history` type 'return')
 *   2. central `production_stock` +qty   (`production_stock_history` type 'return_in')
 *
 * Reversal is the same two movements with the signs flipped, and deliberately
 * keeps the SAME `type` on both ledgers rather than filing itself as an
 * 'adjustment'. That is load-bearing: `computeStockRows` and
 * `computeBranchStockHistory` derive the Returned column as `returned -= delta`,
 * so a positive 'return' delta nets the units back out of that column and the
 * branch's Returned figure lands on what was really returned. Filed as an
 * 'adjustment' it would instead read as "returned 10, and separately +10 appeared
 * from nowhere" — the exact confusion documented at the `type: 'return'` line in
 * production-returns.routes.ts, from the other direction.
 *
 * Each compensating movement carries a FRESH refId. The `UNIQUE (ref_id,
 * product_id, type)` idempotency key means reusing the original return's id would
 * silently no-op — the original movement already holds that key — and the edit
 * would appear to succeed while moving nothing. Retry safety comes from the
 * route's `idempotent()` middleware instead, which is the layer that can tell a
 * retry from a second deliberate correction — and only for a caller that sends
 * an `Idempotency-Key`. The middleware passes a request without one straight
 * through, so for the web app these are ordinary non-idempotent writes and the
 * UI confirms before sending rather than relying on a replay being free.
 */

/** Row shape as stored; `business_date` is remapped to `date` for the API contract. */
interface ReturnRow {
  id: string;
  branch_id: string;
  product_id: string;
  product_name: string;
  qty: number | string;
  status: string;
  source: string | null;
  business_date: string;
}

/** Thrown when a return exists but may no longer be altered. Carries its own status. */
export class ReturnLockedError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ReturnLockedError';
  }
}

/** Thrown when the return is not this caller's to touch. */
export class ReturnNotFoundError extends Error {
  status = 404;
  constructor() {
    super('Return not found');
    this.name = 'ReturnNotFoundError';
  }
}

/**
 * The branch's own returns, most recent first.
 *
 * Scoped to one branch and one window rather than reusing
 * `GET /api/production-returns`: that router is `super_admin` + `production_user`
 * only and answers with every branch's returns, which is both a wider read than a
 * branch may have and a larger one than it needs.
 *
 * `business_date` is remapped to `date` here for the same reason the Production
 * list does it — `rowToApi` only camelCases keys, so without the remap every row
 * reaches the client with `date: undefined` and the table renders a column of
 * placeholders.
 */
export async function listBranchReturns(
  branchId: string,
  opts: { from?: string; to?: string } = {},
): Promise<ProductionReturn[]> {
  let q = supabaseAdmin
    .from('production_returns')
    .select('*')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false });

  if (opts.from) q = q.gte('business_date', opts.from);
  if (opts.to) q = q.lte('business_date', opts.to);

  const { data, error } = await q;
  if (error) throw error;

  const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
  return rows.map(({ businessDate, ...rest }) => ({ ...rest, date: businessDate })) as ProductionReturn[];
}

/**
 * Load a return and decide whether this caller may still alter it.
 *
 * Three gates, and each blocks a genuinely different mistake:
 *
 * - **Branch.** The row must belong to the caller's branch. Admin passes
 *   `branchId` null to skip this one.
 * - **Source.** Only `source = 'branch'` rows. A Production-recorded return is
 *   Production's record of what it received, reviewed on their own screen; a
 *   branch editing it would restate the other party's books.
 * - **Day.** Only the CURRENT business day, and only while that day is unclosed.
 *   This is the analogue of the Production path's "still pending" window: it is
 *   the span in which a change is a correction rather than a restatement of a day
 *   that has already been reported on and archived. `isBusinessDayClosed` is
 *   checked as well as the date because the 2 AM closing can land inside the
 *   business day's own tail (00:00–01:59 still belongs to the previous date).
 */
async function loadEditable(id: string, branchId: string | null): Promise<ReturnRow> {
  const { data, error } = await supabaseAdmin
    .from('production_returns')
    .select('id, branch_id, product_id, product_name, qty, status, source, business_date')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;

  const row = data as ReturnRow | null;
  // A row belonging to another branch is reported as absent rather than as
  // forbidden — "not found" does not confirm to one branch that another branch
  // has a return with this id.
  if (!row || (branchId !== null && row.branch_id !== branchId)) throw new ReturnNotFoundError();

  if (row.source !== 'branch') {
    throw new ReturnLockedError('This return was recorded by Production and can only be changed there.');
  }
  if (row.status !== 'accepted') {
    throw new ReturnLockedError(`A ${row.status} return cannot be changed.`);
  }

  const today = businessDateStr();
  if (row.business_date !== today) {
    throw new ReturnLockedError(
      `This return belongs to ${row.business_date} and can no longer be changed. Raise a Help Desk query to correct a past day.`,
    );
  }
  if (await isBusinessDayClosed(row.business_date)) {
    throw new ReturnLockedError(`${row.business_date} has been closed, so its returns can no longer be changed.`);
  }

  return row;
}

/**
 * Move `units` back OUT of the production pool and INTO the branch.
 *
 * The pool is checked first and the whole operation refused if it is short. The
 * pool tolerates negative balances by design (see `applyProductionStockMovement`)
 * — which is right for a prepare/transfer race, and wrong here: if the returned
 * units have already been sold from the counter or transferred out to another
 * branch, they are gone, and un-returning them would conjure stock that no longer
 * exists rather than record a real movement. Refusing names the reason; the
 * branch can raise a Help Desk query instead.
 *
 * Ordered pool-first for the same reason: a failure leaves NOTHING moved. Taking
 * the branch side first and then discovering the pool is short would leave the
 * two ledgers disagreeing with no transaction to roll back — PostgREST gives each
 * RPC its own.
 */
async function moveUnitsBackToBranch(
  row: ReturnRow,
  branchId: string,
  units: number,
  businessDate: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('production_stock')
    .select('balance')
    .eq('product_id', row.product_id)
    .maybeSingle();
  if (error) throw error;

  const available = Number((data as { balance: number | string } | null)?.balance ?? 0);
  if (available < units) {
    throw new ReturnLockedError(
      `Only ${available} × ${row.product_name} is left in production stock, so ${units} cannot be taken back. ` +
        'The returned units have already been used.',
    );
  }

  const refId = randomUUID();
  await applyProductionStockMovement({
    productId: row.product_id,
    productName: row.product_name,
    delta: -units,
    type: 'return_in',
    refId,
    businessDate,
  });
  // No `businessDate` here because `applyStockMovement` does not take one — it
  // stamps `businessDateStr()` itself. That is not a gap: `loadEditable` has
  // already refused anything but the current business day, so the two agree by
  // construction, and the pool call above is passed the same value explicitly.
  await applyStockMovement({
    branchId,
    productId: row.product_id,
    productName: row.product_name,
    delta: units,
    type: 'return',
    refId,
  });
}

/** Move `units` from the branch INTO the pool — the same pair a return itself does. */
async function moveUnitsToProduction(
  row: ReturnRow,
  branchId: string,
  units: number,
  businessDate: string,
): Promise<void> {
  const refId = randomUUID();
  // Branch side first here, and via `commitBranchReturn` rather than a bare
  // movement: it validates qty <= balance under a row lock and throws
  // InsufficientStockError without writing, so an over-return is refused before
  // the pool has been credited.
  await commitBranchReturn({
    branchId,
    productId: row.product_id,
    productName: row.product_name,
    qty: units,
    refId,
    businessDate,
  });
  await applyProductionStockMovement({
    productId: row.product_id,
    productName: row.product_name,
    delta: units,
    type: 'return_in',
    refId,
    businessDate,
  });
}

/**
 * Change a return's quantity and/or reason.
 *
 * Only the DIFFERENCE is moved. Reversing the whole return and re-applying it at
 * the new figure would foot to the same balances, but it writes four movements
 * where two will do and — worse — briefly returns every unit to the branch, so a
 * concurrent sale could take units the branch was never meant to have back.
 *
 * Raising the quantity can fail (the branch may no longer hold the extra units);
 * lowering it can fail too (the pool may no longer hold them). Both refuse with
 * nothing written, because the movement is attempted BEFORE the row is touched.
 *
 * The one window this leaves is the reverse: units moved, then the row update
 * fails, so the record still reads the old figure while the ledger has already
 * changed. That is the same split-transaction weakness the whole return path
 * carries (see the note in migration 20260719000005's `production_returns`
 * header) and closing it properly means a Postgres function, not a reordering
 * here — every ordering leaves one of the two halves exposed.
 */
export async function reviseBranchReturn(params: {
  id: string;
  branchId: string | null;
  qty: number;
  reason?: string;
}): Promise<ProductionReturn> {
  const row = await loadEditable(params.id, params.branchId);
  const branchId = row.branch_id;
  const businessDate = row.business_date;
  const oldQty = Number(row.qty);
  const diff = params.qty - oldQty;

  if (diff > 0) {
    await moveUnitsToProduction(row, branchId, diff, businessDate);
  } else if (diff < 0) {
    await moveUnitsBackToBranch(row, branchId, -diff, businessDate);
  }

  const patch: Record<string, unknown> = { qty: params.qty };
  if (params.reason !== undefined) patch['reason'] = params.reason;

  const { data, error } = await supabaseAdmin
    .from('production_returns')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .single();
  if (error) throw error;

  const { businessDate: bd, ...rest } = rowToApi<Record<string, unknown>>(data);
  return { ...rest, date: bd } as ProductionReturn;
}

/**
 * Withdraw a return entirely: units back to the branch, then the record removed.
 *
 * The row is DELETED rather than flagged. The stock ledgers keep the full story —
 * the original movement and its reversal both stay in `stock_history` and
 * `production_stock_history`, so the audit trail is intact — while
 * `production_returns` is the list of returns that stand, and a withdrawn one
 * does not. Leaving a tombstone here would put it back on Production's Returns
 * screen as a return they must account for.
 *
 * NOT ATOMIC, and it cannot be made so from here: the two stock movements and
 * the delete are three PostgREST calls and so three transactions. The stock moves
 * first because that is the failure that reports itself — a refused reversal
 * leaves the return standing and the branch sees an unchanged row. The reverse
 * order would delete the record and then discover the units cannot come back,
 * losing the only remaining description of what to put right. If the delete
 * itself fails after the units have moved, the row survives with its units
 * already returned to the branch and a second withdraw would move them twice, so
 * the route wraps this in `idempotent()`; a true fix is a
 * `withdraw_branch_return(p_id)` Postgres function, the same shape as
 * `commit_branch_return`.
 */
export async function withdrawBranchReturn(id: string, branchId: string | null): Promise<void> {
  const row = await loadEditable(id, branchId);
  await moveUnitsBackToBranch(row, row.branch_id, Number(row.qty), row.business_date);

  const { error } = await supabaseAdmin.from('production_returns').delete().eq('id', id);
  if (error) throw error;
}
