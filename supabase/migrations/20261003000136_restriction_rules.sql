-- 136: Restriction Rules — admin-configured limits on branch and finance
-- operations, the approval requests that lift one of them once, and the audit
-- trail of every time a rule fired.
--
-- ─── What this is ────────────────────────────────────────────────────────────
-- Admin Settings → Restriction Rules. Seven rules, in five groups:
--
--   demand   DEMAND_PENDING_LIMIT      too many demands still waiting on review
--            BACKDATED_DEMAND          a demand dated before the business date
--            LOW_SALES_AFTER_CLOSING   too little of the day's stock sold
--   sales    HOURLY_SALES_LIMIT        sales entries per clock hour
--   cash     CASH_DEPOSIT_LIMIT        deposits per business day
--   ledger   LEDGER_BACKDATE           a finance entry older than N days
--   company  COMPANY_SHARE_INCOME      Company Share keyed as ordinary income
--
-- The API evaluates them (restriction.service.ts) inside the existing write
-- paths; nothing here is a trigger, because every rule reads configuration and
-- the clock, and a rule that refuses inside a trigger cannot explain itself to
-- the popup that has to show the reason.
--
-- ─── Text + CHECK, not enums ─────────────────────────────────────────────────
-- `supabase db push` applies pending files in one transaction and Postgres will
-- not USE an enum value added in that transaction (55P04 — see migration 118).
-- Every closed set below is therefore text with a CHECK, which also keeps a
-- future rule code a one-line change.
--
-- ADDITIVE. Three new tables and three counter rows. Nothing existing is
-- altered, and no existing row is read or rewritten.
-- ---------------------------------------------------------------------------

-- REQ-000001 / APR-000001 / RE-000001. `counters` is configuration, not data:
-- the row must exist before the first insert or app.next_finance_number raises.
insert into counters (id, count) values
  ('restriction_request', 0),
  ('restriction_approval', 0),
  ('restriction_event', 0)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- restriction_rules — one row per group, so each group saves (and shows "Saved
-- …") independently, as the settings screen does. A missing row means "use the
-- defaults in DEFAULT_RESTRICTION_RULES"; the API merges, so a key added to the
-- config later needs no backfill.
-- ---------------------------------------------------------------------------
create table if not exists restriction_rules (
  group_key        text primary key,
  config           jsonb not null default '{}'::jsonb,
  updated_by       uuid references users (id) on delete set null,
  updated_by_name  text,
  updated_at       timestamptz not null default now(),
  constraint restriction_rules_group_check
    check (group_key in ('demand', 'sales', 'cash', 'ledger', 'company'))
);

-- ---------------------------------------------------------------------------
-- restriction_requests — "let this one through", asked by a branch or a finance
-- user and decided by a Super Admin.
--
-- ONE-TIME AND BOUND. `binding_key` names exactly what the approval covers (a
-- branch and a date; or a user, a ledger head, a date and an amount). The API
-- looks an approval up by that key — never by an id or a flag the client sent —
-- and spends it with a single UPDATE … WHERE consumed_at IS NULL, so a replayed
-- request finds nothing left to spend.
-- ---------------------------------------------------------------------------
create table if not exists restriction_requests (
  id                     uuid primary key default gen_random_uuid(),
  request_no             text not null unique default app.next_finance_number('restriction_request', 'REQ'),
  type                   text not null,
  binding_key            text not null,
  -- Null for a finance request with no branch on the entry.
  branch_id              uuid references branches (id) on delete set null,
  branch_name            text,
  requested_date         date not null,
  current_business_date  date not null,
  amount                 numeric(14,2),
  description            text,
  entry_label            text,
  reason                 text not null,
  requested_by           uuid references users (id) on delete set null,
  requested_by_name      text not null,
  requested_at           timestamptz not null default now(),
  status                 text not null default 'pending',
  -- Issued when the decision is made, for approvals and rejections alike: it is
  -- the reference of the DECISION, which is what the audit log cites.
  approval_no            text unique,
  decided_by             uuid references users (id) on delete set null,
  decided_by_name        text,
  decided_at             timestamptz,
  admin_reason           text,
  consumed_at            timestamptz,
  consumed_ref           text,
  constraint restriction_requests_type_check
    check (type in ('BACKDATED_DEMAND', 'LEDGER_BACKDATE', 'COMPANY_SHARE_INCOME', 'CASH_DEPOSIT_LIMIT')),
  constraint restriction_requests_status_check
    check (status in ('pending', 'approved', 'rejected')),
  -- Each state with exactly the columns it implies. A rejection without a
  -- reason cannot exist — the branch is shown that reason.
  constraint restriction_requests_decision_check check (
    (status = 'pending'  and decided_at is null and approval_no is null) or
    (status = 'approved' and decided_at is not null and approval_no is not null) or
    (status = 'rejected' and decided_at is not null and approval_no is not null
                         and admin_reason is not null and length(btrim(admin_reason)) > 0)
  ),
  -- Only an approval can be spent.
  constraint restriction_requests_consumed_check
    check (consumed_at is null or status = 'approved')
);

create index if not exists restriction_requests_binding_idx
  on restriction_requests (type, binding_key, requested_at desc);
create index if not exists restriction_requests_status_idx
  on restriction_requests (status, requested_at desc);

-- At most one OPEN request per binding: pending, or approved and not yet used.
-- This is what makes a double-clicked "Request Admin Approval" one request.
create unique index if not exists restriction_requests_open_idx
  on restriction_requests (type, binding_key)
  where status = 'pending' or (status = 'approved' and consumed_at is null);

-- ---------------------------------------------------------------------------
-- decide_restriction_request — the admin's decision, in one statement.
--
-- A function rather than an UPDATE from the API because the APR- number has to
-- be issued in the same statement that flips the status: issued first, a lost
-- race would burn a number; issued after, an approved row could exist without
-- one. Returns NO ROW when the request is not pending (already decided, or not
-- found) — the API turns that into a 409 — instead of raising, so the second of
-- two admins clicking at once gets a plain answer.
-- ---------------------------------------------------------------------------
create or replace function decide_restriction_request(
  p_id          uuid,
  p_decision    text,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text
) returns setof restriction_requests
  language sql
  as $$
    update restriction_requests
       set status          = p_decision,
           approval_no     = app.next_finance_number('restriction_approval', 'APR'),
           decided_by      = p_actor_id,
           decided_by_name = p_actor_name,
           decided_at      = now(),
           admin_reason    = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_id
       and status = 'pending'
       and p_decision in ('approved', 'rejected')
    returning *;
  $$;

revoke all on function decide_restriction_request(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function decide_restriction_request(uuid, text, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- restriction_events — the audit trail. One row each time a rule warned,
-- blocked, was asked to be lifted, was decided, or was reconfigured.
-- Append-only: no update, no delete, enforced by the trigger below.
-- ---------------------------------------------------------------------------
create table if not exists restriction_events (
  id             uuid primary key default gen_random_uuid(),
  event_no       text not null unique default app.next_finance_number('restriction_event', 'RE'),
  rule_code      text not null,
  branch_id      uuid references branches (id) on delete set null,
  branch_name    text,
  user_id        uuid references users (id) on delete set null,
  user_name      text,
  -- The transaction or request the event is about: DMD-, MB-, CT-, FTX-, REQ-.
  ref            text,
  current_value  text,
  threshold      text,
  action         text not null,
  result         text not null,
  approval_no    text,
  created_at     timestamptz not null default now()
);

create index if not exists restriction_events_created_idx on restriction_events (created_at desc);
create index if not exists restriction_events_rule_idx on restriction_events (rule_code, created_at desc);

create or replace function app.restriction_events_no_change() returns trigger
  language plpgsql as $$
  begin
    raise exception 'restriction_events is append-only';
  end;
  $$;

drop trigger if exists restriction_events_no_change on restriction_events;
create trigger restriction_events_no_change before update or delete on restriction_events
  for each row execute function app.restriction_events_no_change();

comment on table restriction_rules is
  'Admin Settings → Restriction Rules. One jsonb config per group; merged over DEFAULT_RESTRICTION_RULES by the API.';
comment on table restriction_requests is
  'One-time Admin approval requests that lift a restriction for one bound transaction. Spent by UPDATE … WHERE consumed_at IS NULL.';
comment on table restriction_events is
  'Append-only audit of restriction rules firing, being requested, decided and reconfigured.';

-- RLS on with NO policies: these tables are reached only by the API on the
-- service-role key, which re-decides every request in application code. A
-- branch user must not be able to read the rules, another branch's requests or
-- the audit trail with a direct client query — and with no policy, nothing is
-- readable that way at all.
alter table restriction_rules    enable row level security;
alter table restriction_requests enable row level security;
alter table restriction_events   enable row level security;
