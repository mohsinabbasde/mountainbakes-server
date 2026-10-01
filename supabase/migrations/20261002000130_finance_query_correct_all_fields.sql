-- 130: Finance Query — correct every field of a voucher or a transaction.
--
-- Until now "Change figures" could move a ledger voucher's AMOUNT and a
-- transaction's amount and description, and nothing else: the date, the
-- category (ledger head), the branch, the payment method and the account were
-- shown and could not be touched. The owner asked for each of them to be
-- correctable from the query.
--
-- The rule migration 52 set does not move: a posted ledger entry is never
-- edited in place. A correction is still
--
--     Original  →  Reversal of the original  →  Corrected entry
--
-- with all three rows visible. What changes is that the corrected entry may now
-- differ from the original in more than its figure. The reversal is always the
-- exact mirror of the original (same head, branch, account), dated today, so
-- the wrong posting is undone where it was made; the corrected entry carries
-- the new values.
--
-- ALL the fields of one correction are applied by ONE reversal and ONE
-- corrected entry. Going field by field through amend_finance_record would
-- reverse the original for the first field and then find it already reversed
-- for the second.
--
-- Scope: ledger_entry (RV-/PV-/FV-) and finance_transaction (FTX-). Every other
-- record type keeps amend_finance_record and its existing whitelist.
--
-- What is NOT correctable, on purpose:
--   * Income ↔ Expense. A head has a type, and the type decides which side of
--     the book the money sits on. The category may change to another head of
--     the SAME type; turning income into expense is a delete and a new entry.
--   * A reversing entry, an already-reversed entry, or a deleted one.
-- ---------------------------------------------------------------------------

-- 1. Reverse a posted entry and re-post it with any of its attributes changed.
--
-- p_set keys (all optional; an absent key keeps the original's value):
--   amount, entryDate, ledgerHeadId, branchId ('' = company-wide),
--   paymentMethod, account, description
-- The corrected entry is dated `entryDate` when given, otherwise p_today — the
-- day the wrong voucher was posted is usually closed by now.
create or replace function app.repost_ledger_entry(
  p_entry_id   uuid,
  p_set        jsonb,
  p_reason     text,
  p_actor_id   uuid,
  p_actor_name text,
  p_today      date
) returns jsonb
  language plpgsql
  as $$
  declare
    v_orig        ledger_entries%rowtype;
    v_rev         ledger_entries%rowtype;
    v_new         ledger_entries%rowtype;
    v_head        ledger_heads%rowtype;
    v_amount      numeric(14,2);
    v_head_id     uuid;
    v_branch_id   uuid;
    v_branch_name text;
    v_date        date;
    v_method      text;
    v_account     finance_account;
    v_desc        text;
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;

    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry not found, or it has already been deleted';
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % has already been reversed by %. Correct the entry that replaced it.',
        v_orig.voucher_no,
        coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), 'another entry');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is itself a reversing entry and cannot be corrected', v_orig.voucher_no;
    end if;

    v_amount := case when p_set ? 'amount'
                     then round((p_set ->> 'amount')::numeric, 2)
                     else greatest(v_orig.debit, v_orig.credit) end;
    if v_amount <= 0 then
      raise exception 'the amount of a voucher must be greater than 0. Delete the record instead.';
    end if;

    v_head_id := case when p_set ? 'ledgerHeadId' then (p_set ->> 'ledgerHeadId')::uuid else v_orig.ledger_head_id end;
    if p_set ? 'ledgerHeadId' then
      select * into v_head from ledger_heads where id = v_head_id;
      if not found then
        raise exception 'that category does not exist';
      end if;
      if v_head.type <> v_orig.ledger_head_type then
        raise exception
          'voucher % is % and "%" is an % category. A correction keeps the entry on its side of the book — choose another % category, or delete the record and enter it again.',
          v_orig.voucher_no, v_orig.ledger_head_type, v_head.name, v_head.type, v_orig.ledger_head_type;
      end if;
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

    v_date := case when p_set ? 'entryDate' then (p_set ->> 'entryDate')::date else p_today end;
    if v_date > p_today then
      raise exception 'the date of a voucher cannot be in the future';
    end if;

    v_method := case when p_set ? 'paymentMethod' then nullif(btrim(p_set ->> 'paymentMethod'), '') else v_orig.payment_method end;
    v_account := case when p_set ? 'account' then (p_set ->> 'account')::finance_account else v_orig.account end;

    v_desc := case when p_set ? 'description' then btrim(p_set ->> 'description') else v_orig.description end;
    if length(v_desc) = 0 then
      raise exception 'the description of a voucher cannot be empty';
    end if;

    -- The mirror: exactly the original, on the other side, dated today.
    select * into v_rev from post_finance_ledger_entry(
      p_entry_date        => p_today,
      p_ledger_head_id    => v_orig.ledger_head_id,
      p_description       => 'Reversal of ' || v_orig.voucher_no || ' — ' || p_reason,
      p_debit             => v_orig.credit,
      p_credit            => v_orig.debit,
      p_account           => v_orig.account,
      p_source_type       => 'adjustment',
      p_source_id         => v_orig.id,
      p_branch_id         => v_orig.branch_id,
      p_branch_name       => v_orig.branch_name,
      p_payment_method    => v_orig.payment_method,
      p_approved_by       => p_actor_id,
      p_approved_by_name  => p_actor_name,
      p_created_by        => p_actor_id,
      p_created_by_name   => p_actor_name,
      p_reverses_entry_id => v_orig.id
    );

    update ledger_entries
       set status = 'reversed', reversed_by_entry_id = v_rev.id
     where id = v_orig.id;

    -- The corrected entry: the original's side, the corrected attributes.
    select * into v_new from post_finance_ledger_entry(
      p_entry_date       => v_date,
      p_ledger_head_id   => v_head_id,
      p_description      => v_desc || ' (adjustment for ' || v_orig.voucher_no || ')',
      p_debit            => case when v_orig.debit  > 0 then v_amount else 0 end,
      p_credit           => case when v_orig.credit > 0 then v_amount else 0 end,
      p_account          => v_account,
      p_source_type      => 'adjustment',
      p_source_id        => v_orig.id,
      p_branch_id        => v_branch_id,
      p_branch_name      => v_branch_name,
      p_payment_method   => v_method,
      p_approved_by      => p_actor_id,
      p_approved_by_name => p_actor_name,
      p_created_by       => p_actor_id,
      p_created_by_name  => p_actor_name
    );

    return jsonb_build_object(
      'ledgerAmended',      true,
      'reversalVoucherNo',  v_rev.voucher_no,
      'correctedVoucherNo', v_new.voucher_no,
      'correctedEntryId',   v_new.id
    );
  end;
  $$;

-- 2. Several fields of ONE voucher or transaction, applied together.
--
-- p_edits: [{ "field": "amount", "value": "3000" }, …]. Field names are the
-- API's camelCase column names; the date is `entryDate` on a voucher and
-- `businessDate` on a transaction.
--
-- Returns one object per edit, in the order given:
--   { field, referenceNo, originalValue, newValue,   -- raw, for the conflict check
--     originalText, newText,                         -- as a person reads them
--     difference, ledger }
create or replace function amend_finance_record_fields(
  p_reference_type text,
  p_reference_id   uuid,
  p_edits          jsonb,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_entry_date     date default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_today       date := coalesce(p_entry_date, (timezone('Asia/Karachi', now()))::date);
    v_is_txn      boolean := p_reference_type = 'finance_transaction';
    v_date_field  text := case when p_reference_type = 'finance_transaction' then 'businessDate' else 'entryDate' end;
    v_le          ledger_entries%rowtype;
    v_tx          finance_transactions%rowtype;
    v_ref         text;
    v_status      text;
    -- the record as it stands
    c_amount      numeric(14,2);
    c_date        date;
    c_head_id     uuid;
    c_head_name   text;
    c_head_type   ledger_head_type;
    c_branch_id   uuid;
    c_branch_name text;
    c_method      text;
    c_account     finance_account;
    c_desc        text;
    -- the record as corrected
    n_amount      numeric(14,2);
    n_date        date;
    n_head_id     uuid;
    n_head_name   text;
    n_branch_id   uuid;
    n_branch_name text;
    n_method      text;
    n_account     finance_account;
    n_desc        text;
    v_head        ledger_heads%rowtype;
    v_edit        jsonb;
    v_field       text;
    v_val         text;
    v_set         jsonb := '{}'::jsonb;
    v_out         jsonb := '[]'::jsonb;
    v_ledger      jsonb := jsonb_build_object('ledgerAmended', false);
    v_seen        text[] := '{}';
  begin
    if p_reference_type not in ('ledger_entry', 'finance_transaction') then
      raise exception 'amend_finance_record_fields does not handle "%"', p_reference_type;
    end if;
    if p_reference_id is null then
      raise exception 'nothing to amend: the query names no finance record';
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;
    if jsonb_typeof(p_edits) is distinct from 'array' or jsonb_array_length(p_edits) = 0 then
      raise exception 'No changes detected.';
    end if;

    if v_is_txn then
      select * into v_tx from finance_transactions where id = p_reference_id and deleted_at is null for update;
      if not found then raise exception 'transaction not found, or already deleted'; end if;
      v_ref := v_tx.txn_no;            v_status := v_tx.status::text;
      c_amount := v_tx.amount;         c_date := v_tx.business_date;
      c_head_id := v_tx.ledger_head_id; c_head_name := v_tx.ledger_head_name; c_head_type := v_tx.txn_type;
      c_branch_id := v_tx.branch_id;   c_branch_name := v_tx.branch_name;
      c_method := v_tx.payment_method; c_account := v_tx.account; c_desc := v_tx.description;
      if v_status = 'rejected' then
        raise exception 'transaction % was rejected and is final. Nothing was booked for it.', v_ref;
      end if;
    else
      select * into v_le from ledger_entries where id = p_reference_id and deleted_at is null for update;
      if not found then raise exception 'ledger entry not found, or it has already been deleted'; end if;
      v_ref := v_le.voucher_no;        v_status := v_le.status::text;
      c_amount := greatest(v_le.debit, v_le.credit); c_date := v_le.entry_date;
      c_head_id := v_le.ledger_head_id; c_head_name := v_le.ledger_head_name; c_head_type := v_le.ledger_head_type;
      c_branch_id := v_le.branch_id;   c_branch_name := v_le.branch_name;
      c_method := v_le.payment_method; c_account := v_le.account; c_desc := v_le.description;
    end if;

    n_amount := c_amount;       n_date := c_date;
    n_head_id := c_head_id;     n_head_name := c_head_name;
    n_branch_id := c_branch_id; n_branch_name := c_branch_name;
    n_method := c_method;       n_account := c_account;  n_desc := c_desc;

    for v_edit in select value from jsonb_array_elements(p_edits) loop
      v_field := v_edit ->> 'field';
      v_val   := btrim(coalesce(v_edit ->> 'value', ''));
      if v_field = any(v_seen) then
        raise exception 'field "%" appears twice in one correction', v_field;
      end if;
      v_seen := v_seen || v_field;

      if v_field = 'amount' then
        begin
          n_amount := round(v_val::numeric, 2);
        exception when others then
          raise exception '"%" is not a valid amount', v_val;
        end;
        if n_amount <= 0 then
          raise exception 'the amount must be greater than 0. Delete the record instead.';
        end if;
        v_set := v_set || jsonb_build_object('amount', n_amount);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_amount::text, 'newValue', n_amount::text,
          'originalText', c_amount::text, 'newText', n_amount::text, 'difference', n_amount - c_amount));

      elsif v_field = v_date_field then
        begin
          n_date := v_val::date;
        exception when others then
          raise exception '"%" is not a valid date', v_val;
        end;
        if n_date > v_today then
          raise exception 'the date cannot be in the future';
        end if;
        if exists (select 1 from finance_day_closings where business_date = n_date) then
          raise exception 'the finance day % is closed. Choose an open date.', n_date;
        end if;
        v_set := v_set || jsonb_build_object('entryDate', n_date);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_date::text, 'newValue', n_date::text,
          'originalText', to_char(c_date, 'DD-Mon-YYYY'), 'newText', to_char(n_date, 'DD-Mon-YYYY'), 'difference', null));

      elsif v_field = 'ledgerHeadId' then
        begin
          select * into v_head from ledger_heads where id = v_val::uuid;
        exception when others then
          raise exception 'that category does not exist';
        end;
        if v_head.id is null then raise exception 'that category does not exist'; end if;
        if not v_head.is_active then
          raise exception 'category "%" is inactive and cannot accept new entries', v_head.name;
        end if;
        if v_head.type <> c_head_type then
          raise exception
            '% is % and "%" is an % category. Choose another % category, or delete the record and enter it again.',
            v_ref, c_head_type, v_head.name, v_head.type, c_head_type;
        end if;
        n_head_id := v_head.id; n_head_name := v_head.name;
        v_set := v_set || jsonb_build_object('ledgerHeadId', n_head_id);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_head_id::text, ''), 'newValue', n_head_id::text,
          'originalText', c_head_name, 'newText', n_head_name, 'difference', null));

      elsif v_field = 'branchId' then
        if v_val = '' then
          n_branch_id := null; n_branch_name := null;
        else
          begin
            select id, name into n_branch_id, n_branch_name from branches where id = v_val::uuid;
          exception when others then
            raise exception 'that branch does not exist';
          end;
          if n_branch_id is null then raise exception 'that branch does not exist'; end if;
        end if;
        v_set := v_set || jsonb_build_object('branchId', coalesce(n_branch_id::text, ''));
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_branch_id::text, ''), 'newValue', coalesce(n_branch_id::text, ''),
          'originalText', coalesce(c_branch_name, 'Company-wide'), 'newText', coalesce(n_branch_name, 'Company-wide'),
          'difference', null));

      elsif v_field = 'paymentMethod' then
        if v_val = '' and v_is_txn then
          raise exception 'a transaction needs a payment method';
        end if;
        n_method := nullif(v_val, '');
        v_set := v_set || jsonb_build_object('paymentMethod', coalesce(n_method, ''));
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_method, ''), 'newValue', coalesce(n_method, ''),
          'originalText', coalesce(c_method, ''), 'newText', coalesce(n_method, ''), 'difference', null));

      elsif v_field = 'account' then
        if v_val not in ('cash', 'bank') then
          raise exception 'the account must be cash or bank';
        end if;
        n_account := v_val::finance_account;
        v_set := v_set || jsonb_build_object('account', v_val);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_account::text, 'newValue', v_val,
          'originalText', c_account::text, 'newText', v_val, 'difference', null));

      elsif v_field = 'description' then
        if v_val = '' then
          raise exception 'the description cannot be empty';
        end if;
        n_desc := v_val;
        v_set := v_set || jsonb_build_object('description', n_desc);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_desc, 'newValue', n_desc,
          'originalText', c_desc, 'newText', n_desc, 'difference', null));

      else
        raise exception 'field "%" cannot be corrected on %', v_field, v_ref;
      end if;
    end loop;

    if v_is_txn then
      update finance_transactions
         set amount           = n_amount,
             business_date    = n_date,
             ledger_head_id   = n_head_id,
             ledger_head_name = n_head_name,
             branch_id        = n_branch_id,
             branch_name      = n_branch_name,
             payment_method   = n_method,
             account          = n_account,
             description      = n_desc
       where id = p_reference_id;

      -- A posted transaction's voucher follows it, in one reversal and one
      -- corrected entry. An unposted one has no voucher yet: it is corrected in
      -- place and posts the corrected values when it is approved.
      if v_status in ('posted', 'locked') and v_tx.ledger_entry_id is not null then
        v_ledger := app.repost_ledger_entry(v_tx.ledger_entry_id, v_set, p_reason, p_actor_id, p_actor_name, v_today);
        update finance_transactions
           set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
         where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
      end if;
    else
      v_ledger := app.repost_ledger_entry(p_reference_id, v_set, p_reason, p_actor_id, p_actor_name, v_today);
    end if;

    return (
      select jsonb_agg(
               e || jsonb_build_object('referenceType', p_reference_type, 'referenceNo', v_ref, 'ledger', v_ledger)
               order by ord)
        from jsonb_array_elements(v_out) with ordinality as t(e, ord)
    );
  end;
  $$;

revoke all on function amend_finance_record_fields(text, uuid, jsonb, text, uuid, text, date)
  from public, anon, authenticated;
grant execute on function amend_finance_record_fields(text, uuid, jsonb, text, uuid, text, date)
  to service_role;

-- 3. correct_finance_record_for_query — 129's body, with a voucher and a
--    transaction going through amend_finance_record_fields (all fields in one
--    reversal) and every other type through amend_finance_record, field by
--    field, exactly as before. The conflict check, the amendment rows, the
--    resolve and the version row are unchanged.
create or replace function correct_finance_record_for_query(
  p_ticket_id        uuid,
  p_expected_version integer,
  p_edits            jsonb,
  p_reason           text,
  p_action           text,
  p_resolve          boolean,
  p_admin_response   text,
  p_labels           jsonb,
  p_actor_id         uuid,
  p_actor_name       text,
  p_actor_role       text,
  p_ip_address       text,
  p_entry_date       date default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ticket   finance_tickets%rowtype;
    v_after    finance_tickets%rowtype;
    v_edit     jsonb;
    v_result   jsonb;
    v_results  jsonb := '[]'::jsonb;
    v_idx      integer := 0;
    v_field    text;
    v_label    text;
    v_money    boolean;
    v_old      text;
    v_new      text;
    v_old_text text;
    v_new_text text;
    v_expected text;
    v_ref_no   text;
    v_applied  jsonb := '[]'::jsonb;
    v_changes  jsonb := '[]'::jsonb;
    v_response text := nullif(btrim(coalesce(p_admin_response, '')), '');
    v_next     integer;
  begin
    select * into v_ticket from finance_tickets where id = p_ticket_id for update;
    if not found then
      raise exception 'Query not found.' using errcode = 'MBNFD';
    end if;
    if v_ticket.deleted_at is not null then
      raise exception 'Query % has been deleted. Restore it before correcting its record.', v_ticket.query_no;
    end if;
    if v_ticket.status = 'draft' then
      raise exception 'Query % is still a draft.', v_ticket.query_no;
    end if;
    if v_ticket.version <> p_expected_version then
      raise exception 'Query % was changed by another user while you were working on it. Reload it and try again.',
        v_ticket.query_no using errcode = 'MBCON';
    end if;
    if v_ticket.reference_type is null or v_ticket.reference_id is null then
      raise exception 'Query % names no finance record, so there is nothing to correct.', v_ticket.query_no;
    end if;
    if p_resolve and v_ticket.status not in ('open', 'under_review', 'waiting_for_finance', 'amended', 'reopened') then
      raise exception 'Query % is already %, so it cannot be resolved again. Apply the correction without resolving.',
        v_ticket.query_no, replace(v_ticket.status, '_', ' ');
    end if;
    if p_action not in ('amend', 'overwrite') then
      raise exception 'unknown correction action "%"', p_action;
    end if;
    if jsonb_typeof(p_edits) is distinct from 'array' or jsonb_array_length(p_edits) = 0 then
      raise exception 'No changes detected.';
    end if;
    if p_resolve and v_response is null and length(btrim(coalesce(v_ticket.admin_response, ''))) = 0 then
      raise exception 'Resolving % needs a response saying what was done.', v_ticket.query_no;
    end if;

    -- The writes. One result per edit, in the order the edits were given.
    if v_ticket.reference_type in ('ledger_entry', 'finance_transaction') then
      v_results := amend_finance_record_fields(
        v_ticket.reference_type, v_ticket.reference_id, p_edits,
        p_reason, p_actor_id, p_actor_name, p_entry_date);
    else
      for v_edit in select value from jsonb_array_elements(p_edits) loop
        v_results := v_results || jsonb_build_array(amend_finance_record(
          v_ticket.reference_type, v_ticket.reference_id, v_edit ->> 'field', v_edit ->> 'value',
          p_reason, p_actor_id, p_actor_name, p_entry_date));
      end loop;
    end if;

    for v_edit in select value from jsonb_array_elements(p_edits) loop
      v_result   := v_results -> v_idx;
      v_idx      := v_idx + 1;
      v_field    := v_edit ->> 'field';
      v_money    := coalesce((v_edit ->> 'money')::boolean, false);
      v_label    := coalesce(nullif(v_edit ->> 'label', ''), v_field);
      v_expected := v_edit ->> 'expected';

      v_old      := v_result ->> 'originalValue';
      v_new      := v_result ->> 'newValue';
      -- What a person reads: a category or a branch by name, not by id.
      v_old_text := coalesce(v_result ->> 'originalText', v_old);
      v_new_text := coalesce(v_result ->> 'newText', v_new);
      v_ref_no   := coalesce(v_result ->> 'referenceNo', v_ticket.reference_no);

      -- The optimistic check: `v_old` was read from the row inside this
      -- transaction, under its lock, so it is the value the change replaced.
      if v_money then
        if round(coalesce(nullif(btrim(v_old), '')::numeric, 0), 2)
           <> round(coalesce(nullif(btrim(v_expected), '')::numeric, 0), 2) then
          raise exception
            'This record was changed by another user (% is now %). Please reload the latest version before applying your correction.',
            v_label, coalesce(v_old, '—') using errcode = 'MBCON';
        end if;
      elsif btrim(coalesce(v_old, '')) <> btrim(coalesce(v_expected, '')) then
        raise exception
          'This record was changed by another user (% changed). Please reload the latest version before applying your correction.',
          v_label using errcode = 'MBCON';
      end if;

      insert into finance_amendments (
        ticket_id, query_no, reference_type, reference_id, reference_no, action, field,
        original_value, new_value, difference, reason, admin_id, admin_name, ip_address
      ) values (
        v_ticket.id, v_ticket.query_no, v_ticket.reference_type, v_ticket.reference_id, v_ref_no,
        p_action, v_field, v_old_text, v_new_text, (v_result ->> 'difference')::numeric,
        p_reason, p_actor_id, coalesce(p_actor_name, ''), p_ip_address
      );

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'record.' || v_field,
        'label', v_ref_no || ' · ' || v_label,
        'old', case when v_money and v_old ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_old::numeric, 'FM999,999,999,990.00')
                    else nullif(v_old_text, '') end,
        'new', case when v_money and v_new ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_new::numeric, 'FM999,999,999,990.00')
                    else nullif(v_new_text, '') end
      ));
      v_applied := v_applied || jsonb_build_array(v_result || jsonb_build_object('label', v_label));
    end loop;

    v_next := v_ticket.version + 1;

    if p_resolve then
      update finance_tickets
         set status            = 'resolved',
             resolution_type   = 'fixed',
             admin_response    = coalesce(v_response, admin_response),
             responded_by      = case when v_response is not null then p_actor_id else responded_by end,
             responded_by_name = case when v_response is not null then p_actor_name else responded_by_name end,
             responded_at      = case when v_response is not null then now() else responded_at end,
             resolved_by       = p_actor_id,
             resolved_by_name  = p_actor_name,
             resolved_at       = now(),
             version           = v_next
       where id = v_ticket.id
       returning * into v_after;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'status', 'label', 'Status',
        'old', coalesce(p_labels ->> 'statusFrom', v_ticket.status),
        'new', coalesce(p_labels ->> 'statusTo', 'resolved')));
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'resolutionType', 'label', 'Resolution type',
        'old', null, 'new', coalesce(p_labels ->> 'resolutionType', 'fixed')));
      if v_response is not null and v_response is distinct from v_ticket.admin_response then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'field', 'adminResponse', 'label', 'Admin response',
          'old', nullif(v_ticket.admin_response, ''), 'new', v_response));
      end if;
    else
      update finance_tickets set version = v_next where id = v_ticket.id returning * into v_after;
    end if;

    insert into finance_ticket_versions (
      ticket_id, query_no, version, action, changed_by, changed_by_name, changed_by_role,
      reason, changes, snapshot
    ) values (
      v_after.id, v_after.query_no, v_next, 'record_corrected', p_actor_id, coalesce(p_actor_name, ''),
      p_actor_role, p_reason, v_changes, to_jsonb(v_after)
    );

    return jsonb_build_object(
      'applied',    v_applied,
      'statusFrom', v_ticket.status,
      'ticket',     to_jsonb(v_after)
    );
  end;
  $$;

revoke all on function correct_finance_record_for_query(uuid, integer, jsonb, text, text, boolean, text, jsonb, uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function correct_finance_record_for_query(uuid, integer, jsonb, text, text, boolean, text, jsonb, uuid, text, text, text, date)
  to service_role;
