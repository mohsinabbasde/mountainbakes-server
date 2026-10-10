-- 76: a resolved query is a record, not rubbish. Archive instead of DELETE.
--
-- WHAT WAS WRONG
--
-- DELETE /api/support/:id ran a hard `.delete()` on support_tickets, and the
-- Support Center puts that behind a trash icon on every row. It was used as the
-- way to clear the queue, so the table is EMPTY — zero rows — even though
-- apply_stock_correction had written 35 corrections on 2026-08-16 alone, each
-- stamped '<ticket_id>:stock:<uuid>' into stock_history.ref_id.
--
-- Three things were lost every time:
--
--   1. The query itself — who raised it, against what, and what they said was
--      wrong. There is now no record that any query was ever received.
--   2. The resolution — resolution_note, resolved_by, resolved_at. PATCH
--      /:id/resolve writes all three and keeps the row; the delete threw them away
--      afterwards.
--   3. The audit anchor. apply_stock_correction (migration 33) treats the ticket
--      id as the reason a correction exists, and stock_history.ref_id still points
--      at it. Deleting the ticket leaves every one of those refs dangling, so
--      "why did 82 units come off this branch?" is unanswerable.
--
-- WHAT IT IS NOW
--
-- The same button archives: archived_at is stamped and the row stays. The list
-- hides archived tickets by default (so the queue still clears, which is what the
-- button was being used for), and ?includeArchived=true brings them back. Every
-- mutating route refuses an archived ticket — archiving is final from the UI's
-- point of view, it just is not destructive.
--
-- Nothing is backfilled: the deleted rows are gone and this migration cannot
-- invent them. It only stops the loss from here.

alter table support_tickets add column if not exists archived_at      timestamptz;
alter table support_tickets add column if not exists archived_by      uuid;
alter table support_tickets add column if not exists archived_by_name text;

-- Partial index: every list query filters `archived_at is null`, and that is the
-- overwhelmingly common read. Indexing only the live rows keeps it small.
create index if not exists support_tickets_live_idx
  on support_tickets (created_at desc)
  where archived_at is null;

comment on column support_tickets.archived_at is
  'Set when an admin archives the query from the Support Center. NULL = live. '
  'Archived rows are hidden from the default list but never deleted -- the ticket '
  'is the audit anchor for any correction applied from it (stock_history.ref_id '
  'is ''<ticket_id>:stock:<uuid>''). See migration 76.';
