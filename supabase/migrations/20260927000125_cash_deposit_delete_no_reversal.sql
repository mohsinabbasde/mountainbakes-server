-- 125: deleting a Cash Deposit removes it and its ledger entries — no reversal.
--
-- ─── What the owner asked for ────────────────────────────────────────────────
-- Since 120/121, deleting an approved deposit through the Help Desk stamped the
-- deposit deleted and then REVERSED every RV- voucher it had produced
-- (app.reverse_cash_transfer_entries → reverse_finance_ledger_entry). The
-- reversal is a new voucher on the Credit side ("Reversal of RV-… — cash
-- transfer CT-… deleted under Q-…"), so a deleted Income deposit left two rows
-- in the Daily Ledger, one of them reading like an expense. The owner's rule:
--
--   DELETE = complete removal. The deposit and its ledger entries go; nothing
--   is posted in their place — no reversal, no credit, no debit, no adjustment.
--
-- ─── How ─────────────────────────────────────────────────────────────────────
-- The deposit's vouchers are removed the way the Help Desk already removes a
-- voucher (the 'ledger_entry' branch, 94): stamped deleted_at with the query and
-- reason, then recompute_finance_ledger_balances() closes the gap in the running
-- balance in the same transaction. A stamped row is out of every ledger read,
-- total, day summary and balance; it stays in the table only as the audit
-- record the Help Desk shows an Admin. No row is hard-deleted — the ledger
-- trigger (52/94) refuses that, and the owner chose the stamp.
--
-- Every entry the deposit ever produced goes, not just the live ones: its own
-- vouchers (source_type 'cash_transfer', source_id = deposit), and, through
-- source_id / reverses_entry_id, the reversal and re-post pairs an earlier
-- correction (120/121) chained off them. Those pairs net to zero, so the
-- balance moves by exactly the deposit's live amount; leaving them would keep
-- a trace of a deposit that no longer exists.
--
-- app.reverse_cash_transfer_entries (121) had one caller — this branch — and is
-- dropped so nothing can reintroduce a reversal on delete. Corrections
-- (amend_finance_record → app.sync_cash_transfer_entries) are unchanged: a
-- changed figure on a live deposit is still reversed and re-posted.
--
-- Deposits deleted before this migration keep their reversal pair until
-- migration 126 removes it.
-- ---------------------------------------------------------------------------

-- 1. Every ledger entry a deposit produced, reversals and re-posts included.
create or replace function app.cash_transfer_ledger_chain(p_id uuid)
  returns setof uuid
  language sql stable
  as $$
    with recursive chain(id) as (
      select id from ledger_entries
       where source_type = 'cash_transfer' and source_id = p_id
      union
      -- reverse_finance_ledger_entry posts its reversal (and any corrected
      -- re-post) as source_type 'adjustment', source_id = the original.
      select e.id from ledger_entries e join chain c
        on (e.source_type = 'adjustment' and e.source_id = c.id) or e.reverses_entry_id = c.id
    )
    select id from chain
  $$;

-- 2. Stamp that chain deleted and close the balance gap. Returns the voucher
--    numbers removed (null when there were none) and the recompute result.
create or replace function app.delete_cash_transfer_entries(
  p_id          uuid,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text,
  p_query_id    uuid,
  p_query_no    text
) returns jsonb
  language plpgsql
  as $$
  declare
    v_nos        text;
    v_recompute  jsonb;
  begin
    with removed as (
      update ledger_entries
         set deleted_at       = now(),
             deleted_by       = p_actor_id,
             deleted_by_name  = p_actor_name,
             delete_reason    = p_reason,
             deleted_query_id = p_query_id,
             deleted_query_no = p_query_no
       where id in (select app.cash_transfer_ledger_chain(p_id)) and deleted_at is null
      returning voucher_no, seq
    )
    select string_agg(voucher_no, ', ' order by seq) into v_nos from removed;

    if v_nos is not null then
      v_recompute := recompute_finance_ledger_balances();
    end if;

    return jsonb_build_object('voucherNos', v_nos, 'recompute', v_recompute);
  end;
  $$;

revoke all on function app.cash_transfer_ledger_chain(uuid) from public, anon, authenticated;
revoke all on function app.delete_cash_transfer_entries(uuid, text, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function app.cash_transfer_ledger_chain(uuid) to service_role;
grant execute on function app.delete_cash_transfer_entries(uuid, text, uuid, text, uuid, text) to service_role;

-- 3. soft_delete_finance_record — 121's body; the cash_transfer branch removes
--    the deposit's entries instead of reversing them.
create or replace function soft_delete_finance_record(
  p_reference_type text,
  p_reference_id   uuid,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_query_id       uuid,
  p_query_no       text
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ref       text;
    v_recompute jsonb;
    v_ct_ledger jsonb;
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'the query names no finance record');
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'a deletion must carry a reason';
    end if;

    case p_reference_type

      when 'ledger_entry' then
        update ledger_entries
           set deleted_at       = now(),
               deleted_by       = p_actor_id,
               deleted_by_name  = p_actor_name,
               delete_reason    = p_reason,
               deleted_query_id = p_query_id,
               deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning voucher_no into v_ref;

        -- The chain has a hole in it the moment the stamp lands, and it is
        -- closed inside the same transaction — the book is never observable
        -- with a balance that does not add up. Same advisory lock
        -- post_finance_ledger_entry takes, and re-entrant within a transaction.
        if v_ref is not null then
          v_recompute := recompute_finance_ledger_balances();
        end if;

      when 'income_approval' then
        update finance_income_approvals
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning reference_no into v_ref;

      when 'finance_transaction' then
        update finance_transactions
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning txn_no into v_ref;

      when 'salary_payment' then
        update salary_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning salary_no into v_ref;

      when 'employee_advance' then
        update employee_advances
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning advance_no into v_ref;

      when 'partner_expense' then
        update partner_expenses
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning expense_no into v_ref;

      when 'branch_share_payment' then
        update branch_share_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning payment_no into v_ref;

      -- Migration 125. The deposit and every ledger entry it produced are
      -- removed together, in this transaction. Nothing is posted: no reversal,
      -- no credit, no adjustment. A second delete finds the deposit already
      -- stamped and touches nothing.
      when 'cash_transfer' then
        update cash_transfers
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning transfer_no into v_ref;

        if v_ref is not null then
          v_ct_ledger := app.delete_cash_transfer_entries(
            p_reference_id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no
          );
          v_recompute := v_ct_ledger -> 'recompute';
        end if;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already deleted, or no longer present');
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      'ledgerRemoved',     v_ct_ledger ->> 'voucherNos',
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;

revoke all on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  to service_role;

-- 4. The reversal-on-delete helper had one caller, replaced above.
drop function if exists app.reverse_cash_transfer_entries(uuid, date, text, uuid, text);
