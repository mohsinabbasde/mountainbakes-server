-- 60: Finance Help Desk — the finance-only query queue.
--
-- An Accountant or Finance Manager raises a query against a finance record (a
-- voucher FV-######, an income approval INC-######, a salary SAL-######, a
-- partner expense PEX-######, a transaction FTX-###### or a branch share
-- BSP-######). The query, plus a snapshot of that record's figures at submit
-- time, lands here. A Finance Admin resolves, rejects, edits or deletes it.
--
-- Deliberately NOT support_tickets. The finance module is a separate product
-- surface with its own roles and its own trail (see migration 51/52); folding
-- finance queries into the admin Support Center would put them in a queue
-- super_admin already fully controls, which is exactly the separation the
-- module exists to keep. Branch and production never see this table.
--
-- API-owned table (migration 09's taxonomy): RLS enabled with NO policy, so the
-- service-role API is the only reader/writer. Authorization is in app code —
-- requireFinance(...) in src/routes/finance-tickets.routes.ts.

-- ---------------------------------------------------------------------------
-- Ticket numbers: FQ-000001, from the same gapless counter row every other
-- finance document uses. `counters` is configuration, not data — migration 46
-- restores these rows, and next_finance_number() raises if one is missing.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values ('finance_ticket', 0) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- finance_tickets
-- ---------------------------------------------------------------------------
create table finance_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_no          text not null unique default app.next_finance_number('finance_ticket', 'FQ'),

  -- Which finance record the query is about. `reference_no` is the human handle
  -- and is what the raiser types; `reference_id` is the row it resolved to at
  -- submit time. The id is nullable and ON DELETE SET NULL is deliberately NOT
  -- used — there is no FK, because the reference spans six different tables and
  -- a polymorphic FK cannot be expressed. The snapshot is what makes the ticket
  -- readable even if the underlying row is later reversed or removed.
  reference_type     text not null,
  reference_id       uuid,
  reference_no       text not null,
  reference_snapshot jsonb,

  subject            text not null,
  message            text not null,

  status             text not null default 'open',   -- 'open' | 'resolved' | 'rejected'
  resolution_note    text,

  raised_by          uuid references users (id) on delete set null,
  raised_by_name     text not null default '',
  raised_by_role     text,

  resolved_by        uuid references users (id) on delete set null,
  resolved_by_name   text,
  resolved_at        timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint finance_tickets_status_check
    check (status in ('open', 'resolved', 'rejected')),
  constraint finance_tickets_reference_type_check
    check (reference_type in (
      'ledger_entry', 'income_approval', 'finance_transaction',
      'salary_payment', 'partner_expense', 'branch_share_payment'
    )),
  -- A resolved or rejected ticket must say who closed it and when. Open tickets
  -- must not carry a resolver: that combination would make the queue lie.
  constraint finance_tickets_resolution_check
    check (
      (status = 'open'  and resolved_by is null and resolved_at is null)
      or
      (status <> 'open' and resolved_at is not null)
    )
);

-- The Help Desk reads the open queue newest-first; a raiser reads their own.
create index finance_tickets_status_idx    on finance_tickets (status, created_at desc);
create index finance_tickets_raised_idx    on finance_tickets (raised_by, created_at desc);
create index finance_tickets_reference_idx on finance_tickets (reference_type, reference_no);

create trigger finance_tickets_touch before update on finance_tickets
  for each row execute function app.touch_updated_at();

alter table finance_tickets enable row level security;

-- ---------------------------------------------------------------------------
-- Notification types for the Finance Help Desk round-trip.
--
-- Unlike the ledger, a ticket is NOT append-only: the brief asks for a Finance
-- Admin who can edit and delete, and a deleted ticket is permanently gone from
-- this table. The route records each of those writes in finance_audit_logs,
-- which IS append-only — but a deletion is logged as the FACT alone (which
-- ticket, by whom, when), never its text. Deleting a query destroys the query.
--
-- ADD VALUE is safe here for the same reason as migration 25: the new values
-- are not referenced within this migration, only by later runtime notify()
-- calls in their own transactions.
-- ---------------------------------------------------------------------------
alter type notification_type add value if not exists 'finance_query';
alter type notification_type add value if not exists 'finance_query_resolved';
