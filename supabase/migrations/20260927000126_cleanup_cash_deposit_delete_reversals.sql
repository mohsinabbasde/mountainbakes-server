-- 126: remove the reversal vouchers the old Cash Deposit delete posted.
--
-- Before 125, deleting an approved deposit reversed its RV- vouchers instead of
-- removing them, leaving in the ledger the original (status 'reversed') and a
-- Credit-side "Reversal of RV-… — cash transfer CT-… deleted under …". This
-- brings those deposits to the state 125 produces: every entry in the deposit's
-- chain stamped deleted, balances recomputed, nothing posted.
--
-- ─── Exactly what is targeted ────────────────────────────────────────────────
-- A deposit qualifies only when BOTH hold:
--   • cash_transfers.deleted_at is set (it was deleted through the Help Desk), and
--   • a live ledger entry in its chain was posted by that deletion: it reverses
--     one of the deposit's entries (reverses_entry_id), and its description is
--     the one 120/121 wrote on delete — 'Reversal of <RV> — cash transfer
--     <CT-no> deleted under …'. reverse_finance_ledger_entry writes that
--     description and nothing else can; a manual voucher cannot have a
--     reverses_entry_id.
-- For each such deposit its chain (app.cash_transfer_ledger_chain, 125) is
-- stamped. The chain of a deposit is linked by source_id / reverses_entry_id,
-- so no voucher of another deposit or any manual entry can be reached. Every
-- chain nets to zero once the delete-reversal is in it, so the closing balance
-- does not move; only the running balance on rows between the pair does.
--
-- The stamp reuses the deposit's own deletion (who, query) so an Admin sees one
-- deletion, not two. Idempotent: a second run finds nothing live.
-- ---------------------------------------------------------------------------

do $$
declare
  v_ct        record;
  v_deposits  int := 0;
  v_entries   int := 0;
  v_n         int;
  v_recompute jsonb;
begin
  for v_ct in
    select ct.id, ct.transfer_no, ct.deleted_by, ct.deleted_by_name, ct.delete_reason,
           ct.deleted_query_id, ct.deleted_query_no
      from cash_transfers ct
     where ct.deleted_at is not null
       and exists (
         select 1 from ledger_entries r
          where r.id in (select app.cash_transfer_ledger_chain(ct.id))
            and r.deleted_at is null
            and r.reverses_entry_id is not null
            and r.description like 'Reversal of % — cash transfer ' || ct.transfer_no || ' deleted under %'
       )
  loop
    update ledger_entries
       set deleted_at       = now(),
           deleted_by       = v_ct.deleted_by,
           deleted_by_name  = v_ct.deleted_by_name,
           delete_reason    = 'Cash deposit ' || v_ct.transfer_no || ' deleted — removed with its reversal (migration 126)'
                              || coalesce(': ' || v_ct.delete_reason, ''),
           deleted_query_id = v_ct.deleted_query_id,
           deleted_query_no = v_ct.deleted_query_no
     where id in (select app.cash_transfer_ledger_chain(v_ct.id)) and deleted_at is null;
    get diagnostics v_n = row_count;

    v_deposits := v_deposits + 1;
    v_entries  := v_entries + v_n;
    raise notice 'migration 126: % — % ledger entr% removed', v_ct.transfer_no, v_n, case when v_n = 1 then 'y' else 'ies' end;
  end loop;

  if v_entries > 0 then
    v_recompute := recompute_finance_ledger_balances();
  end if;

  raise notice 'migration 126: % deleted deposit(s), % ledger entr% removed, balances: %',
    v_deposits, v_entries, case when v_entries = 1 then 'y' else 'ies' end, coalesce(v_recompute::text, 'unchanged');
end
$$;
