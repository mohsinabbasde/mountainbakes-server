-- 134: RV-000282 — bring a correction made under the old rule to the state
-- migration 133 produces.
--
-- FIN-QRY-2026-000130 changed RV-000282's branch (Company-wide → G 10 Markaz
-- Isb) a few minutes before 133 was applied, so it was done the old way:
-- RV-000282 crossed out, PV-000502 posted to reverse it, RV-000285 posted in
-- its place. Under 133 the same correction changes RV-000282 itself and posts
-- nothing. This makes the book read that way:
--
--   RV-000282   reversed → posted, carrying the corrected branch (RV-000285's)
--   PV-000502   its reversal        → removed (soft-delete stamp)
--   RV-000285   the re-posted entry → removed (soft-delete stamp)
--
-- The three net to the one receipt, so the closing balance does not move.
-- RV-000282 keeps its own date, 2026-09-30. Targets these three vouchers by
-- number and only in exactly this state; anything else and nothing changes.
-- The amendment row and the query's history are left as written.
-- ---------------------------------------------------------------------------
do $$
declare
  v_orig ledger_entries%rowtype;  -- RV-000282
  v_rev  ledger_entries%rowtype;  -- PV-000502
  v_new  ledger_entries%rowtype;  -- RV-000285
  v_bal  jsonb;
begin
  -- PV-000502 and RV-000285 are read whether or not they are still live: both
  -- were deleted by hand (2026-10-02) after this migration was written. Either
  -- way the end state is the same — RV-000282 posted, the other two removed.
  select * into v_orig from ledger_entries where voucher_no = 'RV-000282' and deleted_at is null;
  select * into v_rev  from ledger_entries where voucher_no = 'PV-000502';
  select * into v_new  from ledger_entries where voucher_no = 'RV-000285';

  if v_orig.id is null or v_rev.id is null or v_new.id is null
     or v_orig.status <> 'reversed'
     or v_orig.reversed_by_entry_id is distinct from v_rev.id
     or v_rev.reverses_entry_id is distinct from v_orig.id
     or v_new.source_type <> 'adjustment' or v_new.source_id is distinct from v_orig.id
     or v_new.status = 'reversed' or v_new.reverses_entry_id is not null
     or v_new.debit <> v_orig.debit or v_new.credit <> v_orig.credit
     or v_rev.credit <> v_orig.debit or v_rev.debit <> v_orig.credit then
    raise notice 'migration 134: RV-000282 / PV-000502 / RV-000285 are not in the expected state — nothing changed';
    return;
  end if;

  update ledger_entries
     set deleted_at    = now(),
         delete_reason = 'RV-000282 branch correction (FIN-QRY-2026-000130) applied to the voucher itself instead of reversed and re-posted (migration 134)'
   where id in (v_rev.id, v_new.id) and deleted_at is null;

  -- Live again, with the branch the correction gave its replacement. Status,
  -- reversal linkage and branch are not money-bearing columns; the trigger
  -- allows them without a window.
  update ledger_entries
     set status               = 'posted',
         reversed_by_entry_id = null,
         branch_id            = v_new.branch_id,
         branch_name          = v_new.branch_name
   where id = v_orig.id;

  v_bal := recompute_finance_ledger_balances();
  raise notice 'migration 134: RV-000282 is posted again with branch "%"; PV-000502 and RV-000285 removed; balances: %',
    coalesce(v_new.branch_name, 'Company-wide'), v_bal;
end
$$;
