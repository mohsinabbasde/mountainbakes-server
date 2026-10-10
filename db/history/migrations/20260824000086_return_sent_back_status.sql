-- ---------------------------------------------------------------------------
-- 'returned' — Production hands a branch return BACK to the branch to correct.
--
-- Until now a branch-initiated return was inserted already 'accepted': the units
-- moved as it was saved and Production never reviewed it. That auto-approval is
-- gone. A branch return is now inserted 'pending' — the units leave the branch
-- (the goods have physically left the shop) but the central pool is credited
-- only when Production approves — and Production decides it on their Returns
-- screen with one of three actions:
--
--   accepted  the pool is credited; the record is final
--   rejected  the units go back onto the branch balance; the record is final
--   returned  NEW — the paperwork goes back to the branch to fix
--
-- 'returned' is deliberately NOT a terminal state and moves no stock. It holds
-- the same stock position as 'pending' (off the branch, not yet in the pool) and
-- exists so Production can say "the count is wrong" without either accepting a
-- figure they dispute or rejecting a return that is genuinely coming back. The
-- branch corrects the quantity and resubmits, which puts the row back to
-- 'pending'.
--
-- PG 12+ allows ADD VALUE inside a transaction block as long as the new value is
-- not USED in the same transaction — this migration only declares it, so it is
-- safe under `supabase db push`. Same pattern as migrations 14, 42 and 55.
-- ---------------------------------------------------------------------------
alter type production_return_status add value if not exists 'returned';

-- The partial index behind Production's queue was 'pending'-only. A 'returned'
-- row is still open work — it is what the branch has to act on — so the branch's
-- Return Stock page filters on it the same way. Widening the predicate keeps
-- both lookups on the index instead of dropping the second to a seq scan.
drop index if exists production_returns_status_idx;
create index production_returns_status_idx
  on production_returns (status)
  where status in ('pending', 'returned');
