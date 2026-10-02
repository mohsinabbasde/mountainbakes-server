-- 135: edit and delete a ledger voucher directly from the Daily Ledger.
--
-- Migration 133 made every correction change the voucher in place. What was
-- still missing is the plain Admin action the owner's ledger rules describe:
--
--     EDIT   = change the same entry. Same PV-/RV- number, no reversal, no new
--              voucher, no replacement transaction.
--     DELETE = delete the entry. No reversal, no new voucher.
--     NEW    = the only operation that draws a new PV-/RV- number.
--
-- This adds the two things that needs:
--
--   * updated_at / updated_by / updated_by_name on ledger_entries, stamped by
--     every in-place edit, so the book says when a voucher last changed and who
--     changed it. The before/after values go to finance_audit_logs, written by
--     the API as for every other finance write.
--   * edit_finance_ledger_entry — the API's entry point. It adds optimistic
--     concurrency to app.edit_ledger_entry: the caller says what each field held
--     when the form was opened, and a voucher somebody else changed since is
--     refused (MBCON) instead of silently overwritten. The whole edit is one
--     transaction; a refusal anywhere leaves the voucher exactly as it was.
--
-- The voucher number, its place in the posting order and its side of the book
-- are not parameters and cannot be sent: p_set carries only the editable
-- fields, and the trigger refuses the rest even inside the edit window.
--
-- Delete needs no new function: reverse_finance_ledger_entry with no corrected
-- amount removes the voucher and recomputes the balances (133).
-- ---------------------------------------------------------------------------

-- 1. Who last changed a voucher, and when. Not money-bearing: the immutability
--    trigger does not list them, so only the edit paths below ever write them.
alter table ledger_entries
  add column if not exists updated_at      timestamptz,
  add column if not exists updated_by      uuid references users (id) on delete set null,
  add column if not exists updated_by_name text;

-- 2. app.edit_ledger_entry — 133's body, stamping the three columns above.
create or replace function app.edit_ledger_entry(
  p_entry_id   uuid,
  p_set        jsonb,
  p_actor_id   uuid,
  p_actor_name text,
  p_today      date
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_orig        ledger_entries%rowtype;
    v_head        ledger_heads%rowtype;
    v_old_amount  numeric(14,2);
    v_amount      numeric(14,2);
    v_head_id     uuid;
    v_head_name   text;
    v_branch_id   uuid;
    v_branch_name text;
    v_date        date;
    v_method      text;
    v_account     finance_account;
    v_desc        text;
    v_closed      date;
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;

    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry not found, or it has already been deleted';
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % was reversed by % and is no longer part of the book. Correct the entry that replaced it.',
        v_orig.voucher_no,
        coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), 'another entry');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is a reversing entry and cannot be corrected', v_orig.voucher_no;
    end if;

    v_old_amount := greatest(v_orig.debit, v_orig.credit);
    v_amount := case when p_set ? 'amount' then round((p_set ->> 'amount')::numeric, 2) else v_old_amount end;
    if v_amount <= 0 then
      raise exception 'the amount of voucher % must be greater than 0. Delete the record instead.', v_orig.voucher_no;
    end if;

    v_head_id   := v_orig.ledger_head_id;
    v_head_name := v_orig.ledger_head_name;
    if p_set ? 'ledgerHeadId' and (p_set ->> 'ledgerHeadId')::uuid is distinct from v_orig.ledger_head_id then
      select * into v_head from ledger_heads where id = (p_set ->> 'ledgerHeadId')::uuid;
      if not found then
        raise exception 'that category does not exist';
      end if;
      if not v_head.is_active then
        raise exception 'category "%" is inactive and cannot accept entries', v_head.name;
      end if;
      if v_head.type <> v_orig.ledger_head_type then
        raise exception
          'voucher % is % and "%" is an % category. Choose another % category, or delete the record and enter it again.',
          v_orig.voucher_no, v_orig.ledger_head_type, v_head.name, v_head.type, v_orig.ledger_head_type;
      end if;
      v_head_id := v_head.id;
      v_head_name := v_head.name;
    end if;

    if p_set ? 'branchId' then
      if nullif(btrim(p_set ->> 'branchId'), '') is null then
        v_branch_id := null;
        v_branch_name := null;
      else
        select id, name into v_branch_id, v_branch_name from branches where id = (p_set ->> 'branchId')::uuid;
        if v_branch_id is null then
          raise exception 'that branch does not exist';
        end if;
      end if;
    else
      v_branch_id := v_orig.branch_id;
      v_branch_name := v_orig.branch_name;
    end if;

    v_date := case when p_set ? 'entryDate' then (p_set ->> 'entryDate')::date else v_orig.entry_date end;
    if v_date <> v_orig.entry_date and v_date > p_today then
      raise exception 'the date of a voucher cannot be in the future';
    end if;

    v_method  := case when p_set ? 'paymentMethod' then nullif(btrim(p_set ->> 'paymentMethod'), '') else v_orig.payment_method end;
    v_account := case when p_set ? 'account' then (p_set ->> 'account')::finance_account else v_orig.account end;
    v_desc    := case when p_set ? 'description' then btrim(p_set ->> 'description') else v_orig.description end;
    if length(v_desc) = 0 then
      raise exception 'the description of a voucher cannot be empty';
    end if;

    -- A closed day is signed off: nothing on it changes and nothing lands on it.
    select business_date into v_closed
      from finance_day_closings
     where business_date in (v_orig.entry_date, v_date)
     order by business_date limit 1;
    if v_closed is not null then
      raise exception
        'the finance day % is closed, so voucher % cannot be changed on it or moved onto it. Reopen the day first.',
        to_char(v_closed, 'DD-Mon-YYYY'), v_orig.voucher_no;
    end if;

    perform set_config('app.allow_ledger_edit', 'on', true);
    update ledger_entries
       set entry_date       = v_date,
           ledger_head_id   = v_head_id,
           ledger_head_name = v_head_name,
           branch_id        = v_branch_id,
           branch_name      = v_branch_name,
           description      = v_desc,
           debit            = case when v_orig.debit  > 0 then v_amount else 0 end,
           credit           = case when v_orig.credit > 0 then v_amount else 0 end,
           account          = v_account,
           payment_method   = v_method,
           updated_at       = now(),
           updated_by       = p_actor_id,
           updated_by_name  = p_actor_name
     where id = v_orig.id;
    perform set_config('app.allow_ledger_edit', 'off', true);

    -- The balance chain runs in posting order, so only a changed figure moves it.
    if v_amount <> v_old_amount then
      perform recompute_finance_ledger_balances();
    end if;

    -- `ledgerAmended` stays false: nothing was reversed and no new voucher was
    -- posted, so there is no reversal or corrected voucher number to report and
    -- no document needs relinking — its ledger_entry_id still names this row.
    return jsonb_build_object(
      'ledgerAmended',    false,
      'editedInPlace',    true,
      'voucherNo',        v_orig.voucher_no,
      'correctedEntryId', v_orig.id
    );
  end;
  $$;

-- 3. The API's entry point: the same edit, refused when the voucher has changed
--    since the form was opened.
--
-- p_set       { amount, entryDate, ledgerHeadId, branchId, paymentMethod,
--               account, description } — any subset
-- p_expected  the same keys, holding what the form showed. A key absent from
--             p_expected is not checked.
create or replace function edit_finance_ledger_entry(
  p_entry_id   uuid,
  p_set        jsonb,
  p_expected   jsonb,
  p_actor_id   uuid,
  p_actor_name text,
  p_today      date
) returns setof ledger_entries
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_row     ledger_entries%rowtype;
    v_key     text;
    v_current text;
  begin
    if p_set is null or jsonb_typeof(p_set) <> 'object' or p_set = '{}'::jsonb then
      raise exception 'No changes detected.';
    end if;

    select * into v_row from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'Ledger entry not found, or it has already been deleted.' using errcode = 'MBNFD';
    end if;

    for v_key in select jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
      v_current := case v_key
        when 'amount'        then greatest(v_row.debit, v_row.credit)::text
        when 'entryDate'     then v_row.entry_date::text
        when 'ledgerHeadId'  then coalesce(v_row.ledger_head_id::text, '')
        when 'branchId'      then coalesce(v_row.branch_id::text, '')
        when 'paymentMethod' then coalesce(v_row.payment_method, '')
        when 'account'       then v_row.account::text
        when 'description'   then v_row.description
        else null
      end;
      if v_current is null then
        raise exception 'field "%" cannot be edited on a ledger entry', v_key;
      end if;
      if v_key = 'amount' then
        if round(v_current::numeric, 2) <> round(coalesce(nullif(btrim(p_expected ->> v_key), ''), '0')::numeric, 2) then
          raise exception
            'Voucher % was changed by another user (its amount is now %). Reload it and make your change again.',
            v_row.voucher_no, v_current using errcode = 'MBCON';
        end if;
      elsif btrim(v_current) <> btrim(coalesce(p_expected ->> v_key, '')) then
        raise exception
          'Voucher % was changed by another user. Reload it and make your change again.',
          v_row.voucher_no using errcode = 'MBCON';
      end if;
    end loop;

    perform app.edit_ledger_entry(p_entry_id, p_set, p_actor_id, p_actor_name, p_today);

    return query select * from ledger_entries where id = p_entry_id;
  end;
  $$;

revoke all on function edit_finance_ledger_entry(uuid, jsonb, jsonb, uuid, text, date) from public, anon, authenticated;
grant execute on function edit_finance_ledger_entry(uuid, jsonb, jsonb, uuid, text, date) to service_role;
