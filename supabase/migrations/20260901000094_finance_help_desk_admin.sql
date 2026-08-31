-- 94: Finance Help Desk → ADMIN.
--
-- Migration 60 built the Finance Help Desk as a queue the FINANCE ADMIN owned,
-- and said so in its header: folding finance queries into the admin Support
-- Center "would put them in a queue super_admin already fully controls, which is
-- exactly the separation the module exists to keep."
--
-- The product owner has now asked for the opposite, explicitly and in those
-- terms: a Finance user REPORTS, VIEWS and DISCUSSES; only ADMIN changes,
-- edits, amends, overwrites, deletes, approves, rejects and resolves — and
-- every one of those changes must be traceable back to the query that prompted
-- it. That is a deliberate reversal of migration 60's separation, not an
-- oversight, and this file is where it happens.
--
-- WHAT THAT MEANS FOR finance_admin. It is demoted, here, to a Finance user: it
-- may raise a query, watch it and reply to it, and it may no longer resolve one
-- or touch the record behind it through this queue. The brief's §3 is
-- unambiguous — "Do not send the query to another Finance user first" — and a
-- finance_admin is a Finance-module account. Its authority over the BOOKS
-- (approving a voucher, posting an entry) is untouched; only the Help Desk
-- moves. requireFinanceHelpDeskAdmin() in src/middleware/requireFinance.ts is
-- the enforcement, and it deliberately does NOT consult
-- finance_settings.allowSuperAdminWrite: that toggle guards a super admin
-- writing to the books OUTSIDE this queue, whereas the whole point of the Help
-- Desk is to be the sanctioned, audited channel for exactly those corrections.
-- Gating it on a flag that defaults to off would leave every query unanswerable
-- on a fresh install.
--
-- WHAT THIS FILE ADDS
--
--   1. Query numbers in the FIN-Q-YYYYMMDD-NNNN series, per-day sequenced.
--   2. Six statuses, a query type, a priority, an admin response block, and an
--      assignee — the Help Desk the brief describes.
--   3. finance_ticket_messages — the append-only conversation on a query.
--   4. finance_amendments — what an admin changed, from what to what, why, and
--      under which query. Append-only.
--   5. SOFT DELETE on the seven finance record tables, and the read paths that
--      have to start honouring it. This is the invasive half; see §5 below.
--
-- API-owned tables, per migration 09's taxonomy: RLS is enabled with no policy,
-- so the service-role API is the only reader and writer, and authorization
-- lives in the route handlers. The brief's §15 asks for RLS that distinguishes
-- Finance from Admin; the honest implementation of that in THIS schema is a
-- table no browser session can reach at all, plus an API that re-decides the
-- question from the JWT on every request. A permissive policy keyed on a role
-- claim would be strictly weaker than what is already here.

-- ===========================================================================
-- 1. Query numbers — FIN-Q-YYYYMMDD-NNNN
-- ===========================================================================
--
-- A per-day sequence, so the number carries the date it was raised and restarts
-- at 0001 each morning. That is the format the brief specifies, and it cannot
-- come from `counters` + next_finance_number(): that counter is monotonic for
-- the life of the install, which is the right shape for a voucher series and
-- the wrong one for a number that embeds a date.
--
-- Its own table rather than a `counters` row per day, because the latter grows
-- a row per day inside a table migration 46 restores as CONFIGURATION — a
-- date-keyed sequence is data, and mixing the two would make that restore
-- either lossy or unbounded.
create table finance_query_counters (
  day   date primary key,
  count integer not null default 0
);

alter table finance_query_counters enable row level security;

-- ---------------------------------------------------------------------------
-- app.next_finance_query_no()
--
-- Gapless within a day. The `insert … on conflict do update` is a single
-- statement, so concurrent callers serialise on the row lock rather than racing
-- a read-then-write; `returning` hands back the value this caller won.
--
-- Four digits, not six: this is a help-desk queue, and 9999 queries in one day
-- is not a number this business reaches. lpad does not truncate, so the format
-- degrades to five digits rather than colliding if it ever did.
-- ---------------------------------------------------------------------------
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

    return 'FIN-Q-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_count::text, 4, '0');
  end;
  $$;

-- ===========================================================================
-- 2. finance_tickets — the Help Desk query itself
-- ===========================================================================

alter table finance_tickets
  -- The brief's Query ID. `ticket_no` (FQ-000001) is KEPT, not renamed: it is
  -- printed on every query raised before today and quoted in resolution notes
  -- and audit rows that already exist. Two numbers on one row is the price of
  -- not invalidating those; the UI shows `query_no` and nothing shows both.
  add column if not exists query_no                text,
  add column if not exists query_type              text not null default 'other',
  add column if not exists priority                text not null default 'medium',
  -- The brief lists "Reference ID" and "Ledger/Voucher ID" as separate fields.
  -- `reference_no` is the one the API RESOLVES to a record; this is the
  -- secondary handle a raiser cites when the two differ — the voucher a salary
  -- posted to, say — and it is never looked up, only displayed.
  add column if not exists voucher_ref             text,
  add column if not exists admin_response          text,
  add column if not exists responded_by            uuid references users (id) on delete set null,
  add column if not exists responded_by_name       text,
  add column if not exists responded_at            timestamptz,
  add column if not exists assigned_to             uuid references users (id) on delete set null,
  add column if not exists assigned_to_name        text,
  add column if not exists assigned_at             timestamptz,
  -- Set when the RAISER answers a WAITING_FOR_INFORMATION query — the brief's
  -- "Mark information as received". It is the one status-adjacent write a
  -- Finance user is allowed to make on their own query.
  add column if not exists information_received_at timestamptz;

-- Backfill: every existing query keeps its identity under the new column, so
-- `query_no` can be NOT NULL and the UI never has to fall back. These rows
-- deliberately keep the FQ- number rather than being renumbered into the new
-- series — renumbering would break the audit rows that name them.
update finance_tickets set query_no = ticket_no where query_no is null;

alter table finance_tickets
  alter column query_no set not null,
  alter column query_no set default app.next_finance_query_no();

create unique index if not exists finance_tickets_query_no_idx on finance_tickets (query_no);

-- ---------------------------------------------------------------------------
-- A reference is now OPTIONAL.
--
-- Migration 60 required one, which was right when every query was raised
-- against a voucher. The brief's query types include "Calculation Issue" and
-- "Other", which by their nature name no single record — requiring a reference
-- there would force a raiser to invent one, and an invented reference is worse
-- than an absent one because it sends the admin to the wrong row.
-- ---------------------------------------------------------------------------
alter table finance_tickets
  alter column reference_type drop not null,
  alter column reference_no   drop not null;

-- ---------------------------------------------------------------------------
-- The six statuses.
--
-- Stored lowercase, matching every other status column in this schema; the
-- uppercase forms in the brief are display labels and live in
-- FINANCE_QUERY_STATUS_LABELS on the shared types.
--
--   open                    → raised, nobody has picked it up
--   under_review            → an admin is investigating
--   waiting_for_information → the admin has asked the raiser something
--   resolved                → dealt with, correction applied or explained
--   rejected                → not an error, or out of scope
--   closed                  → finished and filed; nothing further will happen
-- ---------------------------------------------------------------------------
alter table finance_tickets drop constraint if exists finance_tickets_status_check;
alter table finance_tickets add constraint finance_tickets_status_check
  check (status in ('open', 'under_review', 'waiting_for_information',
                    'resolved', 'rejected', 'closed'));

alter table finance_tickets drop constraint if exists finance_tickets_query_type_check;
alter table finance_tickets add constraint finance_tickets_query_type_check
  check (query_type in (
    'income', 'expense', 'company_transaction', 'partner_advance', 'branch_share',
    'salary', 'ledger', 'payment', 'stock_finance_difference', 'calculation_issue', 'other'
  ));

alter table finance_tickets drop constraint if exists finance_tickets_priority_check;
alter table finance_tickets add constraint finance_tickets_priority_check
  check (priority in ('low', 'medium', 'high', 'urgent'));

-- ---------------------------------------------------------------------------
-- Resolution invariant, restated for six statuses.
--
-- Migration 60's version said "open ⇒ no resolver, anything else ⇒ resolved_at
-- is set". With `under_review` and `waiting_for_information` in the middle of
-- the workflow that would demand a resolution timestamp on a query nobody has
-- resolved. The invariant that actually matters is unchanged in spirit: a
-- TERMINAL query says when it ended, and a LIVE one carries no resolver.
-- ---------------------------------------------------------------------------
alter table finance_tickets drop constraint if exists finance_tickets_resolution_check;
alter table finance_tickets add constraint finance_tickets_resolution_check
  check (
    (status in ('open', 'under_review', 'waiting_for_information')
       and resolved_by is null and resolved_at is null)
    or
    (status in ('resolved', 'rejected', 'closed') and resolved_at is not null)
  );

-- ---------------------------------------------------------------------------
-- The query itself is soft-deleted too.
--
-- Migration 60 gave the Finance Admin a REAL delete and was explicit about the
-- consequence: the trail recorded that a query had been deleted and by whom,
-- but never what it said, so the text was "genuinely gone, which is the intent".
--
-- That intent does not survive §21. A query is now the justification for every
-- correction made to the books under it — finance_amendments.ticket_id is NOT
-- NULL and ON DELETE RESTRICT precisely so a correction can always be traced
-- back — and a justification that can be destroyed by the person who acted on
-- it is not a justification. So the query is stamped like every other finance
-- record, and an admin can still read it afterwards.
-- ---------------------------------------------------------------------------
alter table finance_tickets
  add column if not exists deleted_at      timestamptz,
  add column if not exists deleted_by      uuid references users (id) on delete set null,
  add column if not exists deleted_by_name text,
  add column if not exists delete_reason   text;

create index if not exists finance_tickets_live_idx
  on finance_tickets (deleted_at) where deleted_at is null;

-- The Help Desk's dashboard cards count by status and by priority; the admin
-- queue sorts urgent-first within open.
create index if not exists finance_tickets_priority_idx on finance_tickets (priority, created_at desc);
create index if not exists finance_tickets_assigned_idx on finance_tickets (assigned_to, status);

-- ===========================================================================
-- 3. finance_ticket_messages — the conversation
-- ===========================================================================
--
-- APPEND-ONLY, for both sides. The brief asks that Finance users not be able to
-- delete a message; the trigger below refuses UPDATE and DELETE from everyone,
-- admin included, which is the stronger and simpler promise. A thread where one
-- party can retract what they said is not a record of a disagreement, and a
-- disagreement about a financial correction is exactly what this thread exists
-- to hold.
--
-- Attachments hang off a message through the generic (entity, entity_id) table
-- from migration 67, not a column here — same as every other photo in the app.
create table finance_ticket_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references finance_tickets (id) on delete cascade,

  author_id    uuid references users (id) on delete set null,
  author_name  text not null default '',
  author_role  text,
  -- 'finance' or 'admin' — which SIDE of the desk spoke, decided by the API
  -- from the JWT and stored, so the thread still reads correctly after someone
  -- changes role. Deriving it from author_role at read time would silently
  -- reattribute history.
  author_side  text not null,

  body         text not null,
  created_at   timestamptz not null default now(),

  constraint finance_ticket_messages_side_check check (author_side in ('finance', 'admin')),
  constraint finance_ticket_messages_body_check check (length(btrim(body)) > 0)
);

create index finance_ticket_messages_ticket_idx
  on finance_ticket_messages (ticket_id, created_at);

create or replace function app.finance_ticket_messages_append_only() returns trigger
  language plpgsql as $$
  begin
    raise exception
      'a Help Desk message is permanent. It cannot be % — post a follow-up message instead.',
      case when tg_op = 'DELETE' then 'deleted' else 'edited' end;
  end;
  $$;

-- A ticket deletion still cascades: the constraint is on editing the thread,
-- not on the parent's lifecycle, and `on delete cascade` fires without running
-- a BEFORE DELETE row trigger's exception path only because the trigger below
-- excludes it — see the WHEN clause.
create trigger finance_ticket_messages_immutable
  before update or delete on finance_ticket_messages
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on')
  execute function app.finance_ticket_messages_append_only();

alter table finance_ticket_messages enable row level security;

-- ===========================================================================
-- 4. finance_amendments — what an admin changed, and under which query
-- ===========================================================================
--
-- The brief's §9 and §12: an amendment is not a silent overwrite, it is a
-- RECORD — original value, new value, difference, reason, admin, timestamp,
-- query id. finance_audit_logs already captures who-did-what-when for the whole
-- module, and still does; this table is narrower and answers a different
-- question: "show me every correction ever made to the books, with the query
-- that justified it". That is a report an auditor asks for directly, and
-- reconstructing it by filtering a JSON blob in the trail is not the same thing.
--
-- Append-only, like the trail it complements.
create table finance_amendments (
  id             uuid primary key default gen_random_uuid(),

  -- The query that justified the change. NOT NULL and without ON DELETE
  -- CASCADE: the brief's §21 requires every admin change to trace back to a
  -- query id, so an amendment with no query must not be creatable, and deleting
  -- a query must not be able to erase the corrections made under it. The FK is
  -- RESTRICT, which is what makes finance_tickets undeletable once it has
  -- amendments — deliberately.
  ticket_id      uuid not null references finance_tickets (id) on delete restrict,
  query_no       text not null,

  reference_type text not null,
  reference_id   uuid,
  reference_no   text not null,

  -- 'edit' | 'amend' | 'overwrite' | 'delete' — the brief's verbs, kept
  -- distinct because they mean different things to a reader of this table even
  -- where the mechanism is shared. An `amend` reverses and re-posts; an
  -- `overwrite` writes over an approved figure in place and required an extra
  -- confirmation; a `delete` is the soft delete in §5.
  action         text not null,

  -- What moved. `field` is the column's name in API (camelCase) form, so the
  -- table reads the same way the screen that produced it does.
  field          text not null,
  original_value text,
  new_value      text,
  -- Populated only when both sides parse as numbers, so a money correction can
  -- be summed and reported on without re-parsing text. Null for a description
  -- or a date change, which is not a defect.
  difference     numeric(14,2),

  reason         text not null,

  admin_id       uuid references users (id) on delete set null,
  admin_name     text not null default '',
  ip_address     text,

  created_at     timestamptz not null default now(),

  constraint finance_amendments_action_check
    check (action in ('edit', 'amend', 'overwrite', 'delete')),
  constraint finance_amendments_reason_check
    check (length(btrim(reason)) > 0)
);

create index finance_amendments_ticket_idx    on finance_amendments (ticket_id, created_at desc);
create index finance_amendments_reference_idx on finance_amendments (reference_type, reference_id);
create index finance_amendments_created_idx   on finance_amendments (created_at desc);

create or replace function app.finance_amendments_append_only() returns trigger
  language plpgsql as $$
  begin
    raise exception 'finance_amendments is append-only; a correction record cannot be % once written',
      case when tg_op = 'DELETE' then 'deleted' else 'altered' end;
  end;
  $$;

create trigger finance_amendments_immutable
  before update or delete on finance_amendments
  for each row execute function app.finance_amendments_append_only();

alter table finance_amendments enable row level security;

-- ===========================================================================
-- 5. Soft delete on the finance record tables
-- ===========================================================================
--
-- The brief's §10: only Admin may delete, and a financial record should be soft
-- deleted or reversed rather than destroyed, keeping deleted_at / deleted_by /
-- delete_reason / query_id and staying readable to an authorised admin for
-- audit.
--
-- This replaces delete_finance_ticket_source() (migrations 61/64), which was a
-- REAL delete and, for a ledger entry, one that punched through the
-- immutability trigger migration 52 installed. That function is left in place
-- but is no longer called by anything — see the note at the end of this file.
--
-- WHAT MAKES THIS INVASIVE, stated once so it is not rediscovered: a soft
-- delete is only a delete if every reader honours it. Adding the column is the
-- easy half; the second half is that ~58 `.from('<finance table>')` call sites
-- in the API and four SQL functions in this schema all have to start excluding
-- the stamped rows, and any one of them that is missed reports a record the
-- rest of the system considers gone. The API side is handled by
-- withoutDeleted() in src/utils/softDelete.ts, applied at every finance read;
-- the SQL side is the four functions redefined below.
--
-- ledger_entries is included, and its `balance` chain is recomputed on the way
-- out (§5.3) exactly as migration 64 does for a hard delete. Soft-deleting a
-- voucher from the middle of the book leaves every later balance carrying its
-- amount otherwise, which is the drift migration 62 was written to repair.

-- ---------------------------------------------------------------------------
-- 5.1 The columns.
--
-- `deleted_query_id` rather than `query_id`: the brief names the column
-- `query_id`, but these tables already carry several *_id columns naming other
-- things and a bare `query_id` on `salary_payments` reads as "the query this
-- salary belongs to". The name says what it is — the query under which this row
-- was deleted — and it is the field the API exposes as `deletedQueryId`.
--
-- No FK to finance_tickets: the reference is informational and a query that is
-- itself deleted must not be able to resurrect a record by cascading. The
-- number is stored alongside it for the same reason the amendment table stores
-- `query_no` — so the row is readable without a join.
-- ---------------------------------------------------------------------------
do $$
  declare t text;
  begin
    foreach t in array array[
      'ledger_entries', 'finance_transactions', 'salary_payments',
      'employee_advances', 'partner_expenses', 'branch_share_payments',
      'finance_income_approvals'
    ] loop
      execute format($f$
        alter table %I
          add column if not exists deleted_at       timestamptz,
          add column if not exists deleted_by       uuid references users (id) on delete set null,
          add column if not exists deleted_by_name  text,
          add column if not exists delete_reason    text,
          add column if not exists deleted_query_id uuid,
          add column if not exists deleted_query_no text
      $f$, t);

      -- Partial, on the LIVE rows: every ordinary read now carries
      -- `deleted_at is null`, and a partial index is what keeps that predicate
      -- from costing a sequential scan on the book's largest table.
      execute format(
        'create index if not exists %I on %I (deleted_at) where deleted_at is null',
        t || '_live_idx', t);
    end loop;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- 5.1b The one UNIQUE constraint that soft delete breaks.
--
-- `finance_income_approvals` is unique on (branch_id, business_date) — migration
-- 52's note: "one row per branch per business date, so re-running the import is
-- idempotent instead of duplicating a day's takings".
--
-- Soft delete turns that guarantee into a trap. Once a branch's day is deleted
-- under a query, the row is still there, so:
--
--   * the fresh import's INSERT collides with it on the unique index, and
--   * importBranchIncome's "is it already here?" read finds it and either skips
--     the branch as already-imported or refreshes the DELETED row in place —
--     which leaves deleted_at set and the day invisible.
--
-- Either way the branch's takings can never be re-entered, which makes deleting
-- a wrong income row a one-way door. That is the opposite of what §10 is for.
--
-- A partial unique INDEX — not a constraint; constraints cannot carry a WHERE —
-- scoped to the live rows. Uniqueness still holds over everything the system
-- considers real, a deleted day no longer blocks its replacement, and the
-- import's 23505 race guard keeps working because a unique index raises the
-- same SQLSTATE a unique constraint does.
--
-- The service side of this is `withoutDeleted()` on the existing-rows read in
-- finance-income.service.ts; neither half works alone.
-- ---------------------------------------------------------------------------
alter table finance_income_approvals
  drop constraint if exists finance_income_approvals_branch_id_business_date_key;

create unique index if not exists finance_income_approvals_live_day_idx
  on finance_income_approvals (branch_id, business_date)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 5.2 The ledger's immutability trigger has to permit the stamp.
--
-- The tuple it compares does not mention the soft-delete columns, so stamping
-- them already passes — but only by omission, which is not a guarantee anybody
-- should rely on. This redefinition says so explicitly and, more importantly,
-- refuses a stamp that ALSO moves money: soft-deleting a voucher must not be a
-- way to quietly edit its amount on the way past.
--
-- Everything else is migration 62's version, unchanged: DELETE still raises
-- unless the app.allow_ledger_delete window is open, and the balance-recompute
-- window still permits `balance` and nothing else.
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

-- ---------------------------------------------------------------------------
-- 5.3 The four SQL readers that have to exclude deleted rows.
--
-- Redefined in full rather than patched, because `create or replace function`
-- has no partial form — the whole body is restated with the one predicate
-- added, and the comments from migrations 52/62/64 that still apply are kept.
-- ---------------------------------------------------------------------------

-- post_finance_ledger_entry: the running balance must chain from the last LIVE
-- row. Seeding it from a soft-deleted one carries that row's amount forward
-- into every entry posted afterwards. Otherwise identical to migration 71.
create or replace function post_finance_ledger_entry(
  p_entry_date        date,
  p_ledger_head_id    uuid,
  p_description       text,
  p_debit             numeric,
  p_credit            numeric,
  p_account           finance_account,
  p_source_type       finance_ledger_source,
  p_source_id         uuid          default null,
  p_branch_id         uuid          default null,
  p_branch_name       text          default null,
  p_payment_method    text          default null,
  p_approved_by       uuid          default null,
  p_approved_by_name  text          default null,
  p_created_by        uuid          default null,
  p_created_by_name   text          default null,
  p_reverses_entry_id uuid          default null
) returns ledger_entries
  language plpgsql
  as $$
  declare
    v_head    ledger_heads%rowtype;
    v_prev    numeric(14,2);
    v_entry   ledger_entries%rowtype;
    v_debit   numeric(14,2) := round(coalesce(p_debit, 0), 2);
    v_credit  numeric(14,2) := round(coalesce(p_credit, 0), 2);
  begin
    if (v_debit > 0) = (v_credit > 0) then
      raise exception 'a ledger entry must be exactly one of debit or credit (got debit=%, credit=%)',
        v_debit, v_credit;
    end if;

    select * into v_head from ledger_heads where id = p_ledger_head_id;
    if not found then
      raise exception 'ledger head % does not exist', p_ledger_head_id;
    end if;
    -- An inactive head may still be REVERSED against (the original posting
    -- predates the deactivation), but nothing new may be filed under it.
    if not v_head.is_active and p_reverses_entry_id is null then
      raise exception 'ledger head % (%) is inactive and cannot accept new entries', v_head.code, v_head.name;
    end if;

    if exists (select 1 from finance_day_closings where business_date = p_entry_date) then
      raise exception
        'the finance day % is closed. Post the correction to an open date — a closed '
        'day is locked so its reported closing balance stays the one that was signed off.',
        p_entry_date;
    end if;

    -- Serialise every posting: the running balance below is only meaningful if
    -- no other posting can slip between the read and the insert.
    perform pg_advisory_xact_lock(hashtext('finance_ledger_post'));

    -- `where deleted_at is null` is this migration's only change to the body.
    select balance into v_prev
      from ledger_entries where deleted_at is null order by seq desc limit 1;
    v_prev := coalesce(v_prev, 0);

    insert into ledger_entries (
      voucher_no, entry_date, ledger_head_id, ledger_head_name, ledger_head_type,
      branch_id, branch_name, description, debit, credit, balance, account,
      payment_method, source_type, source_id, reverses_entry_id,
      approved_by, approved_by_name, created_by, created_by_name
    ) values (
      -- Exactly one side is non-zero (the CHECK at the top of this function
      -- guarantees it), so this never falls through to the wrong series: debit
      -- is money in, everything else is money out.
      case when v_debit > 0
        then app.next_finance_number('finance_receipt_voucher', 'RV')
        else app.next_finance_number('finance_payment_voucher', 'PV')
      end,
      p_entry_date, v_head.id, v_head.name, v_head.type,
      p_branch_id, p_branch_name, p_description, v_debit, v_credit,
      v_prev + v_debit - v_credit, p_account,
      p_payment_method, p_source_type, p_source_id, p_reverses_entry_id,
      p_approved_by, p_approved_by_name, p_created_by, p_created_by_name
    )
    returning * into v_entry;

    return v_entry;
  end;
  $$;

-- recompute_finance_ledger_balances: the chain is the LIVE rows in seq order. A
-- deleted row keeps whatever balance it had when it was deleted — that figure
-- is part of the record of what the book said at the time, and rewriting it
-- would be inventing history for a row that is no longer in the book.
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

    select count(*) into v_rows from ledger_entries where deleted_at is null;
    select balance into v_before
      from ledger_entries where deleted_at is null order by seq desc limit 1;

    perform set_config('app.allow_balance_recompute', 'on', true);

    with running as (
      select id,
             sum(debit - credit) over (order by seq rows between unbounded preceding and current row) as bal
        from ledger_entries
       where deleted_at is null
    )
    update ledger_entries e
       set balance = r.bal
      from running r
     where e.id = r.id
       and e.balance is distinct from r.bal;

    get diagnostics v_updated = row_count;

    perform set_config('app.allow_balance_recompute', 'off', true);

    select balance into v_after
      from ledger_entries where deleted_at is null order by seq desc limit 1;

    return jsonb_build_object(
      'rows',           v_rows,
      'updated',        v_updated,
      'closingBefore',  v_before,
      'closingAfter',   v_after
    );
  end;
  $$;

revoke all on function recompute_finance_ledger_balances() from public, anon, authenticated;
grant execute on function recompute_finance_ledger_balances() to service_role;

-- finance_day_summary: the day's figures, and the opening balance carried into
-- it, over live rows only.
--
-- A reversed entry is still NOT excluded: its reversing counterpart is a real
-- row that cancels it arithmetically, and filtering the original out as well
-- would double-count the cancellation. A DELETED entry is different — nothing
-- cancels it, so it simply leaves.
create or replace function finance_day_summary(p_business_date date)
  returns table (
    opening_balance numeric,
    opening_cash    numeric,
    opening_bank    numeric,
    total_income    numeric,
    total_expenses  numeric,
    net_balance     numeric,
    cash_in_hand    numeric,
    bank_balance    numeric,
    closing_balance numeric,
    entry_count     integer
  )
  language sql stable
  as $$
    with prior as (
      select
        coalesce(sum(debit - credit), 0)                                          as bal,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)           as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)           as bank
      from ledger_entries where entry_date < p_business_date and deleted_at is null
    ),
    today as (
      select
        coalesce(sum(debit), 0)                                                    as income,
        coalesce(sum(credit), 0)                                                   as expenses,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)            as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)            as bank,
        count(*)::integer                                                          as n
      from ledger_entries where entry_date = p_business_date and deleted_at is null
    )
    select
      prior.bal,
      prior.cash,
      prior.bank,
      today.income,
      today.expenses,
      today.income - today.expenses,
      prior.cash + today.cash,
      prior.bank + today.bank,
      prior.bal + today.income - today.expenses,
      today.n
    from prior, today
  $$;

-- finance_ledger_totals: the footer under a filtered ledger view. Every filter
-- is `p is null or col = p`, matching /api/finance/ledger exactly, so the footer
-- and the rows can never describe different sets — which now includes agreeing
-- about which rows are deleted.
create or replace function finance_ledger_totals(
  p_from           date                  default null,
  p_to             date                  default null,
  p_branch_id      uuid                  default null,
  p_ledger_head_id uuid                  default null,
  p_type           ledger_head_type      default null,
  p_account        finance_account       default null,
  p_status         ledger_entry_status   default null,
  p_source_type    finance_ledger_source default null,
  p_search         text                  default null,
  p_min_amount     numeric               default null,
  p_max_amount     numeric               default null
)
  returns table (
    entry_count     bigint,
    total_debit     numeric,
    total_credit    numeric,
    opening_balance numeric
  )
  language sql stable
  as $$
    with filtered as (
      select e.debit, e.credit
      from ledger_entries e
      where e.deleted_at is null
        and (p_from           is null or e.entry_date     >= p_from)
        and (p_to             is null or e.entry_date     <= p_to)
        and (p_branch_id      is null or e.branch_id       = p_branch_id)
        and (p_ledger_head_id is null or e.ledger_head_id  = p_ledger_head_id)
        and (p_type           is null or e.ledger_head_type = p_type)
        and (p_account        is null or e.account          = p_account)
        and (p_status         is null or e.status           = p_status)
        and (p_source_type    is null or e.source_type      = p_source_type)
        and (p_min_amount     is null or greatest(e.debit, e.credit) >= p_min_amount)
        and (p_max_amount     is null or greatest(e.debit, e.credit) <= p_max_amount)
        and (
          p_search is null
          or e.voucher_no       ilike '%' || p_search || '%'
          or e.description      ilike '%' || p_search || '%'
          or e.ledger_head_name ilike '%' || p_search || '%'
          or coalesce(e.branch_name, '') ilike '%' || p_search || '%'
        )
    )
    select
      (select count(*) from filtered),
      (select coalesce(sum(debit), 0)  from filtered),
      (select coalesce(sum(credit), 0) from filtered),
      -- Everything posted strictly before the window — the balance the ledger
      -- opened at. Undefined without a `from`, in which case the book starts at 0.
      case
        when p_from is null then 0
        else coalesce((select sum(debit - credit) from ledger_entries
                        where entry_date < p_from and deleted_at is null), 0)
      end
  $$;

-- ===========================================================================
-- 6. The admin's three write paths: amend, overwrite, soft delete
-- ===========================================================================
--
-- All three are STATIC SQL per reference type and per field. No
-- `execute format('update %I set %I', …)` on values that reached us from an
-- HTTP request — migration 61 made that argument for the delete path and it
-- applies with more force here, where the field name is chosen by the caller
-- rather than derived from a closed prefix map. Verbose, and deliberately so:
-- the set of columns an admin may rewrite IS the security boundary, and it
-- should be readable as a list rather than inferred from a whitelist array
-- somewhere else.

-- ---------------------------------------------------------------------------
-- app.amend_document_ledger — keep the book in step with an amended document.
--
-- Every finance document that has been APPROVED and POSTED carries a
-- `ledger_entry_id`: a voucher in the cash book for the same money. Changing the
-- document's amount without touching that voucher produces a salary slip for
-- Rs.45,000 sitting behind a Rs.50,000 payment — the two disagree, and the
-- ledger is the one anybody audits.
--
-- So an amendment to a posted figure is not an update, it is the brief's own
-- diagram:
--
--     Original Transaction  →  Admin Amendment  →  Corrected Transaction
--
-- which is exactly what reverse_finance_ledger_entry() has done since migration
-- 52: it posts a mirror-image reversal of the original, marks the original
-- `reversed`, and then re-posts on the original's side at the corrected figure.
-- Three rows, all visible, arithmetic intact. Nothing is destroyed and the
-- running balance never needs repairing, because nothing left the chain.
--
-- Returns the two new voucher numbers so the caller can put them in the
-- amendment record and tell the admin what was posted.
-- ---------------------------------------------------------------------------
create or replace function app.amend_document_ledger(
  p_entry_id    uuid,
  p_new_amount  numeric,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text,
  p_entry_date  date
) returns jsonb
  language plpgsql
  as $$
  declare
    v_row       ledger_entries%rowtype;
    v_reversal  ledger_entries%rowtype;
    v_corrected ledger_entries%rowtype;
    v_n         integer := 0;
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;

    -- reverse_finance_ledger_entry() `return next`s the reversal first and the
    -- corrected entry second. Read in a loop with a counter rather than
    -- array_agg: aggregate order over a set-returning function is not
    -- guaranteed by anything, and getting the two the wrong way round would
    -- relink the document to its own reversal — the amendment would appear to
    -- have zeroed the document instead of correcting it.
    for v_row in
      select * from reverse_finance_ledger_entry(
        p_entry_id, p_entry_date, p_reason, p_actor_id, p_actor_name,
        round(p_new_amount, 2), null)
    loop
      v_n := v_n + 1;
      if v_n = 1 then v_reversal := v_row; else v_corrected := v_row; end if;
    end loop;

    if v_corrected.id is null then
      raise exception
        'amending voucher % produced a reversal but no corrected entry', v_reversal.voucher_no;
    end if;

    return jsonb_build_object(
      'ledgerAmended',        true,
      'reversalVoucherNo',    v_reversal.voucher_no,
      'correctedVoucherNo',   v_corrected.voucher_no,
      'correctedEntryId',     v_corrected.id
    );
  end;
  $$;

-- ---------------------------------------------------------------------------
-- amend_finance_record(reference_type, reference_id, field, new_value, …)
--
-- Backs BOTH the brief's "Amend" and its "Overwrite": they differ in what the
-- UI demands before calling — an overwrite of an approved record requires the
-- extra confirmation in §11 — and in the `action` the caller records, not in
-- what happens to the row. Collapsing them into one function is what stops the
-- two drifting apart into two subtly different definitions of "corrected".
--
-- Returns the before/after pair so the caller writes the amendment record from
-- what the database actually did, never from what the request asked for.
--
-- Derived columns are recomputed here rather than trusted from the caller:
-- `net_salary`, `total_amount` and the two income shares all have a definition,
-- and an amendment that sets a component without honouring it produces a row
-- that fails its own CHECK or, worse, one that passes and is wrong.
-- ---------------------------------------------------------------------------
create or replace function amend_finance_record(
  p_reference_type text,
  p_reference_id   uuid,
  p_field          text,
  p_new_value      text,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_entry_date     date default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_date     date := coalesce(p_entry_date, (timezone('Asia/Karachi', now()))::date);
    v_old      text;
    v_new      text := btrim(coalesce(p_new_value, ''));
    v_num      numeric;
    v_ref      text;
    v_ledger   jsonb := jsonb_build_object('ledgerAmended', false);
    v_entry    uuid;
    v_status   text;
  begin
    if p_reference_id is null then
      raise exception 'nothing to amend: the query names no finance record';
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;

    -- Numeric fields are parsed once, here, so a malformed figure fails before
    -- anything is written rather than half-way through a multi-column update.
    if p_field <> 'description' and p_field <> 'notes' then
      begin
        v_num := round(v_new::numeric, 2);
      exception when others then
        raise exception '"%" is not a valid amount for field %', p_new_value, p_field;
      end;
      if v_num < 0 then
        raise exception 'a finance amount cannot be negative (got %)', v_num;
      end if;
    end if;

    case p_reference_type

      -- -------------------------------------------------------------------
      -- ledger_entry — the book itself. There is no in-place edit here at any
      -- price: migration 52's trigger refuses one, and this function does not
      -- open the window that would let it through. An amendment IS the
      -- reversal-and-repost, which is why this branch does nothing else.
      -- -------------------------------------------------------------------
      when 'ledger_entry' then
        select voucher_no,
               case when debit > 0 then debit else credit end::text,
               status
          into v_ref, v_old, v_status
          from ledger_entries where id = p_reference_id and deleted_at is null;
        if v_ref is null then
          raise exception 'ledger entry not found, or it has already been deleted';
        end if;
        if p_field <> 'amount' then
          raise exception
            'a posted voucher may only be amended by amount. Its description, date and head '
            'are part of the entry and cannot be rewritten — post a corrected entry instead.';
        end if;
        v_ledger := app.amend_document_ledger(p_reference_id, v_num, p_reason, p_actor_id, p_actor_name, v_date);

      -- -------------------------------------------------------------------
      when 'finance_transaction' then
        select txn_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from finance_transactions where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'transaction not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text into v_old from finance_transactions where id = p_reference_id;
            update finance_transactions set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update finance_transactions
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'description' then
            select description into v_old from finance_transactions where id = p_reference_id;
            update finance_transactions set description = v_new where id = p_reference_id;
          else
            raise exception 'field "%" is not amendable on a transaction (amount, description)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- salary_payment — net_salary is gross + bonus − deductions, so a
      -- component change restates it. The ledger carries the NET.
      -- -------------------------------------------------------------------
      when 'salary_payment' then
        select salary_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from salary_payments where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'salary payment not found, or already deleted'; end if;

        case p_field
          when 'grossSalary' then
            select gross_salary::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set gross_salary = v_num, net_salary = v_num + bonus - deductions
             where id = p_reference_id;
          when 'bonus' then
            select bonus::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set bonus = v_num, net_salary = gross_salary + v_num - deductions
             where id = p_reference_id;
          when 'deductions' then
            select deductions::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set deductions = v_num, net_salary = gross_salary + bonus - v_num
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on a salary payment (grossSalary, bonus, deductions). '
              'netSalary is derived from the three and cannot be set directly.', p_field;
        end case;

        if v_status in ('posted', 'locked') then
          v_ledger := app.amend_document_ledger(
            v_entry, (select net_salary from salary_payments where id = p_reference_id),
            p_reason, p_actor_id, p_actor_name, v_date);
          update salary_payments
             set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
           where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
        end if;

      -- -------------------------------------------------------------------
      -- employee_advance — total_amount = advance + bonus + loan, enforced by
      -- employee_advances_total_matches, so every component restates it.
      -- -------------------------------------------------------------------
      when 'employee_advance' then
        select advance_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from employee_advances where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'employee advance not found, or already deleted'; end if;

        case p_field
          when 'advanceAmount' then
            select advance_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set advance_amount = v_num, total_amount = v_num + bonus_amount + loan_amount
             where id = p_reference_id;
          when 'bonusAmount' then
            select bonus_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set bonus_amount = v_num, total_amount = advance_amount + v_num + loan_amount
             where id = p_reference_id;
          when 'loanAmount' then
            select loan_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set loan_amount = v_num, total_amount = advance_amount + bonus_amount + v_num
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on an employee advance (advanceAmount, bonusAmount, loanAmount). '
              'totalAmount is their sum and is enforced by a CHECK.', p_field;
        end case;

        if v_status in ('posted', 'locked') then
          v_ledger := app.amend_document_ledger(
            v_entry, (select total_amount from employee_advances where id = p_reference_id),
            p_reason, p_actor_id, p_actor_name, v_date);
          update employee_advances
             set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
           where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
        end if;

      -- -------------------------------------------------------------------
      when 'partner_expense' then
        select expense_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from partner_expenses where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'partner expense not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text into v_old from partner_expenses where id = p_reference_id;
            update partner_expenses set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update partner_expenses
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'description' then
            select description into v_old from partner_expenses where id = p_reference_id;
            update partner_expenses set description = v_new where id = p_reference_id;
          else
            raise exception 'field "%" is not amendable on a partner expense (amount, description)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- branch_share_payment — two money columns posting to two DIFFERENT
      -- vouchers (the share and the bonus), so each amends its own.
      -- -------------------------------------------------------------------
      when 'branch_share_payment' then
        select payment_no, status::text into v_ref, v_status
          from branch_share_payments where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'branch share payment not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text, ledger_entry_id into v_old, v_entry
              from branch_share_payments where id = p_reference_id;
            update branch_share_payments set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update branch_share_payments
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'bonus' then
            select bonus::text, bonus_ledger_entry_id into v_old, v_entry
              from branch_share_payments where id = p_reference_id;
            update branch_share_payments set bonus = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update branch_share_payments
                 set bonus_ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          else
            raise exception 'field "%" is not amendable on a branch share payment (amount, bonus)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- income_approval — the one type with no `ledger_entry_id`. Approving a
      -- branch's day posts SEVERAL vouchers (the company share, the branch
      -- share) and the row keeps no handle on them, so there is nothing here to
      -- reverse-and-repost against. Amending a POSTED day would therefore
      -- restate the approval while leaving the book untouched — the exact
      -- disagreement this function exists to prevent.
      --
      -- So it is refused, with the correction that does work: amend the
      -- vouchers themselves, which the raiser can cite by their RV-/PV- numbers.
      -- -------------------------------------------------------------------
      when 'income_approval' then
        select reference_no, status::text into v_ref, v_status
          from finance_income_approvals where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'branch income record not found, or already deleted'; end if;
        -- NOT 'posted': finance_income_status has no such value. Its states are
        -- pending_verification / pending_approval / approved / rejected, and
        -- APPROVAL is the posting step — approveIncome stamps posted_at and
        -- writes the company- and branch-share vouchers in the same breath.
        -- Guarding on 'posted' here would be a condition that never fires, and
        -- an approved day would be quietly restated behind the ledger's back.
        if v_status = 'approved' then
          raise exception
            'branch income % is approved and already posted to the ledger. Its figures cannot be '
            'amended here, because the row keeps no link to the vouchers it produced — amend those '
            'vouchers directly by their RV-/PV- numbers so the book and the approval stay in step.', v_ref;
        end if;

        case p_field
          when 'totalAmount' then
            select total_amount::text into v_old from finance_income_approvals where id = p_reference_id;
            update finance_income_approvals
               set total_amount  = v_num,
                   net_amount    = v_num - branch_expenses,
                   company_share = round((v_num - branch_expenses) * company_share_pct / 100, 2),
                   branch_share  = round((v_num - branch_expenses) * branch_share_pct  / 100, 2)
             where id = p_reference_id;
          when 'branchExpenses' then
            select branch_expenses::text into v_old from finance_income_approvals where id = p_reference_id;
            update finance_income_approvals
               set branch_expenses = v_num,
                   net_amount      = total_amount - v_num,
                   company_share   = round((total_amount - v_num) * company_share_pct / 100, 2),
                   branch_share    = round((total_amount - v_num) * branch_share_pct  / 100, 2)
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on branch income (totalAmount, branchExpenses). '
              'The net and the two shares are derived from them.', p_field;
        end case;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    return jsonb_build_object(
      'referenceType',  p_reference_type,
      'referenceNo',    v_ref,
      'field',          p_field,
      'originalValue',  v_old,
      'newValue',       coalesce(v_num::text, v_new),
      -- Null when either side is not a number — a description change has no
      -- difference, and reporting 0 there would read as "nothing moved".
      'difference',     case when v_num is not null and v_old ~ '^-?[0-9]+(\.[0-9]+)?$'
                             then v_num - v_old::numeric end,
      'ledger',         v_ledger
    );
  end;
  $$;

revoke all on function amend_finance_record(text, uuid, text, text, text, uuid, text, date)
  from public, anon, authenticated;
grant execute on function amend_finance_record(text, uuid, text, text, text, uuid, text, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- soft_delete_finance_record(reference_type, reference_id, …)
--
-- The brief's §10. Replaces delete_finance_ticket_source() as the Help Desk's
-- delete path: the row is STAMPED, not removed, so an authorised admin can
-- still read it and an auditor can still see that it was there.
--
-- What that buys, concretely, over the function it replaces: migration 61 had
-- to punch a hole through the ledger's immutability trigger, null out every FK
-- pointing at the row, and then rewrite the running balance of the whole book
-- to repair the chain it had just broken. None of that happens here. The row
-- stays, its FKs stay valid, and the only thing that moves is the balance
-- chain — which still has to be recomputed, because a deleted voucher's amount
-- must stop being carried forward, but now from a row that is still there to
-- be looked at afterwards.
--
-- Deleting an already-deleted record is not an error: two admins closing the
-- same query is a race, not a mistake, and failing the second one would leave a
-- query that cannot be closed.
-- ---------------------------------------------------------------------------
create or replace function soft_delete_finance_record(
  p_reference_type text,
  p_reference_id   uuid,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_query_id       uuid,
  p_query_no       text
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ref       text;
    v_recompute jsonb;
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'the query names no finance record');
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'a deletion must carry a reason';
    end if;

    case p_reference_type

      when 'ledger_entry' then
        update ledger_entries
           set deleted_at       = now(),
               deleted_by       = p_actor_id,
               deleted_by_name  = p_actor_name,
               delete_reason    = p_reason,
               deleted_query_id = p_query_id,
               deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning voucher_no into v_ref;

        -- The chain has a hole in it the moment the stamp lands, and it is
        -- closed inside the same transaction — the book is never observable
        -- with a balance that does not add up. Same advisory lock
        -- post_finance_ledger_entry takes, and re-entrant within a transaction.
        if v_ref is not null then
          v_recompute := recompute_finance_ledger_balances();
        end if;

      when 'income_approval' then
        update finance_income_approvals
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning reference_no into v_ref;

      when 'finance_transaction' then
        update finance_transactions
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning txn_no into v_ref;

      when 'salary_payment' then
        update salary_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning salary_no into v_ref;

      when 'employee_advance' then
        update employee_advances
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning advance_no into v_ref;

      when 'partner_expense' then
        update partner_expenses
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning expense_no into v_ref;

      when 'branch_share_payment' then
        update branch_share_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning payment_no into v_ref;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already deleted, or no longer present');
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;

revoke all on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  to service_role;

-- ===========================================================================
-- 7. Notifications and attachments
-- ===========================================================================
--
-- ADD VALUE is safe here for the same reason as migrations 25 and 60: the new
-- values are not referenced within this migration, only by later runtime
-- notify() calls in their own transactions.
alter type notification_type add value if not exists 'finance_query_updated';
alter type notification_type add value if not exists 'finance_query_message';
alter type notification_type add value if not exists 'finance_query_amended';

-- Supporting documents on a query and on each reply, through the generic
-- (entity, entity_id) table from migration 67. Two entities rather than one: a
-- photo posted mid-thread belongs to the message that explains it, and
-- flattening both onto the query would lose which reply it arrived with.
alter type attachment_entity add value if not exists 'finance_ticket';
alter type attachment_entity add value if not exists 'finance_ticket_message';

-- `attachments_read` needs NO change, and that is by design rather than luck.
-- Migration 87 inverted it: finance is the DEFAULT and the three production
-- entities are the named exception, precisely so "a future finance attachment
-- site is protected the moment its enum value exists, with no policy migration
-- and no chance of forgetting one". Both values above land on
-- app.can_read_finance() the instant they exist. This is that prediction coming
-- true; do not "fix" it by adding them to a list.


-- ===========================================================================
-- 8. What is left behind, and why
-- ===========================================================================
--
-- delete_finance_ticket_source() (migrations 61/64) is NOT dropped, and is no
-- longer called by anything. It is left in place deliberately:
--
--   * dropping it would break a replay of migration 64, whose last statement
--     calls recompute_finance_ledger_balances() but whose body defines the
--     function this one supersedes; and
--   * it remains the only way to genuinely remove a row, which a DBA restoring
--     from a mistake may still need at the psql prompt.
--
-- Nothing in the API references it after this migration — the Help Desk's
-- DELETE goes through soft_delete_finance_record() above. If it is ever called
-- again, everything migration 61's header warns about applies unchanged: it
-- destroys the row, and only the fact of the deletion survives in the trail.
