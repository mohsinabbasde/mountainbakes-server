-- 91: an accepted return is not automatically saleable stock (§10).
--
-- ─── The gap ─────────────────────────────────────────────────────────────────
-- `production_returns` had three outcomes — pending / accepted / rejected (plus
-- 'returned', the send-back) — and `accepted` did exactly one thing: credit the
-- central pool. That conflates two decisions that are not the same:
--
--   "did these goods come back?"      — a fact about the delivery
--   "can we sell them again?"         — a judgement about their condition
--
-- Expired cake comes back. The branch must be credited for it and the return must
-- be on the record. But it is not stock, and crediting the pool put it straight
-- back on the shelf for the counter and the next branch demand to draw against.
--
-- ─── The fix ─────────────────────────────────────────────────────────────────
-- `disposition` says what happened to the goods, independently of whether the
-- return was accepted:
--
--   'saleable'  — back into the pool. The existing behaviour, and the default, so
--                 every historical row keeps exactly the meaning it had.
--   'damaged'   — received and written off.
--   'expired'   — received and written off.
--
-- A written-off return books TWO ledger movements, not zero: `return_in` for the
-- units that physically came back, then `adjustment` for the write-off. The
-- balance nets to no change, which is correct — but the Return Stock column still
-- reports what actually returned and the Adjustment column reports the write-off,
-- so the ledger tells the whole story instead of silently swallowing it. That is
-- §10's "record that as the appropriate stock transaction", and it is also what
-- keeps §12's arithmetic honest: each figure is counted once, and the two cancel.
--
-- Booking nothing at all would have been the other option and is worse: the
-- branch's return would vanish from the pool's history entirely, and nobody could
-- later ask how much stock was written off or why.
--
-- ADDITIVE. Existing rows default to 'saleable', which is what they already were.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'production_return_disposition') then
    create type production_return_disposition as enum ('saleable', 'damaged', 'expired');
  end if;
end
$$;

alter table production_returns
  add column if not exists disposition production_return_disposition not null default 'saleable',
  -- Free text on WHY it was written off, distinct from `reason` (why the branch
  -- sent it back). The two are different questions and were being answered in one
  -- box.
  add column if not exists disposition_note text;

comment on column production_returns.disposition is
  'What happened to the goods, independent of whether the return was accepted. saleable → credited to the pool; damaged/expired → received then written off, so the units never become sellable stock.';

-- The Returns screen filters by outcome, and a write-off report reads this alone.
create index if not exists production_returns_disposition_idx
  on production_returns (disposition, business_date desc);
