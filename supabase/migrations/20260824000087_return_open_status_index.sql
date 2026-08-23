-- ---------------------------------------------------------------------------
-- Widen the open-returns index to cover 'returned' (added in migration 86).
--
-- Separate file because it USES the new enum value in the index predicate, which
-- migration 86's own transaction may not do — see its header.
--
-- The predicate is "open work": a 'returned' row is not resolved, it is waiting
-- on the branch, and both screens that count outstanding returns want it. The
-- old 'pending'-only predicate silently excluded it.
-- ---------------------------------------------------------------------------
drop index if exists production_returns_status_idx;
create index production_returns_status_idx
  on production_returns (status)
  where status in ('pending', 'returned');
