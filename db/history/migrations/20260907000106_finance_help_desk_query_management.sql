-- 106: Finance Help Desk → Admin Query Management.
--
-- The desk migration 94–96 built is a ticket a Finance user raises against a
-- finance record and an Admin answers. The product owner now wants the query
-- itself to be a RECORD the Admin feeds: an amount, a branch, a business date,
-- remarks and reference handles that the Admin can correct field by field, with
-- every correction kept as a numbered VERSION; a query that can be saved as a
-- draft before it is sent; one that can be AMENDED (a versioned correction that
-- marks the query as such), RESTORED after a soft delete, and RECREATED under a
-- fresh Query ID that points back at the one it replaced.
--
-- Nothing here touches the books. `finance_tickets.amount` is what the QUERY
-- says the figure is, and correcting it corrects the query; the record behind
-- it is still changed only through `amend_finance_record` (migration 94), which
-- has its own reason, its own row in `finance_amendments` and its own audit
-- entry. The two paths are kept apart on purpose — see §17 of the brief.
--
-- WHAT THIS FILE DOES
--
--   1. Query IDs move to a per-YEAR series: FIN-QRY-2026-000001. Existing
--      numbers (FQ-, FIN-Q-YYYYMMDD-) are kept, never reissued.
--   2. New columns on finance_tickets: amount, branch, business date, remarks,
--      three reference handles, resolution amount, version, draft/amend/
--      recreate stamps.
--   3. Two statuses: `draft` (before submission) and `amended`.
--   4. finance_ticket_versions — one row per version of a query, with the
--      field-level diff and the full snapshot. Append-only.
--   5. finance_ticket_stats() — the dashboard cards, counted in SQL so the queue
--      can be paginated without the cards counting only the current page.

-- ===========================================================================
-- 1. Query ID — FIN-QRY-YYYY-NNNNNN
-- ===========================================================================
--
-- A per-year counter rather than the per-day one from 94. The brief's example
-- IDs are yearly and six digits, and a yearly series is what a person quoting
-- a Query ID over the phone can actually say. Kept in its own table beside
-- finance_query_counters (which stays, untouched, so the old function's rows
-- remain readable); the day-keyed table is simply no longer written to.
create table if not exists finance_query_year_counters (
  year  integer primary key,
  count integer not null default 0
);

alter table finance_query_year_counters enable row level security;

-- Same signature as before so the column default (`app.next_finance_query_no()`)
-- keeps working. Gapless within a year; concurrent callers serialise on the row.
create or replace function app.next_finance_query_no(p_day date default null) returns text
  language plpgsql as $$
  declare
    v_year  integer := extract(year from coalesce(p_day, (timezone('Asia/Karachi', now()))::date))::integer;
    v_count integer;
  begin
    insert into finance_query_year_counters (year, count)
         values (v_year, 1)
    on conflict (year) do update set count = finance_query_year_counters.count + 1
      returning count into v_count;

    return 'FIN-QRY-' || v_year::text || '-' || lpad(v_count::text, 6, '0');
  end;
  $$;

-- ===========================================================================
-- 2. The query as a fed record
-- ===========================================================================
alter table finance_tickets
  -- The figure the query is ABOUT, as the raiser states it. Not the figure on
  -- the record: that lives on the record, and the two are compared, not synced.
  add column if not exists amount            numeric(14,2),
  add column if not exists branch_id         uuid references branches (id) on delete set null,
  add column if not exists branch_name       text,
  add column if not exists business_date     date,
  add column if not exists remarks           text,
  -- The brief's Transaction ID / Expense ID / Income ID. Free-text handles like
  -- `voucher_ref`: displayed, never resolved. `reference_no` remains the one
  -- handle the API resolves to a row.
  add column if not exists transaction_ref   text,
  add column if not exists expense_ref       text,
  add column if not exists income_ref        text,
  -- §11's Resolution Amount: what the Admin says the correct figure is. A
  -- statement on the query, not a write to the books.
  add column if not exists resolution_amount numeric(14,2),
  -- The version the row is currently at. 1 on creation; +1 on every change that
  -- writes a finance_ticket_versions row.
  add column if not exists version           integer not null default 1,
  -- Drafts: when it left the raiser's hands. Null while still a draft, and for
  -- pre-106 rows, which were all submitted on creation.
  add column if not exists submitted_at      timestamptz,
  -- Amend stamps (§6). The count is denormalised so the queue can show it.
  add column if not exists amend_count       integer not null default 0,
  add column if not exists amended_at        timestamptz,
  add column if not exists amended_by        uuid references users (id) on delete set null,
  add column if not exists amended_by_name   text,
  -- Recreate (§9): both directions, so either query can say what happened.
  add column if not exists recreated_from_id       uuid references finance_tickets (id) on delete set null,
  add column if not exists recreated_from_query_no text,
  add column if not exists recreated_as_id         uuid references finance_tickets (id) on delete set null,
  add column if not exists recreated_as_query_no   text,
  -- Restore (§8): who brought a deleted query back and why.
  add column if not exists restored_at       timestamptz,
  add column if not exists restored_by       uuid references users (id) on delete set null,
  add column if not exists restored_by_name  text,
  add column if not exists restore_reason    text;

-- Every query raised before this migration was submitted the moment it was
-- created; say so, so "submitted" is never blank on an old row.
update finance_tickets set submitted_at = created_at where submitted_at is null;

alter table finance_tickets drop constraint if exists finance_tickets_amount_check;
alter table finance_tickets add constraint finance_tickets_amount_check
  check (amount is null or amount >= 0);

alter table finance_tickets drop constraint if exists finance_tickets_resolution_amount_check;
alter table finance_tickets add constraint finance_tickets_resolution_amount_check
  check (resolution_amount is null or resolution_amount >= 0);

alter table finance_tickets drop constraint if exists finance_tickets_version_check;
alter table finance_tickets add constraint finance_tickets_version_check
  check (version >= 1);

-- ===========================================================================
-- 3. Statuses — DRAFT and AMENDED
-- ===========================================================================
--
--   draft                → saved by the raiser, not yet sent; only they see it
--   open                 → PENDING — submitted, nobody has picked it up
--   under_review         → IN REVIEW
--   waiting_for_finance  → the admin has asked the raiser something
--   amended              → an admin corrected the query itself (§6)
--   reopened             → a resolved query was disputed and is live again
--   resolved / rejected / closed → terminal
--
-- Both constraints come off first (see 95 for why), then go back on with the
-- two new values. No row is rewritten, so nothing here can fail on data.
alter table finance_tickets drop constraint if exists finance_tickets_status_check;
alter table finance_tickets drop constraint if exists finance_tickets_resolution_check;

alter table finance_tickets add constraint finance_tickets_status_check
  check (status in ('draft', 'open', 'under_review', 'waiting_for_finance', 'amended',
                    'reopened', 'resolved', 'rejected', 'closed'));

alter table finance_tickets add constraint finance_tickets_resolution_check
  check (
    (status in ('draft', 'open', 'under_review', 'waiting_for_finance', 'amended', 'reopened')
       and resolved_by is null and resolved_at is null)
    or
    (status in ('resolved', 'rejected', 'closed') and resolved_at is not null)
  );

-- A draft is the raiser's alone until submitted; a submitted query says when.
alter table finance_tickets drop constraint if exists finance_tickets_draft_check;
alter table finance_tickets add constraint finance_tickets_draft_check
  check (
    (status = 'draft' and submitted_at is null)
    or
    (status <> 'draft' and submitted_at is not null)
  );

-- Indexes for the filters the brief lists (§3, §19): branch, business date,
-- amount, and the raiser+status pair the Finance user's own list reads.
create index if not exists finance_tickets_branch_idx
  on finance_tickets (branch_id, created_at desc) where deleted_at is null;
create index if not exists finance_tickets_business_date_idx
  on finance_tickets (business_date desc) where deleted_at is null;
create index if not exists finance_tickets_amount_idx
  on finance_tickets (amount) where deleted_at is null and amount is not null;
create index if not exists finance_tickets_raised_status_idx
  on finance_tickets (raised_by, status, created_at desc);
create index if not exists finance_tickets_deleted_idx
  on finance_tickets (deleted_at desc) where deleted_at is not null;
create index if not exists finance_tickets_recreated_from_idx
  on finance_tickets (recreated_from_id) where recreated_from_id is not null;

-- ===========================================================================
-- 4. finance_ticket_versions — every version of every query
-- ===========================================================================
--
-- One row per version. `changes` is the field-level diff that produced this
-- version — [{ field, old, new }] — and `snapshot` is the whole row AFTER it,
-- so a version can be read on its own without replaying the ones before it.
--
-- Its own table rather than more rows in finance_audit_logs, which stays the
-- who-did-what trail for the whole module: the brief's View History is "show me
-- version 3 of this query", and answering that from a JSON blob of previous
-- values means reconstructing the row in the client every time. The audit log
-- still receives every one of these writes; this is the readable form.
create table if not exists finance_ticket_versions (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references finance_tickets (id) on delete cascade,
  query_no        text not null,
  version         integer not null,
  -- What produced the version: created | submitted | edited | amended |
  -- status_changed | assigned | responded | resolved | reopened | deleted |
  -- restored | recreated. Free text under a CHECK, like every other action here.
  action          text not null,
  changed_by      uuid references users (id) on delete set null,
  changed_by_name text not null default '',
  changed_by_role text,
  changed_at      timestamptz not null default now(),
  reason          text,
  changes         jsonb not null default '[]'::jsonb,
  snapshot        jsonb not null,

  constraint finance_ticket_versions_unique unique (ticket_id, version),
  constraint finance_ticket_versions_version_check check (version >= 1),
  constraint finance_ticket_versions_changes_check check (jsonb_typeof(changes) = 'array'),
  constraint finance_ticket_versions_action_check check (action in (
    'created', 'submitted', 'edited', 'amended', 'status_changed', 'assigned', 'responded',
    'resolved', 'reopened', 'deleted', 'restored', 'recreated'
  ))
);

create index if not exists finance_ticket_versions_ticket_idx
  on finance_ticket_versions (ticket_id, version desc);

-- Append-only. A version that can be rewritten is not a version.
create or replace function app.finance_ticket_versions_append_only() returns trigger
  language plpgsql as $$
  begin
    raise exception 'finance_ticket_versions is append-only (% attempted)', tg_op;
  end;
  $$;

drop trigger if exists finance_ticket_versions_immutable on finance_ticket_versions;
create trigger finance_ticket_versions_immutable
  before update or delete on finance_ticket_versions
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on')
  execute function app.finance_ticket_versions_append_only();

alter table finance_ticket_versions enable row level security;

-- Backfill: every existing query gets a Version 1 that is simply how it stands
-- now. The trail before this point lives in finance_audit_logs and is still
-- shown on the query; this is so View History never opens empty.
insert into finance_ticket_versions
  (ticket_id, query_no, version, action, changed_by, changed_by_name, changed_by_role, changed_at, reason, changes, snapshot)
select
  t.id, t.query_no, 1, 'created', t.raised_by, t.raised_by_name, t.raised_by_role, t.created_at,
  null, '[]'::jsonb, to_jsonb(t)
from finance_tickets t
where not exists (
  select 1 from finance_ticket_versions v where v.ticket_id = t.id
);

-- ===========================================================================
-- 5. finance_ticket_stats — the dashboard cards, counted in SQL
-- ===========================================================================
--
-- The queue is paginated from this migration on, so counting the cards from
-- the loaded page would count one page. One grouped scan instead of nine COUNT
-- round trips. `p_raised_by` scopes a Finance user to their own queries — the
-- API passes it from the JWT, never from the client.
create or replace function finance_ticket_stats(p_raised_by uuid default null)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
  as $$
    with live as (
      select *
        from finance_tickets
       where deleted_at is null
         and (p_raised_by is null or raised_by = p_raised_by)
         -- Another person's draft is not on the desk yet.
         and (status <> 'draft' or (p_raised_by is not null and raised_by = p_raised_by))
    )
    select jsonb_build_object(
      'total',        (select count(*) from live),
      'draft',        (select count(*) from live where status = 'draft'),
      'open',         (select count(*) from live where status = 'open'),
      'underReview',  (select count(*) from live where status = 'under_review'),
      'waiting',      (select count(*) from live where status = 'waiting_for_finance'),
      'amended',      (select count(*) from live where status = 'amended'),
      'reopened',     (select count(*) from live where status = 'reopened'),
      'resolved',     (select count(*) from live where status = 'resolved'),
      'rejected',     (select count(*) from live where status = 'rejected'),
      'closed',       (select count(*) from live where status = 'closed'),
      'highPriority', (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and priority in ('high', 'urgent')),
      'urgent',       (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and priority = 'urgent'),
      'unassigned',   (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and assigned_to is null),
      'recent',       (select count(*) from live where updated_at > now() - interval '24 hours'),
      'deleted',      (select count(*) from finance_tickets
                        where deleted_at is not null
                          and (p_raised_by is null or raised_by = p_raised_by))
    );
  $$;

revoke all on function finance_ticket_stats(uuid) from public, anon, authenticated;
grant execute on function finance_ticket_stats(uuid) to service_role;
