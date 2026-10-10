-- 62: repair the running `balance` chain after a deletion punched a hole in it.
--
-- WHY THIS EXISTS. Migration 52 built `balance` as ONE global chain in `seq`
-- order — `previous.balance + debit - credit`, read under an advisory lock, not
-- partitioned by account or head or date. Migration 61 then made a posted entry
-- deletable. Those two facts do not coexist: removing a row from the middle of
-- the chain leaves every later row carrying the deleted amount forever, because
-- nothing rewrites history on the way out.
--
-- That is exactly what happened. Six vouchers were deleted through the Help Desk
-- path and every surviving row's `balance` was left overstated.
--
-- WHAT THIS RESTATES, SAID PLAINLY. Migration 52's header calls `balance` "the
-- book balance at the instant of posting" and means it. After this runs, that is
-- no longer strictly what the column holds: it holds the book balance implied by
-- the rows that STILL EXIST. Those differ precisely by the deleted vouchers.
-- There is no third option — the honest balance for a book that lost rows is the
-- one computed from the rows it has, and it is the figure finance_day_summary()
-- and finance_ledger_totals() already report, since both aggregate the surviving
-- rows and never read this column. This aligns the column with them.
--
-- The real lesson belongs upstream: reversal via reverse_finance_ledger_entry()
-- leaves the chain intact and needs no repair. Deletion is what creates the work
-- this file does.

-- ---------------------------------------------------------------------------
-- A SECOND, NARROWER escape hatch in the immutability trigger.
--
-- Migration 61 added `app.allow_ledger_delete` for DELETE. This adds
-- `app.allow_balance_recompute` for UPDATE, and it is deliberately tighter than
-- the delete hatch: while it is on, `balance` may change and NOTHING ELSE may.
-- Voucher number, seq, date, head, debit, credit, account, source and
-- description stay as immutable as they were — a recompute that could quietly
-- restate an AMOUNT would be a far worse hole than the one it is fixing.
--
-- Transaction-local via set_config(..., true), same as migration 61: the bypass
-- cannot outlive the transaction that asked for it, so a concurrent session
-- cannot slip an update through the window.
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
-- recompute_finance_ledger_balances()
--
-- Rewrites `balance` on every row to the cumulative sum of (debit - credit) in
-- `seq` order — the same arithmetic post_finance_ledger_entry does one row at a
-- time, applied to the whole book at once.
--
-- It takes the SAME advisory lock as post_finance_ledger_entry on the same key.
-- Without it, a posting landing mid-rewrite would read a balance from a row this
-- function is about to change and chain onto a figure that never survives the
-- statement — reintroducing the drift while repairing it.
--
-- Idempotent, and cheap to re-run: the WHERE clause touches only rows whose
-- stored balance actually disagrees, so a second call updates zero rows.
-- ---------------------------------------------------------------------------
create or replace function recompute_finance_ledger_balances() returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_updated integer;
    v_before  numeric(14,2);
    v_after   numeric(14,2);
    v_rows    integer;
  begin
    perform pg_advisory_xact_lock(hashtext('finance_ledger_post'));

    select count(*) into v_rows from ledger_entries;
    select balance into v_before from ledger_entries order by seq desc limit 1;

    perform set_config('app.allow_balance_recompute', 'on', true);

    with running as (
      select id,
             sum(debit - credit) over (order by seq rows between unbounded preceding and current row) as bal
        from ledger_entries
    )
    update ledger_entries e
       set balance = r.bal
      from running r
     where e.id = r.id
       and e.balance is distinct from r.bal;

    get diagnostics v_updated = row_count;

    perform set_config('app.allow_balance_recompute', 'off', true);

    select balance into v_after from ledger_entries order by seq desc limit 1;

    return jsonb_build_object(
      'rows',           v_rows,
      'updated',        v_updated,
      'closingBefore',  v_before,
      'closingAfter',   v_after
    );
  end;
  $$;

-- Same lockdown as every other posting function (migrations 52 and 61):
-- SECURITY DEFINER plus the default PUBLIC execute grant would let any signed-in
-- browser session rewrite the book's balances over PostgREST.
revoke all on function recompute_finance_ledger_balances() from public, anon, authenticated;
grant execute on function recompute_finance_ledger_balances() to service_role;

-- Repair the damage that prompted this file. On a from-scratch replay the table
-- is empty here and this is a no-op, which is why it is safe to leave inline.
select recompute_finance_ledger_balances();
