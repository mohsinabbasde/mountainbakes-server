-- 64: recompute the running balance chain as part of the deletion that breaks it.
--
-- WHY THIS EXISTS. Migration 62 diagnosed the problem correctly and wrote the
-- cure — recompute_finance_ledger_balances() — but only ever CALLED it once, on
-- its own last line, to repair the six vouchers that had already gone. It never
-- wired the cure to the wound. delete_finance_ticket_source() (migration 61) was
-- left exactly as it was, so the very next Help Desk deletion punched the same
-- hole again, and the Daily Ledger's Opening balance / Balance column / Carried
-- forward went back to reporting a figure the surviving rows do not add up to.
--
-- That is what happened, and it will keep happening for as long as the two live
-- apart. This file makes the repair part of the deletion itself: same function,
-- same transaction, so there is no window in which the book is inconsistent and
-- nothing for an operator to remember to run afterwards.
--
-- Only the 'ledger_entry' branch needs it. Deleting a salary payment, a partner
-- expense or an income approval leaves the ledger untouched (their FK points AT
-- the voucher, not the other way round — see migration 61, which nulls those
-- references rather than cascading), so the chain is undisturbed and there is
-- nothing to rewrite.
--
-- Everything migration 62 said about what `balance` now means still holds and is
-- not restated here: after a deletion the column holds the book balance implied
-- by the rows that STILL EXIST, which is the same figure finance_day_summary()
-- and finance_ledger_totals() already report. Reversal via
-- reverse_finance_ledger_entry() remains the correct way to fix a wrong number
-- and needs none of this — it leaves the chain intact by construction.

-- ---------------------------------------------------------------------------
-- delete_finance_ticket_source(reference_type, reference_id)
--
-- Unchanged from migration 61 except for the recompute after the ledger delete
-- and the `balancesRewritten` field it adds to the result, which lets the API
-- record in the audit trail how much of the book the deletion moved.
--
-- The recompute takes pg_advisory_xact_lock on the same key that
-- post_finance_ledger_entry uses. Taking it here, inside the deleting
-- transaction, is what closes the race the two-step version had: a posting that
-- landed between the delete and a separately-invoked repair would chain onto a
-- balance the repair was about to overwrite. Advisory locks are re-entrant
-- within a transaction, so nesting the call is safe.
-- ---------------------------------------------------------------------------
create or replace function delete_finance_ticket_source(
  p_reference_type text,
  p_reference_id   uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ref       text;
    v_recompute jsonb;
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'no reference id');
    end if;

    case p_reference_type

      when 'ledger_entry' then
        select voucher_no into v_ref from ledger_entries where id = p_reference_id;
        if v_ref is null then
          return jsonb_build_object('deleted', false, 'reason', 'already gone');
        end if;

        -- Every FK pointing at this row is ON DELETE RESTRICT, which is checked
        -- per row and cannot be deferred, so the references have to be cleared
        -- before the delete rather than cascaded by it. The source documents are
        -- deliberately kept: destroying a salary payment because someone deleted
        -- a query about it would be a second, unasked-for deletion.
        update ledger_entries
           set reverses_entry_id    = nullif(reverses_entry_id, p_reference_id),
               reversed_by_entry_id = nullif(reversed_by_entry_id, p_reference_id)
         where reverses_entry_id = p_reference_id
            or reversed_by_entry_id = p_reference_id;

        update finance_transactions   set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update salary_payments        set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update partner_expenses       set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update branch_share_payments  set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update branch_share_payments  set bonus_ledger_entry_id = null
         where bonus_ledger_entry_id = p_reference_id;

        -- Transaction-local, so it is gone the moment this statement's
        -- transaction ends, however it ends.
        perform set_config('app.allow_ledger_delete', 'on', true);
        delete from ledger_entries where id = p_reference_id;
        perform set_config('app.allow_ledger_delete', 'off', true);

        -- The point of this migration. Same transaction as the delete: the book
        -- is never observable with a hole in its chain.
        v_recompute := recompute_finance_ledger_balances();

      when 'income_approval' then
        select reference_no into v_ref from finance_income_approvals where id = p_reference_id;
        delete from finance_income_approvals where id = p_reference_id;

      when 'finance_transaction' then
        select txn_no into v_ref from finance_transactions where id = p_reference_id;
        delete from finance_transactions where id = p_reference_id;

      when 'salary_payment' then
        select salary_no into v_ref from salary_payments where id = p_reference_id;
        delete from salary_payments where id = p_reference_id;

      when 'partner_expense' then
        select expense_no into v_ref from partner_expenses where id = p_reference_id;
        delete from partner_expenses where id = p_reference_id;

      when 'branch_share_payment' then
        select payment_no into v_ref from branch_share_payments where id = p_reference_id;
        delete from branch_share_payments where id = p_reference_id;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already gone');
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      -- Null for every non-ledger reference type, where no chain was touched.
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;

-- Unchanged from migration 61, and repeated because `create or replace` does not
-- reset grants but a future `drop`/recreate of this file's function would: the
-- default PUBLIC execute grant on a SECURITY DEFINER function would let any
-- signed-in browser session delete a voucher over PostgREST, bypassing
-- requireFinanceTicketAdmin entirely.
revoke all on function delete_finance_ticket_source(text, uuid) from public, anon, authenticated;
grant execute on function delete_finance_ticket_source(text, uuid) to service_role;

-- Repair the drift the deletions since migration 62 have already caused — the
-- negative Opening balance / Carried forward currently showing on the Daily
-- Ledger. Idempotent: on a from-scratch replay the table is empty and this is a
-- no-op, and on a book already in step it updates zero rows.
select recompute_finance_ledger_balances();
