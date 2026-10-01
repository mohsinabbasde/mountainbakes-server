-- 132: a cash deposit's date is corrected by MOVING its receipts, not by
-- reversing them.
--
-- Migration 131 corrected the date of an approved deposit the way every figure
-- correction works: each RV- receipt reversed (a PV- dated today) and posted
-- again on the corrected day. For a change of DATE the owner asked for the
-- receipt itself to move instead — the money did not change, only the day it
-- was keyed against, and a crossed-out voucher, a reversal and a replacement
-- say three things happened where one did. This is the same call migration 125
-- made for deleting a deposit.
--
--   1. app.finance_ledger_immutable gains a RE-DATE window: with
--      app.allow_ledger_redate on, an UPDATE may change entry_date and nothing
--      else. Outside it the ledger is exactly as immutable as before.
--   2. amend_cash_transfer_date uses it: the live receipts of an approved
--      deposit take the corrected date in place. A finance day that Finance has
--      CLOSED is not touched — neither the day the receipts leave nor the day
--      they would land on — because a closed day's totals were signed off.
--   3. CT-000016, whose date was corrected under 131, is put in the state this
--      migration produces: RV-000275 and RV-000276 live again and dated
--      2026-09-30; the reversals and the re-posted receipts removed.
--
-- The running balance is a chain in posting order (seq), not date order, so
-- moving a voucher between days changes no balance.
-- ---------------------------------------------------------------------------

-- 1. The trigger — migration 94's body, plus the re-date window.
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

-- 2. amend_cash_transfer_date — 131's body, the approved branch rewritten.
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
    v_others integer;
    v_closed date;
    v_moved  text;
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

    if v_row.status = 'approved' then
      -- A closed day is signed off: nothing leaves it and nothing lands on it.
      select c.business_date into v_closed
        from finance_day_closings c
       where c.business_date = p_new_date
          or c.business_date in (
               select e.entry_date from ledger_entries e
                where e.source_type = 'cash_transfer' and e.source_id = v_row.id
                  and e.status <> 'reversed' and e.reverses_entry_id is null and e.deleted_at is null)
       order by c.business_date limit 1;
      if v_closed is not null then
        raise exception
          'the finance day % is closed, so the receipts of % cannot be moved off it or onto it. Reopen the day first.',
          to_char(v_closed, 'DD-Mon-YYYY'), v_row.transfer_no;
      end if;
    end if;

    update cash_transfers
       set business_date   = p_new_date,
           updated_by      = p_actor_id,
           updated_by_name = p_actor_name
     where id = v_row.id;

    if v_row.status = 'approved' then
      perform set_config('app.allow_ledger_redate', 'on', true);
      with moved as (
        update ledger_entries
           set entry_date = p_new_date
         where source_type = 'cash_transfer' and source_id = v_row.id
           and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
           and entry_date <> p_new_date
        returning voucher_no, seq
      )
      select string_agg(voucher_no, ', ' order by seq) into v_moved from moved;
      perform set_config('app.allow_ledger_redate', 'off', true);
    end if;

    return jsonb_build_object(
      'referenceType', 'cash_transfer', 'referenceNo', v_row.transfer_no, 'field', 'businessDate',
      'originalValue', v_row.business_date::text, 'newValue', p_new_date::text, 'difference', null,
      -- Nothing was reversed or posted: the receipts moved. `redatedVoucherNos`
      -- names them for the note the Support Center writes.
      'ledger', jsonb_build_object('ledgerAmended', false, 'redatedVoucherNos', v_moved));
  end;
  $$;

revoke all on function amend_cash_transfer_date(uuid, date, text, uuid, text, date, integer)
  from public, anon, authenticated;
grant execute on function amend_cash_transfer_date(uuid, date, text, uuid, text, date, integer)
  to service_role;

-- 3. CT-000016 — undo the reversal-and-repost 131 made on 2026-10-02.
--
-- Targets exactly six vouchers, by number, and only when every one of them is
-- in the state 131 left it in; anything else and the block does nothing, so a
-- second run, or a run on a database where this never happened, is a no-op.
--
--   RV-000275, RV-000276   reversed  →  live again, dated 2026-09-30
--   PV-000500, PV-000501   their reversals        →  removed (soft-delete stamp)
--   RV-000283, RV-000284   the re-posted receipts →  removed (soft-delete stamp)
--
-- If the reversals are still live the six net to the two original receipts and
-- the closing balance does not move. If they were already deleted by hand the
-- book is counting the deposit twice, and removing the re-posted receipts
-- brings the closing balance down by the deposit's 31,450 to what it should be.
-- Either way the running balances are recomputed.
do $$
declare
  v_ct    cash_transfers%rowtype;
  v_a     ledger_entries%rowtype;  -- RV-000275
  v_b     ledger_entries%rowtype;  -- RV-000276
  v_n     integer;
  v_bal   jsonb;
begin
  select * into v_ct from cash_transfers where transfer_no = 'CT-000016' and deleted_at is null;
  if not found then
    raise notice 'migration 132: CT-000016 not found — nothing to repair';
    return;
  end if;

  select * into v_a from ledger_entries where voucher_no = 'RV-000275' and source_id = v_ct.id and deleted_at is null;
  select * into v_b from ledger_entries where voucher_no = 'RV-000276' and source_id = v_ct.id and deleted_at is null;

  -- The two re-posted receipts must still be the deposit's live vouchers. The
  -- two reversals may be live or already removed: PV-000500 and PV-000501 were
  -- deleted by hand under FIN-QRY-2026-000128/129 after 131 ran, which left the
  -- deposit counted twice (the original, no longer cancelled, and the re-post).
  -- Removing the re-post below is what brings the balance back to one deposit.
  select count(*) into v_n
    from ledger_entries e
   where e.deleted_at is null
     and e.voucher_no in ('RV-000283', 'RV-000284') and e.source_type = 'cash_transfer'
     and e.source_id = v_ct.id and e.status <> 'reversed' and e.reverses_entry_id is null;
  if v_a.id is null or v_b.id is null or v_a.status <> 'reversed' or v_b.status <> 'reversed' or v_n <> 2 then
    raise notice 'migration 132: CT-000016 is not in the state migration 131 left it in — nothing changed';
    return;
  end if;

  -- The deposit points at its original receipts again (the FK to RV-000283 is
  -- released before that row is stamped).
  update cash_transfers
     set ledger_entry_id = v_a.id, voucher_no = 'RV-000275, RV-000276'
   where id = v_ct.id;

  update ledger_entries
     set deleted_at    = now(),
         delete_reason = 'CT-000016 date correction: the receipt was moved to 2026-09-30 instead of reversed and re-posted (migration 132)'
   where deleted_at is null
     and (voucher_no in ('PV-000500', 'PV-000501') and reverses_entry_id in (v_a.id, v_b.id)
          or voucher_no in ('RV-000283', 'RV-000284') and source_id = v_ct.id);

  perform set_config('app.allow_ledger_redate', 'on', true);
  update ledger_entries set entry_date = date '2026-09-30' where id in (v_a.id, v_b.id);
  perform set_config('app.allow_ledger_redate', 'off', true);

  update ledger_entries set status = 'posted', reversed_by_entry_id = null where id in (v_a.id, v_b.id);

  v_bal := recompute_finance_ledger_balances();
  raise notice 'migration 132: CT-000016 repaired — RV-000275 and RV-000276 live and dated 2026-09-30; balances: %', v_bal;
end
$$;
