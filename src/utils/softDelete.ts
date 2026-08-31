/**
 * Soft delete on the finance record tables (migration 94).
 *
 * The brief's §10: only an Admin may delete a financial record, and the record
 * is STAMPED rather than destroyed, so it stays readable to an authorised admin
 * for audit. `soft_delete_finance_record()` writes the stamp; this file is the
 * other half — the part that makes the stamp mean something.
 *
 * A soft delete is only a delete if EVERY reader honours it. A single query that
 * forgets the predicate reports a row the rest of the system considers gone,
 * which is worse than not having soft delete at all: the ledger would show a
 * voucher the day summary has already excluded, and the two would disagree with
 * no way to tell which is right.
 *
 * So this is applied at every finance read AND every finance write. Writes
 * matter as much as reads and are easier to overlook: approving, posting or
 * amending a deleted salary payment must fail to match rather than quietly
 * resurrect it into the ledger.
 *
 * WHAT IS NOT COVERED HERE. Four SQL functions do their own filtering because
 * they never pass through this client — finance_day_summary,
 * finance_ledger_totals, recompute_finance_ledger_balances and
 * post_finance_ledger_entry, all redefined in migration 94. If a fifth is added,
 * it needs the predicate written into its body; nothing mechanical will catch it.
 */

/** The tables `soft_delete_finance_record()` can stamp. */
export const SOFT_DELETABLE_FINANCE_TABLES = [
  'ledger_entries',
  'finance_transactions',
  'salary_payments',
  'employee_advances',
  'partner_expenses',
  'branch_share_payments',
  'finance_income_approvals',
] as const;

export type SoftDeletableFinanceTable = (typeof SOFT_DELETABLE_FINANCE_TABLES)[number];

/**
 * The one method this helper needs from a PostgREST builder.
 *
 * Structural, rather than importing `PostgrestFilterBuilder`:
 * `@supabase/postgrest-js` is a transitive dependency of `@supabase/supabase-js`
 * and NOT a direct one, so under pnpm's isolated node_modules it does not
 * resolve from app code — the same trap `table-meta.ts` documents on the
 * frontend for `@tanstack/table-core`. Adding it to package.json to get one type
 * would pin a second copy of the client's internals against the one the SDK
 * actually uses.
 */
interface NullFilterable {
  is(column: string, value: null): unknown;
}

/**
 * Exclude soft-deleted rows.
 *
 * `.is('deleted_at', null)` rather than `.eq(...)`: PostgREST renders `eq.null`
 * as a comparison against the literal string "null", which matches nothing and
 * would silently empty every finance screen.
 *
 * Generic in the builder's own type so it is transparent in a chain —
 * `withoutDeleted(q).eq('status', 'posted')` keeps working, and so does
 * `.maybeSingle()` afterwards.
 */
export function withoutDeleted<T extends NullFilterable>(query: T): T {
  return query.is('deleted_at', null) as T;
}

/**
 * The columns the API exposes for a stamped row, for the admin-only views that
 * deliberately include them.
 *
 * Reading a deleted record is an ADMIN capability and a narrow one: the Help
 * Desk shows the record a query was raised against even after it was deleted,
 * because a query whose subject vanished is unanswerable. Nothing else asks for
 * them.
 */
export const SOFT_DELETE_COLUMNS =
  'deleted_at, deleted_by, deleted_by_name, delete_reason, deleted_query_id, deleted_query_no';
