-- 95: Finance Help Desk — FIN-HD query numbers, the Company Share category,
--     WAITING_FOR_FINANCE, NORMAL priority, and REOPEN.
--
-- Migration 94 moved this queue from the Finance Admin to ADMIN and built the
-- admin's correction controls. The product owner has since restated the brief
-- with the vocabulary settled, and five of its terms differ from what 94 built.
-- Four are naming; the fifth is a workflow 94 deliberately refused, and is the
-- reason this file is not a rename script.
--
--   1. The Query ID series is FIN-HD-YYYYMMDD-00001, not FIN-Q-YYYYMMDD-0001.
--   2. "Company Share" is a category in its own right, alongside Branch Share.
--   3. The waiting status is WAITING_FOR_FINANCE — it names who is being waited
--      ON, which is what a queue's status is for. 94 called it
--      waiting_for_information, which names what is being waited FOR and reads
--      identically whichever side is holding things up.
--   4. The middle priority is NORMAL, not medium.
--   5. A resolved query can be REOPENED.
--
-- ON (5), AND WHY 94's REASONING DOES NOT SURVIVE IT
--
-- Migration 94 wrote, in the transition table it shipped: "a resolved query is
-- not reopened — a further problem with the same record is a new query — which
-- is what keeps `resolved_at` a fact that never has to be un-written". That was
-- a real argument, and the brief now answers it directly (§12): a resolution the
-- raiser disputes is not a new problem, it is the same problem still open, and
-- filing it again loses the thread, the amendments and the reason the first
-- answer was wrong.
--
-- So `resolved_at` DOES get un-written — but nothing is lost when it is. The
-- resolution block is pushed onto `resolution_history` first, as a jsonb array
-- append, and that column is only ever appended to. A reopened query therefore
-- carries every previous answer it was given, in order, which is strictly more
-- than the "new query" route preserved: that one scattered the history across
-- two rows joined by nothing but a human remembering to quote a number.
--
-- RENAMES ARE VALUE RENAMES, NOT NEW COLUMNS. `status` and `priority` are text
-- columns behind CHECK constraints, so the rename is: drop the constraint,
-- rewrite the rows, re-add it. Existing rows move with the vocabulary. The
-- audit trail is NOT rewritten — a `finance_audit_logs` row saying a query moved
-- to 'waiting_for_information' is a record of what was done on the day, and
-- editing it to match today's spelling would be falsifying it.
--
-- QUERY NUMBERS ALREADY ISSUED ARE NOT RENUMBERED, for the same reason 94 did
-- not renumber the FQ- series: those numbers are quoted in resolution notes,
-- amendment rows and audit entries that already exist, and renumbering orphans
-- every one of them. Three series therefore coexist on this table — FQ-000001
-- (pre-94), FIN-Q-20260901-0001 (94) and FIN-HD-20260901-00001 (here) — and
-- `query_no` is unique across all three. Only the last is issued from now on.

-- ===========================================================================
-- 1. Query numbers — FIN-HD-YYYYMMDD-NNNNN
-- ===========================================================================
--
-- Same per-day counter table and the same single-statement upsert as 94: the
-- `insert … on conflict do update … returning` serialises concurrent callers on
-- the row lock rather than racing a read-then-write.
--
-- Five digits where 94 used four. Neither width is a limit — lpad does not
-- truncate, so the format simply grows a digit rather than colliding — but the
-- brief writes the ID out as FIN-HD-20260901-00001 and a Query ID that does not
-- look like the one in the specification is a support call every time someone
-- checks it against the document.
--
-- The counter is shared with 94's series rather than reset: a day that issued
-- FIN-Q-20260901-0001 continues at FIN-HD-20260901-00002, so the two series
-- never name the same query twice and the sequence stays gapless within the day.
create or replace function app.next_finance_query_no(p_day date default null) returns text
  language plpgsql as $$
  declare
    v_day   date := coalesce(p_day, (timezone('Asia/Karachi', now()))::date);
    v_count integer;
  begin
    insert into finance_query_counters (day, count)
         values (v_day, 1)
    on conflict (day) do update set count = finance_query_counters.count + 1
      returning count into v_count;

    return 'FIN-HD-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_count::text, 5, '0');
  end;
  $$;

-- ===========================================================================
-- 2. Categories — "Company Share" joins the list
-- ===========================================================================
--
-- The brief's category list names Company Share and Branch Share separately,
-- and they are separate records in this schema: a branch share payment settles
-- what a BRANCH is owed, a company share is the house's own cut of the same
-- split. A query about one sent to the other is a query pointed at the wrong
-- half of the arithmetic.
--
-- 'calculation_issue' is NOT dropped even though the brief's list omits it.
-- Queries already carry it, and removing a value a row holds would fail this
-- migration on any install that has one. It stays raisable; the UI's category
-- list is the brief's, in the brief's order, with this one kept at the end.
alter table finance_tickets drop constraint if exists finance_tickets_query_type_check;
alter table finance_tickets add constraint finance_tickets_query_type_check
  check (query_type in (
    'income', 'expense', 'company_transaction', 'partner_advance', 'company_share',
    'branch_share', 'salary', 'ledger', 'payment', 'stock_finance_difference',
    'calculation_issue', 'other'
  ));

-- ===========================================================================
-- 3. Priority — medium becomes normal
-- ===========================================================================
--
-- Order matters: the rows have to be rewritten while NO constraint forbids
-- either spelling, so the old constraint is dropped first and the new one added
-- last. Doing it the other way round fails on the first existing 'medium' row.
alter table finance_tickets drop constraint if exists finance_tickets_priority_check;

update finance_tickets set priority = 'normal' where priority = 'medium';

alter table finance_tickets alter column priority set default 'normal';

alter table finance_tickets add constraint finance_tickets_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));

-- ===========================================================================
-- 4. Statuses — WAITING_FOR_FINANCE, and REOPENED
-- ===========================================================================
--
--   open                 → raised, nobody has picked it up
--   under_review         → an admin is investigating
--   waiting_for_finance  → the admin has asked the raiser something
--   reopened             → a resolved query was disputed and is live again
--   resolved             → dealt with, correction applied or explained
--   rejected             → not an error, or out of scope
--   closed               → finished and filed
--
-- Stored lowercase, matching every other status column in this schema; the
-- uppercase forms in the brief are display labels and live in
-- FINANCE_TICKET_STATUS_LABELS on the shared types.
--
-- Same ordering rule as the priority rename above: constraints off, rows
-- rewritten, constraints back on.
--
-- BOTH constraints have to come off first, not just the status one.
-- `finance_tickets_resolution_check` also enumerates the statuses — it is what
-- says a live query carries no resolver — so it still names
-- 'waiting_for_information' while it is in force, and a row rewritten to
-- 'waiting_for_finance' underneath it matches NEITHER of its branches and is
-- rejected. Dropping only the status check would fail this migration on the
-- first install that has a query waiting on its raiser.
alter table finance_tickets drop constraint if exists finance_tickets_status_check;
alter table finance_tickets drop constraint if exists finance_tickets_resolution_check;

update finance_tickets set status = 'waiting_for_finance' where status = 'waiting_for_information';

alter table finance_tickets add constraint finance_tickets_status_check
  check (status in ('open', 'under_review', 'waiting_for_finance', 'reopened',
                    'resolved', 'rejected', 'closed'));

-- ---------------------------------------------------------------------------
-- The resolution invariant, restated once more.
--
-- Unchanged in spirit from 94: a TERMINAL query says when it ended, a LIVE one
-- carries no resolver. `reopened` is a live status, so reopening must CLEAR
-- resolved_by/resolved_at — which is exactly what makes the history column
-- below necessary rather than decorative.
-- ---------------------------------------------------------------------------
alter table finance_tickets add constraint finance_tickets_resolution_check
  check (
    (status in ('open', 'under_review', 'waiting_for_finance', 'reopened')
       and resolved_by is null and resolved_at is null)
    or
    (status in ('resolved', 'rejected', 'closed') and resolved_at is not null)
  );

-- ===========================================================================
-- 5. Reopening — the previous answer is kept, never overwritten
-- ===========================================================================
--
-- `resolution_history` is a jsonb ARRAY, appended to on every reopen and read by
-- nothing else. One element per resolution the query has had:
--
--   { "status": "resolved", "resolutionNote": "...", "adminResponse": "...",
--     "resolvedBy": "<uuid>", "resolvedByName": "...", "resolvedAt": "...",
--     "reopenedAt": "...", "reopenedByName": "...", "reopenReason": "..." }
--
-- A column rather than a `finance_ticket_resolutions` table because there is no
-- query anyone wants to run ACROSS resolutions — they are only ever read as
-- "the history of this one query", which is one row's worth of data displayed
-- in one popup. A table would add a join and a second append-only trigger to
-- protect exactly the same thing this column's write path already protects.
--
-- The append is done by the API in the same UPDATE that clears the live
-- resolution, guarded by `.eq('status', from)` — so two admins reopening at once
-- cannot both win, and no window exists where the resolution is cleared but not
-- yet archived. `finance_audit_logs` records the reopen independently, and IS
-- append-only at the database level; this column is the readable form of the
-- same fact, not its only copy.
--
-- `reopen_count` is denormalised from the array's length so the queue can show
-- "reopened twice" without every row shipping its whole history to the list.
alter table finance_tickets
  add column if not exists resolution_history jsonb   not null default '[]'::jsonb,
  add column if not exists reopen_count       integer not null default 0,
  add column if not exists reopened_at        timestamptz,
  add column if not exists reopened_by        uuid references users (id) on delete set null,
  add column if not exists reopened_by_name   text,
  add column if not exists reopen_reason      text;

-- An array, always — a scalar or an object here would break the API's append,
-- which reads the column and pushes onto it.
alter table finance_tickets drop constraint if exists finance_tickets_resolution_history_check;
alter table finance_tickets add constraint finance_tickets_resolution_history_check
  check (jsonb_typeof(resolution_history) = 'array');

-- The reopen stamp is set together or not at all: a query that says it was
-- reopened must say by whom and why, because §12's whole point is that a
-- disputed resolution is on the record as disputed.
alter table finance_tickets drop constraint if exists finance_tickets_reopen_check;
alter table finance_tickets add constraint finance_tickets_reopen_check
  check (
    (reopen_count = 0 and reopened_at is null and reopened_by_name is null and reopen_reason is null)
    or
    (reopen_count > 0 and reopened_at is not null and reopened_by_name is not null
       and length(btrim(reopen_reason)) > 0)
  );

-- ===========================================================================
-- 6. Resolution Type (§11) and the admin's internal note (§6)
-- ===========================================================================
--
-- `resolution_type` says what KIND of answer closed the query; `status` says
-- only that it closed. Neither derives the other — 'rejected' and 'duplicate'
-- both land in the REJECTED status, and a query resolved because the figure was
-- corrected reads very differently in a report from one resolved because the
-- figure was right all along. The status drives the workflow; this drives the
-- reporting.
--
-- `internal_note` is the admin's working note on the query. It is stripped by
-- `rowToApi` for a Finance caller rather than merely hidden by the UI — a note
-- the raiser must not read is not protected by a component that declines to
-- render it, since the row still crosses the wire.
alter table finance_tickets
  add column if not exists resolution_type text,
  add column if not exists internal_note   text;

alter table finance_tickets drop constraint if exists finance_tickets_resolution_type_check;
alter table finance_tickets add constraint finance_tickets_resolution_type_check
  check (resolution_type is null or resolution_type in (
    'fixed', 'information_provided', 'rejected', 'duplicate', 'other'
  ));

-- A live query has no resolution type, for the same reason it has no resolver:
-- the pair would say the query ended and the status would say it had not.
alter table finance_tickets drop constraint if exists finance_tickets_resolution_type_live_check;
alter table finance_tickets add constraint finance_tickets_resolution_type_live_check
  check (
    resolution_type is null
    or status in ('resolved', 'rejected', 'closed')
  );

-- The Finance user's "last update" column and the admin's Recently Updated
-- card both sort on this; without the index they sort in memory over the whole
-- live queue.
create index if not exists finance_tickets_updated_idx
  on finance_tickets (updated_at desc) where deleted_at is null;
