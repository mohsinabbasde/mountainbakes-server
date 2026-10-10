-- 66: the branch manager → Admin queue for opening a shift account, and the
-- `shift` label those accounts carry.
--
-- Depends on migration 65 having COMMITTED: the check constraint at the bottom
-- names 'branch_user', and a new enum value cannot be used in the transaction
-- that added it. That is why 65 exists as a file of its own.
--
-- WHY A TABLE RATHER THAN A SUPPORT TICKET. The Help Desk model is built around
-- one existing record — a sale, a demand, an expense, a stock row — whose
-- figures are snapshotted onto the ticket so an admin sees what the raiser saw
-- and can correct them in place. A request for an account that does not exist
-- yet has no reference to snapshot and nothing to correct; it has a decision
-- attached to it instead, and an outcome (a created user id) that a ticket has
-- nowhere to put.
--
-- RLS is enabled with NO policies, the same stance as finance_tickets: the
-- service-role API is the only reader, and it bypasses RLS. Authorization for
-- this queue is application code — a manager sees their own branch's requests,
-- an admin sees all — not a policy predicate.

-- ---------------------------------------------------------------------------
-- Shift is a LABEL. It is recorded, displayed and audited, and it gates nothing:
-- sign-in and every write behave identically at any hour. Staff swap and extend
-- shifts constantly, and an account that locks its holder out mid-cover is a
-- worse failure than a row carrying the wrong word.
-- ---------------------------------------------------------------------------
create type branch_shift as enum ('morning', 'evening');

create type branch_user_request_status as enum ('pending', 'approved', 'rejected');

-- BUR-######, from the same shared `counters` table every other entity number
-- uses. Seeded at 0 so the first request is BUR-000001.
insert into counters (id, count) values ('branch_user_request', 0) on conflict (id) do nothing;

create or replace function next_branch_user_request_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'branch_user_request' returning count into next_count;
    if not found then raise exception 'counters row "branch_user_request" is missing'; end if;
    return 'BUR-' || lpad(next_count::text, 6, '0');
  end;
  $$;

create table branch_user_requests (
  id                uuid primary key default gen_random_uuid(),
  request_no        text not null unique default next_branch_user_request_number(),

  -- Taken from the requesting manager's JWT, never from the submitted form: a
  -- manager may only ever open an account on their own branch. `branch_name` is
  -- a denormalised cache of branches.name, as everywhere else in this schema.
  branch_id         uuid not null references branches (id) on delete cascade,
  branch_name       text not null,
  requested_by      uuid references users (id) on delete set null,
  requested_by_name text not null,

  -- The account to be. No password column, deliberately: the admin sets it at
  -- approval, so a credential never sits at rest in a queue waiting to be read.
  display_name      text not null,
  email             text not null,
  phone             text not null default '',
  shift             branch_shift not null,
  note              text not null default '',

  status            branch_user_request_status not null default 'pending',

  reviewed_by       uuid references users (id) on delete set null,
  reviewed_by_name  text,
  reviewed_at       timestamptz,
  rejection_reason  text,
  -- The account this request produced. ON DELETE SET NULL rather than cascade:
  -- deleting the user must not erase the record that it was asked for.
  created_user_id   uuid references users (id) on delete set null,

  created_at        timestamptz not null default now(),

  -- A decision must carry its evidence. Approved means an account exists;
  -- rejected means a reason was given. Enforced here because the alternative is
  -- a queue that can hold a "rejected" row nobody can explain.
  constraint branch_user_requests_decided_ck check (
    (status = 'pending'  and reviewed_at is null and created_user_id is null and rejection_reason is null)
    or (status = 'approved' and reviewed_at is not null and created_user_id is not null)
    or (status = 'rejected' and reviewed_at is not null and rejection_reason is not null)
  )
);

create index branch_user_requests_branch_idx on branch_user_requests (branch_id, created_at desc);
create index branch_user_requests_status_idx on branch_user_requests (status, created_at desc);

-- One live request per email at a time. Without it a manager clicking twice
-- queues two requests and an admin approves both, the second failing deep inside
-- Supabase Auth on the duplicate address rather than here.
create unique index branch_user_requests_pending_email_idx
  on branch_user_requests (lower(email)) where status = 'pending';

alter table branch_user_requests enable row level security;

-- ---------------------------------------------------------------------------
-- The shift label on the account itself, so a user list can show who works when
-- without joining back to the request that created them (and still show it after
-- that request is gone).
--
-- The constraint is what needs migration 65 committed: shift is meaningless on a
-- manager, an admin or an accountant, and left unconstrained it would drift into
-- one of them and start rendering in lists that have no shift concept.
-- ---------------------------------------------------------------------------
alter table users add column if not exists shift branch_shift;

alter table users drop constraint if exists users_shift_only_for_branch_user;
alter table users add constraint users_shift_only_for_branch_user
  check (shift is null or role = 'branch_user');
