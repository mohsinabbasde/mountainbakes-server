-- 131: Support Center — correct the DATE of a branch cash deposit.
--
-- "Change figures" on a CT- deposit could move its Cash, Easypaisa, Bank and
-- Fuel Charges and its note (migrations 120, 121), and not the business date —
-- a deposit keyed against the wrong day had to be deleted and raised again.
--
-- A pending deposit is re-dated in place; Finance approves it on the corrected
-- day. An APPROVED deposit already has its RV- receipts in the book, dated the
-- day the money moved, so each live receipt is reversed (dated today, like every
-- other correction) and posted again on the corrected date — or today, when
-- Finance has already closed that day, which is the rule approve_cash_transfer
-- follows. Nothing is edited in place and the amounts do not change.
--
-- The per-day allowance (CASH_DEPOSITS_PER_DAY, enforced by the API on create)
-- is checked here against the day the deposit is moving TO.
--
-- Returns the same shape amend_finance_record does, so the Support Center
-- records and reports a date change exactly as it does a figure change.
-- ---------------------------------------------------------------------------
create or replace function amend_cash_transfer_date(
  p_transfer_id uuid,
  p_new_date    date,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text,
  p_today       date,
  p_max_per_day integer default 3
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_row    cash_transfers%rowtype;
    v_live   ledger_entries%rowtype;
    v_rev    ledger_entries%rowtype;
    v_new    ledger_entries%rowtype;
    v_date   date;
    v_others integer;
    v_revs   text[] := '{}';
    v_posted text[] := '{}';
    v_first  uuid;
    v_all    text;
  begin
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;

    select * into v_row from cash_transfers where id = p_transfer_id and deleted_at is null for update;
    if not found then
      raise exception 'cash transfer not found, or already deleted';
    end if;
    if v_row.status = 'rejected' then
      raise exception
        'cash transfer % was rejected and is final. Nothing was booked for it; the branch records a new transfer instead.',
        v_row.transfer_no;
    end if;
    if p_new_date is null or p_new_date = v_row.business_date then
      raise exception 'cash deposit % is already dated %', v_row.transfer_no, to_char(v_row.business_date, 'DD-Mon-YYYY');
    end if;
    if p_new_date > p_today then
      raise exception 'the date of a cash deposit cannot be in the future';
    end if;

    select count(*) into v_others
      from cash_transfers
     where branch_id = v_row.branch_id and business_date = p_new_date
       and status <> 'rejected' and deleted_at is null and id <> v_row.id;
    if v_others >= p_max_per_day then
      raise exception '% already has % cash deposits on % — the limit is % a day.',
        v_row.branch_name, v_others, to_char(p_new_date, 'DD-Mon-YYYY'), p_max_per_day;
    end if;

    update cash_transfers
       set business_date   = p_new_date,
           updated_by      = p_actor_id,
           updated_by_name = p_actor_name
     where id = v_row.id;

    if v_row.status <> 'approved' or v_row.ledger_entry_id is null then
      return jsonb_build_object(
        'referenceType', 'cash_transfer', 'referenceNo', v_row.transfer_no, 'field', 'businessDate',
        'originalValue', v_row.business_date::text, 'newValue', p_new_date::text, 'difference', null,
        'ledger', jsonb_build_object('ledgerAmended', false));
    end if;

    -- Dated the corrected day, unless Finance has closed it.
    v_date := p_new_date;
    if exists (select 1 from finance_day_closings where business_date = v_date) then
      v_date := p_today;
    end if;

    for v_live in
      select * from ledger_entries
       where source_type = 'cash_transfer' and source_id = v_row.id
         and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
       order by seq
    loop
      select * into v_rev from reverse_finance_ledger_entry(
        v_live.id, p_today, p_reason, p_actor_id, p_actor_name, null, null
      ) limit 1;
      v_revs := v_revs || v_rev.voucher_no;

      -- The same receipt, on the corrected day. Still the deposit's own voucher
      -- (source cash_transfer), so later figure corrections find and re-post it.
      select * into v_new from post_finance_ledger_entry(
        p_entry_date       => v_date,
        p_ledger_head_id   => v_live.ledger_head_id,
        p_description      => v_live.description,
        p_debit            => v_live.debit,
        p_credit           => v_live.credit,
        p_account          => v_live.account,
        p_source_type      => 'cash_transfer',
        p_source_id        => v_row.id,
        p_branch_id        => v_live.branch_id,
        p_branch_name      => v_live.branch_name,
        p_payment_method   => v_live.payment_method,
        p_approved_by      => p_actor_id,
        p_approved_by_name => p_actor_name,
        p_created_by       => v_row.created_by,
        p_created_by_name  => v_row.created_by_name
      );
      v_posted := v_posted || v_new.voucher_no;
    end loop;

    select (array_agg(id order by seq))[1], string_agg(voucher_no, ', ' order by seq)
      into v_first, v_all
      from ledger_entries
     where source_type = 'cash_transfer' and source_id = v_row.id
       and status <> 'reversed' and reverses_entry_id is null and deleted_at is null;

    update cash_transfers
       set ledger_entry_id = coalesce(v_first, ledger_entry_id),
           voucher_no      = coalesce(v_all, voucher_no)
     where id = v_row.id;

    return jsonb_build_object(
      'referenceType', 'cash_transfer', 'referenceNo', v_row.transfer_no, 'field', 'businessDate',
      'originalValue', v_row.business_date::text, 'newValue', p_new_date::text, 'difference', null,
      'ledger', jsonb_build_object(
        'ledgerAmended',      array_length(v_posted, 1) is not null,
        'reversalVoucherNo',  nullif(array_to_string(v_revs, ', '), ''),
        'correctedVoucherNo', nullif(array_to_string(v_posted, ', '), '')));
  end;
  $$;

revoke all on function amend_cash_transfer_date(uuid, date, text, uuid, text, date, integer)
  from public, anon, authenticated;
grant execute on function amend_cash_transfer_date(uuid, date, text, uuid, text, date, integer)
  to service_role;
