-- 133: a finance correction CHANGES the voucher. It no longer reverses it.
--
-- Since migration 52 a posted voucher could not be edited: every correction
-- posted a reversal of the original (a PV- against an RV-, or the other way
-- round), crossed the original out and posted a third, corrected voucher under
-- a new number. The owner has asked for the opposite, everywhere: change the
-- entry, keep its RV-/PV- number, and show no reversal in the ledger. A delete
-- already removes the entry without a reversal (migrations 94, 125).
--
-- What this changes
--   * app.edit_ledger_entry — the one place a posted voucher is edited: figure,
--     date, category (same type), branch, payment method, account, description.
--     Same voucher number, same place in the posting order; the running
--     balances after it are recomputed when the figure moves.
--   * app.amend_document_ledger, app.repost_ledger_entry — the two helpers every
--     Help Desk correction goes through (amend_finance_record for all record
--     types; amend_finance_record_fields for vouchers and transactions) now edit
--     in place. Their signatures and return shapes are unchanged, so the
--     functions above them are not redefined.
--   * app.sync_cash_transfer_entries — a deposit's receipts take the corrected
--     figures in place; a slice that no longer exists is removed, a new one is
--     posted. No reversals.
--   * reverse_finance_ledger_entry — the Daily Ledger's Adjust: with a corrected
--     amount or description it edits the voucher; without one it removes it.
--
-- What it does not change
--   * The RECORD of the correction. finance_amendments, finance_ticket_versions
--     and finance_audit_logs still carry who changed what, from what, to what and
--     why. The ledger shows the corrected book; those tables show how it got there.
--   * A day Finance has CLOSED. Its totals were signed off, so a voucher on a
--     closed day (or one being moved onto it) is refused, with the day named.
--   * Income ↔ Expense, the voucher number, and vouchers already reversed under
--     the old rule (they stay as the three rows they were posted as).
-- ---------------------------------------------------------------------------

-- 1. The trigger — migration 132's body, plus the edit window.
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
        'with a reversing or adjustment entry, or soft-delete it through a Help Desk '
        'query so the row stays readable to an auditor.', old.voucher_no;
    end if;

    -- Balance-only repair window. Note `balance` is absent from both tuples
    -- below and every other money-bearing column is still present.
    if coalesce(current_setting('app.allow_balance_recompute', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
          new.account, new.source_type, new.source_id, new.description)
         is distinct from
         (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
          old.account, old.source_type, old.source_id, old.description)
      then
        raise exception
          'ledger entry %: the balance-recompute window permits changing `balance` and '
          'nothing else, but this update also alters another column.', old.voucher_no;
      end if;
      return new;
    end if;

    -- Re-date window (migration 132). A branch deposit keyed against the wrong
    -- day has its receipts moved to the right one. `entry_date` is absent from
    -- both tuples below and every other money-bearing column, the balance
    -- included, is still present — the window moves a voucher between days and
    -- can do nothing else to it.
    if coalesce(current_setting('app.allow_ledger_redate', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.ledger_head_id, new.debit, new.credit, new.balance,
          new.account, new.source_type, new.source_id, new.description)
         is distinct from
         (old.voucher_no, old.seq, old.ledger_head_id, old.debit, old.credit, old.balance,
          old.account, old.source_type, old.source_id, old.description)
      then
        raise exception
          'ledger entry %: the re-date window permits changing `entry_date` and '
          'nothing else, but this update also alters another column.', old.voucher_no;
      end if;
      return new;
    end if;

    -- Edit window (migration 133). A correction changes the voucher itself —
    -- its figure, date, category, account or description — and keeps its number.
    -- What may NOT move even here: the voucher number, its place in the posting
    -- order, what it was posted from, and the running balance (which only
    -- recompute_finance_ledger_balances may write, under its own window).
    if coalesce(current_setting('app.allow_ledger_edit', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.balance, new.source_type, new.source_id)
         is distinct from
         (old.voucher_no, old.seq, old.balance, old.source_type, old.source_id)
      then
        raise exception
          'ledger entry %: a correction may not change the voucher number, its posting '
          'order, its source or its balance.', old.voucher_no;
      end if;
      if (new.debit > 0) is distinct from (old.debit > 0) then
        raise exception 'ledger entry %: a correction may not move a voucher to the other side of the book.', old.voucher_no;
      end if;
      return new;
    end if;

    -- The money-bearing columns. Unchanged from migration 62 — the soft-delete
    -- columns are deliberately NOT in this tuple, which is what permits the
    -- stamp; everything that describes the transaction still is, which is what
    -- stops the stamp being used to smuggle an edit alongside it.
    if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
        new.balance, new.account, new.source_type, new.source_id, new.description)
       is distinct from
       (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
        old.balance, old.account, old.source_type, old.source_id, old.description)
    then
      raise exception
        'ledger entry % is immutable. Only status, reversal linkage and the soft-delete '
        'stamp may change; post a reversing or adjustment entry instead.', old.voucher_no;
    end if;

    -- Un-deleting is not an operation this system offers. A stamped row is the
    -- record that a deletion happened; clearing it would erase that fact and
    -- leave the balance chain, which was recomputed without the row, wrong.
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception
        'ledger entry % was deleted under query % and cannot be restored. Post a fresh '
        'entry if the amount belongs in the book.',
        old.voucher_no, coalesce(old.deleted_query_no, '?');
    end if;

    return new;
  end;
  $$;

-- 2. Edit a posted voucher in place.
--
-- p_set keys (all optional; an absent key keeps the voucher's value):
--   amount, entryDate, ledgerHeadId, branchId ('' = company-wide),
--   paymentMethod, account, description
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
           payment_method   = v_method
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

revoke all on function app.edit_ledger_entry(uuid, jsonb, uuid, text, date) from public, anon, authenticated;
grant execute on function app.edit_ledger_entry(uuid, jsonb, uuid, text, date) to service_role;

-- 3. The two helpers every Help Desk correction goes through.
create or replace function app.amend_document_ledger(
  p_entry_id    uuid,
  p_new_amount  numeric,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text,
  p_entry_date  date
) returns jsonb
  language plpgsql
  as $$
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;
    return app.edit_ledger_entry(
      p_entry_id, jsonb_build_object('amount', round(p_new_amount, 2)), p_actor_id, p_actor_name, p_entry_date);
  end;
  $$;

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
  begin
    return app.edit_ledger_entry(p_entry_id, p_set, p_actor_id, p_actor_name, p_today);
  end;
  $$;

-- 4. A deposit's receipts follow its figures, in place.
--
-- Each wanted slice (app.cash_transfer_slices) takes the deposit's live voucher
-- under the same ledger head and has it corrected to the slice's figure,
-- account and payment method. A live voucher no slice wants (Fuel Charges set
-- to 0) is removed; a slice with no voucher (Fuel Charges added) is posted.
create or replace function app.sync_cash_transfer_entries(
  p_id          uuid,
  p_entry_date  date,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text
) returns jsonb
  language plpgsql
  as $$
  declare
    v_row      cash_transfers%rowtype;
    v_slice    record;
    v_live     ledger_entries%rowtype;
    v_head     ledger_heads%rowtype;
    v_entry    ledger_entries%rowtype;
    v_kept     uuid[] := '{}';
    v_queue    jsonb  := '[]';
    v_item     record;
    v_posted   text[] := '{}';
    v_edited   text[] := '{}';
    v_removed  text;
    v_first    uuid;
    v_all      text;
  begin
    select * into v_row from cash_transfers where id = p_id;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;

    for v_slice in select * from app.cash_transfer_slices(p_id) loop
      select e.* into v_live
        from ledger_entries e join ledger_heads h on h.id = e.ledger_head_id
       where e.source_type = 'cash_transfer' and e.source_id = p_id
         and e.status <> 'reversed' and e.reverses_entry_id is null and e.deleted_at is null
         and h.code = v_slice.head_code
         and e.id <> all (v_kept)
       order by e.seq limit 1;
      if found then
        v_kept := v_kept || v_live.id;
        if v_live.debit <> v_slice.amount
           or v_live.account <> v_slice.account
           or v_live.payment_method is distinct from v_slice.payment_method then
          perform app.edit_ledger_entry(
            v_live.id,
            jsonb_build_object(
              'amount', v_slice.amount,
              'account', v_slice.account::text,
              'paymentMethod', coalesce(v_slice.payment_method, '')),
            p_actor_id, p_actor_name, p_entry_date);
          v_edited := v_edited || v_live.voucher_no;
        end if;
      else
        v_queue := v_queue || to_jsonb(v_slice);
      end if;
    end loop;

    -- Remove every live voucher no slice claimed. Removed, not reversed.
    with removed as (
      update ledger_entries
         set deleted_at      = now(),
             deleted_by      = p_actor_id,
             deleted_by_name = p_actor_name,
             delete_reason   = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'cash deposit ' || v_row.transfer_no || ' corrected')
       where source_type = 'cash_transfer' and source_id = p_id
         and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
         and id <> all (v_kept)
      returning voucher_no, seq
    )
    select string_agg(voucher_no, ', ' order by seq) into v_removed from removed;
    if v_removed is not null then
      perform recompute_finance_ledger_balances();
    end if;

    -- Post the slices that have no voucher yet.
    for v_item in select value from jsonb_array_elements(v_queue) loop
      select * into v_head from ledger_heads where code = v_item.value ->> 'head_code';
      if not found then
        raise exception 'ledger head % is missing (seeded by migration 52 / 121)', v_item.value ->> 'head_code';
      end if;
      v_entry := post_finance_ledger_entry(
        p_entry_date, v_head.id, v_item.value ->> 'description',
        (v_item.value ->> 'amount')::numeric, 0,   -- debit: money in → the RV- series, income
        (v_item.value ->> 'account')::finance_account,
        'cash_transfer', v_row.id, v_row.branch_id, v_row.branch_name, v_item.value ->> 'payment_method',
        p_actor_id, p_actor_name, v_row.created_by, v_row.created_by_name, null
      );
      v_posted := v_posted || v_entry.voucher_no;
    end loop;

    select (array_agg(id order by seq))[1], string_agg(voucher_no, ', ' order by seq)
      into v_first, v_all
      from ledger_entries
     where source_type = 'cash_transfer' and source_id = p_id
       and status <> 'reversed' and reverses_entry_id is null and deleted_at is null;

    if v_first is null then
      raise exception 'Transfer % has no amount above 0 to book.', v_row.transfer_no using errcode = 'P0001';
    end if;

    -- `reversed` stays in the shape for the callers that read it, and is always
    -- null now: nothing is reversed.
    return jsonb_build_object(
      'firstEntryId', v_first,
      'voucherNos',   v_all,
      'reversed',     null,
      'posted',       nullif(array_to_string(v_posted, ', '), ''),
      'edited',       nullif(array_to_string(v_edited, ', '), ''),
      'removed',      v_removed
    );
  end;
  $$;

-- 5. The Daily Ledger's Adjust. Same name and signature — the API calls it by
--    name — but it no longer reverses: a corrected amount or description edits
--    the voucher; with neither, the voucher is removed.
create or replace function reverse_finance_ledger_entry(
  p_entry_id              uuid,
  p_entry_date            date,
  p_reason                text,
  p_actor_id              uuid,
  p_actor_name            text,
  p_corrected_amount      numeric default null,
  p_corrected_description text    default null
) returns setof ledger_entries
  language plpgsql
  as $$
  declare
    v_orig   ledger_entries%rowtype;
    v_set    jsonb := '{}'::jsonb;
  begin
    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry % does not exist, or it has already been deleted', p_entry_id;
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % was reversed by % and is no longer part of the book',
        v_orig.voucher_no, coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), '?');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is a reversing entry and cannot be changed', v_orig.voucher_no;
    end if;

    if p_corrected_amount is not null or nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
      if p_corrected_amount is not null then
        v_set := v_set || jsonb_build_object('amount', round(p_corrected_amount, 2));
      end if;
      if nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
        v_set := v_set || jsonb_build_object('description', btrim(p_corrected_description));
      end if;
      perform app.edit_ledger_entry(p_entry_id, v_set, p_actor_id, p_actor_name, p_entry_date);
    else
      if exists (select 1 from finance_day_closings where business_date = v_orig.entry_date) then
        raise exception 'the finance day % is closed, so voucher % cannot be removed from it. Reopen the day first.',
          to_char(v_orig.entry_date, 'DD-Mon-YYYY'), v_orig.voucher_no;
      end if;
      update ledger_entries
         set deleted_at      = now(),
             deleted_by      = p_actor_id,
             deleted_by_name = p_actor_name,
             delete_reason   = p_reason
       where id = p_entry_id;
      perform recompute_finance_ledger_balances();
    end if;

    return query select * from ledger_entries where id = p_entry_id;
  end;
  $$;
