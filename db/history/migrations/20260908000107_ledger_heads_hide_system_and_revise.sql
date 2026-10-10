-- 107: Ledger heads — hide system heads, keep the postings, revise the chart.
--
-- The product owner asked for five expense heads to go from the Finance Ledger
-- Heads list — Branch Share Payout, Adjustments, Company Expenses, Office
-- Expenses, Production Expenses — and three to be added: Kitchen Expenses,
-- Stationery Expense, Travelling and PR.
--
-- A head is never DELETED (migration 52): every voucher ever filed under it
-- names it, and the FK from ledger_entries is ON DELETE RESTRICT. "Delete" here
-- means DEACTIVATE — the head leaves every picker and the active list, and its
-- history stays readable.
--
-- Three of the five are SYSTEM heads, and until now a system head could not be
-- deactivated at all, because the automatic postings resolve it by code and
-- `post_finance_ledger_entry` refused an inactive head. Both rules change here,
-- together, so the pair stays consistent:
--
--   1. `post_finance_ledger_entry` refuses an inactive head for MANUAL entries
--      only. A branch-share payout, a bonus, a salary run or a correction still
--      posts to its head whether or not a person can pick it — which is the
--      point of a system head.
--   2. `app.protect_system_ledger_heads` lets a system head be deactivated. It
--      still cannot be deleted, re-coded or re-typed.
--
-- Nothing is renumbered, nothing is deleted, and no existing voucher changes.

-- ===========================================================================
-- 1. System heads may be hidden, never removed
-- ===========================================================================
create or replace function app.protect_system_ledger_heads() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      if old.is_system then
        raise exception 'ledger head % is a system head and cannot be deleted', old.code;
      end if;
      return old;
    end if;

    -- The code is what the automatic postings resolve by, and reports group on
    -- it. Renaming or hiding the head is fine; re-coding it is not.
    if old.code is distinct from new.code then
      raise exception 'ledger head code is immutable (% -> %); create a new head instead', old.code, new.code;
    end if;
    if old.type is distinct from new.type then
      raise exception 'ledger head type is immutable; income and expense heads are not interchangeable';
    end if;
    return new;
  end;
  $$;

-- ===========================================================================
-- 2. A hidden head still accepts the system's own postings
-- ===========================================================================
--
-- Redefined in full (the body is migration 94's, with one condition changed —
-- the one marked "Migration 107" below) because `create or replace function`
-- replaces the whole body.
create or replace function post_finance_ledger_entry(
  p_entry_date        date,
  p_ledger_head_id    uuid,
  p_description       text,
  p_debit             numeric,
  p_credit            numeric,
  p_account           finance_account,
  p_source_type       finance_ledger_source,
  p_source_id         uuid          default null,
  p_branch_id         uuid          default null,
  p_branch_name       text          default null,
  p_payment_method    text          default null,
  p_approved_by       uuid          default null,
  p_approved_by_name  text          default null,
  p_created_by        uuid          default null,
  p_created_by_name   text          default null,
  p_reverses_entry_id uuid          default null
) returns ledger_entries
  language plpgsql
  as $$
  declare
    v_head    ledger_heads%rowtype;
    v_prev    numeric(14,2);
    v_entry   ledger_entries%rowtype;
    v_debit   numeric(14,2) := round(coalesce(p_debit, 0), 2);
    v_credit  numeric(14,2) := round(coalesce(p_credit, 0), 2);
  begin
    if (v_debit > 0) = (v_credit > 0) then
      raise exception 'a ledger entry must be exactly one of debit or credit (got debit=%, credit=%)',
        v_debit, v_credit;
    end if;

    select * into v_head from ledger_heads where id = p_ledger_head_id;
    if not found then
      raise exception 'ledger head % does not exist', p_ledger_head_id;
    end if;
    -- An inactive head may still be REVERSED against (the original posting
    -- predates the deactivation), but nothing new may be filed under it.
    -- Migration 107: an inactive head refuses MANUAL entries only. A head the
    -- automatic postings resolve by code (branch share payout, bonus, salary,
    -- adjustment) may be hidden from the pickers and still be posted to by the
    -- workflow that owns it — hiding a head from people is not the same as
    -- closing it to the system.
    if not v_head.is_active and p_reverses_entry_id is null and p_source_type = 'manual' then
      raise exception 'ledger head % (%) is inactive and cannot accept new entries', v_head.code, v_head.name;
    end if;

    if exists (select 1 from finance_day_closings where business_date = p_entry_date) then
      raise exception
        'the finance day % is closed. Post the correction to an open date — a closed '
        'day is locked so its reported closing balance stays the one that was signed off.',
        p_entry_date;
    end if;

    -- Serialise every posting: the running balance below is only meaningful if
    -- no other posting can slip between the read and the insert.
    perform pg_advisory_xact_lock(hashtext('finance_ledger_post'));

    select balance into v_prev
      from ledger_entries where deleted_at is null order by seq desc limit 1;
    v_prev := coalesce(v_prev, 0);

    insert into ledger_entries (
      voucher_no, entry_date, ledger_head_id, ledger_head_name, ledger_head_type,
      branch_id, branch_name, description, debit, credit, balance, account,
      payment_method, source_type, source_id, reverses_entry_id,
      approved_by, approved_by_name, created_by, created_by_name
    ) values (
      -- Exactly one side is non-zero (the CHECK at the top of this function
      -- guarantees it), so this never falls through to the wrong series: debit
      -- is money in, everything else is money out.
      case when v_debit > 0
        then app.next_finance_number('finance_receipt_voucher', 'RV')
        else app.next_finance_number('finance_payment_voucher', 'PV')
      end,
      p_entry_date, v_head.id, v_head.name, v_head.type,
      p_branch_id, p_branch_name, p_description, v_debit, v_credit,
      v_prev + v_debit - v_credit, p_account,
      p_payment_method, p_source_type, p_source_id, p_reverses_entry_id,
      p_approved_by, p_approved_by_name, p_created_by, p_created_by_name
    )
    returning * into v_entry;

    return v_entry;
  end;
  $$;

-- ===========================================================================
-- 3. The chart
-- ===========================================================================
update ledger_heads
   set is_active = false
 where code in ('EXP-BRANCH-SHARE-PAYOUT', 'EXP-ADJUSTMENT', 'EXP-COMPANY', 'EXP-OFFICE', 'EXP-PRODUCTION');

insert into ledger_heads (code, name, type, group_name, is_system, sort_order) values
  ('EXP-STATIONERY', 'Stationery Expense', 'expense', 'Company',    false, 65),
  ('EXP-TRAVEL-PR',  'Travelling and PR',  'expense', 'Growth',     false, 115),
  ('EXP-KITCHEN',    'Kitchen Expenses',   'expense', 'Operations', false, 175)
on conflict (code) do nothing;
