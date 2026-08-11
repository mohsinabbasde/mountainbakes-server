-- 61: permanently delete the record a Finance Help Desk query was raised against.
--
-- READ THIS BEFORE USING IT. Migration 52 made a posted ledger entry permanent,
-- on the reasoning that a cash book which can lose rows silently is not evidence
-- of anything, and that a mistake is corrected with a reversing entry that
-- leaves the original visible. This migration deliberately puts a hole in that
-- guarantee, at the explicit request of the product owner: deleting a Help Desk
-- query now also deletes the record it names, ledger entries included.
--
-- The consequences, stated plainly so nobody rediscovers them later:
--
--   * A voucher can now vanish. The ledger's running `balance` column on the
--     REMAINING rows is not recomputed — it was correct when it was written and
--     nothing here rewrites history — so deleting an entry from the middle of a
--     day leaves every later balance on that day carrying the deleted amount.
--     The figures reported by finance_day_summary() and finance_ledger_totals()
--     recompute from the rows that still exist, so the two will disagree.
--   * Source documents (a salary payment, a partner expense) that pointed at
--     the deleted voucher keep their own row and have their `ledger_entry_id`
--     set to NULL, which reads as "approved but never posted".
--
-- Reversal via reverse_finance_ledger_entry() remains the correct way to fix a
-- wrong figure. This is the blunt instrument, and it is restricted to
-- service_role so only the API can reach it.

-- ---------------------------------------------------------------------------
-- The escape hatch, added to the immutability trigger itself.
--
-- A transaction-local GUC rather than `alter table ... disable trigger`: the
-- ALTER form is table-wide for as long as it is off, so a concurrent session
-- could delete an unrelated entry through the same open window. `set_config(…,
-- true)` is scoped to the current transaction and reverts on commit or
-- rollback, so the bypass cannot outlive the statement that asked for it — and
-- it is visible right here, in the function that makes the promise.
--
-- Everything else about the trigger is unchanged: UPDATE is still restricted to
-- status and reversal linkage, and an ordinary DELETE still raises.
-- ---------------------------------------------------------------------------
create or replace function app.finance_ledger_immutable() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      if coalesce(current_setting('app.allow_ledger_delete', true), 'off') = 'on' then
        return old;
      end if;
      raise exception
        'ledger entry % cannot be deleted. A posted entry is permanent: correct it '
        'with a reversing or adjustment entry so the original stays visible.', old.voucher_no;
    end if;

    if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
        new.balance, new.account, new.source_type, new.source_id, new.description)
       is distinct from
       (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
        old.balance, old.account, old.source_type, old.source_id, old.description)
    then
      raise exception
        'ledger entry % is immutable. Only status and reversal linkage may change; '
        'post a reversing or adjustment entry instead.', old.voucher_no;
    end if;
    return new;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- delete_finance_ticket_source(reference_type, reference_id)
--
-- Deletes the one record a ticket names and returns what it removed, so the
-- caller can write the fact to the audit trail without a second lookup. Returns
-- `{"deleted": false}` when the row is already gone — deleting a ticket whose
-- record someone else removed first is not an error worth failing the request
-- over.
--
-- Static SQL per reference type rather than dynamic SQL over a table name: the
-- six types are a closed set, and `execute format('delete from %I', …)` on a
-- value that reached us from an HTTP request is exactly the shape of mistake
-- this module cannot afford.
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
    v_ref text;
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
      'deleted',       true,
      'referenceType', p_reference_type,
      'referenceNo',   v_ref
    );
  end;
  $$;

-- Same lockdown migration 52 applies to the posting functions: SECURITY DEFINER
-- plus the default PUBLIC execute grant would otherwise let any signed-in
-- browser session delete a voucher over PostgREST, bypassing requireFinance
-- entirely. service_role is the API and nothing else.
revoke all on function delete_finance_ticket_source(text, uuid) from public, anon, authenticated;
grant execute on function delete_finance_ticket_source(text, uuid) to service_role;
