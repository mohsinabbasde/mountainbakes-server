-- 87: employee advances — money handed to an employee between payslips.
--
-- ONE FILE ON PURPOSE, INCLUDING THE TWO `alter type … add value`.
-- The instinct (and migrations 51/52, and 86/87 before it was withdrawn) is to
-- split an enum value away from the code that uses it. That does not help:
-- `supabase db push` wraps EVERY PENDING MIGRATION in ONE transaction, not one
-- per file, so two files pushed together are still one transaction and Postgres
-- still refuses to USE a value declared in it (55P04, whole push rolls back).
-- See DEPLOY.md.
--
-- The way out is not to split, but to NOT USE the new values here at all:
--   * `finance_ledger_source.employee_advance` is only ever named by the running
--     app, in a later transaction — see approveEmployeeAdvance().
--   * `attachment_entity.employee_advance` would have been named by the
--     attachments_read policy, so that policy is inverted below to name the
--     operational entities instead. It then needs no new value.
-- Nothing in this file reads a value this file declares, so it applies clean.

-- The photo of the cash handover. Falls in the finance half of
-- attachments_read's CASE — the inverted policy below puts it there.
alter type attachment_entity add value if not exists 'employee_advance';

-- An approved advance posts one expense entry under EXP-SALARIES, exactly as a
-- payslip does. It gets its own source value rather than reusing 'salary' so the
-- General Ledger can tell "money handed over mid-month" from "the payslip", and
-- so the entry can be followed back to the right table.
alter type finance_ledger_source add value if not exists 'employee_advance';

-- ADV-000001, ADV-000002, … `counters` is configuration, not data: the row must
-- exist before the first insert or app.next_finance_number raises (see 52).
insert into counters (id, count) values ('finance_advance', 0)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- employee_advances
--
-- WHAT THIS IS
-- An advance is a real payment: cash or a transfer leaves the business on
-- `business_date`, against a photo of the handover, and it posts to the ledger
-- under EXP-SALARIES the moment it is approved. It walks the same lifecycle as
-- every other finance document — draft → pending_approval → approved → posted →
-- locked, or rejected — so it reuses approveDocument()/rejectDocument() rather
-- than growing a second approval path.
--
-- WHY THREE AMOUNT COLUMNS AND NOT A `kind` ENUM
-- One handover routinely mixes them: 3,000 against this month's salary, a 2,000
-- Eid bonus and a 2,000 loan, counted out together and signed for once. Modelling
-- that as three rows would mean three photos of the same handover, three approval
-- decisions for one act, and a Previous Payment figure that has to re-group them
-- to be legible. They are stored as three columns of one document because they
-- ARE one document; `total_amount` is what moved, and the CHECK below is what
-- keeps the parts and the whole from drifting.
--
-- HOW IT REACHES THE PAYSLIP
-- The whole `total_amount` was already handed over, so the whole of it is
-- deducted from the next payslip — including the bonus. The payslip separately
-- ADDS `bonus_amount` back as its Bonus figure, which is what makes the bonus
-- visible on the payslip as earnings without paying it a second time:
--
--     advance 3,000 + bonus 2,000 + loan 2,000  → ledger 7,000 on 12 Aug
--     payslip 30,000 + bonus 2,000 − deduct 7,000 → ledger 25,000 on 31 Aug
--     total payroll cost 32,000 = 30,000 salary + 2,000 bonus            ✓
--
-- `recovered_by_salary_id` is the link, claimed when the payslip is CREATED
-- rather than when it posts. A payslip sitting in the approval queue has already
-- promised to recover these advances; leaving them unclaimed until approval
-- would let the next month's payslip prefill the same 7,000 and deduct it twice.
--
-- A claim by a payslip that ends up REJECTED does not count — see the
-- `outstanding` predicate in finance-payroll.service.ts. That is what lets a
-- rejected payslip be replaced (the partial unique index on salary_payments
-- exempts rejected rows) without stranding the advances it had claimed.
-- ---------------------------------------------------------------------------
create table employee_advances (
  id                     uuid primary key default gen_random_uuid(),
  advance_no             text not null unique default app.next_finance_number('finance_advance', 'ADV'),
  employee_id            uuid not null references finance_employees (id) on delete restrict,
  -- Snapshots, for the same reason salary_payments carries them: a promotion
  -- next year must not restate what this document said when it was signed.
  employee_name          text not null,
  department             text not null,
  designation            text not null,
  business_date          date not null,
  -- Against this month's salary. Recovered in full from the next payslip.
  advance_amount         numeric(14,2) not null default 0 check (advance_amount >= 0),
  -- A bonus, paid early. Recovered like the rest (the cash is gone) but added
  -- back as the payslip's Bonus, so it nets to nothing and still shows.
  bonus_amount           numeric(14,2) not null default 0 check (bonus_amount >= 0),
  -- A loan. Identical mechanics to an advance today; the separate column is what
  -- makes "how much of this is lending?" answerable without reading the notes.
  loan_amount            numeric(14,2) not null default 0 check (loan_amount >= 0),
  -- What actually left the till. > 0, because a zero-value document posts a row
  -- that moves nothing and pads the audit trail (see finance.schemas.ts).
  total_amount           numeric(14,2) not null check (total_amount > 0),
  constraint employee_advances_total_matches
    check (total_amount = advance_amount + bonus_amount + loan_amount),
  payment_method         text not null,
  account                finance_account not null,
  status                 finance_doc_status not null default 'pending_approval',
  notes                  text,
  -- The payslip that recovers this advance. Null until one claims it.
  recovered_by_salary_id uuid references salary_payments (id) on delete set null,
  -- Stamped when that payslip is approved and posts — the point at which the
  -- recovery actually happened rather than was merely intended.
  recovered_at           timestamptz,
  created_by             uuid references users (id) on delete set null,
  created_by_name        text,
  approved_by            uuid references users (id) on delete set null,
  approved_by_name       text,
  approved_at            timestamptz,
  rejection_reason       text,
  ledger_entry_id        uuid references ledger_entries (id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- One payslip may recover several advances, so this is not unique — but an
-- advance may only ever be claimed by one, which the service enforces with a
-- conditional update rather than a constraint (a rejected claimer has to be
-- re-claimable, and no index can express "unless that row is rejected").
create index employee_advances_salary_idx   on employee_advances (recovered_by_salary_id)
  where recovered_by_salary_id is not null;

create index employee_advances_employee_idx on employee_advances (employee_id, business_date desc);
create index employee_advances_status_idx   on employee_advances (status, business_date desc);

-- The Previous Payment lookup's working set: what this employee still owes.
create index employee_advances_outstanding_idx on employee_advances (employee_id)
  where status in ('posted', 'locked') and recovered_by_salary_id is null;

create trigger employee_advances_touch before update on employee_advances
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. As everywhere else in this schema, the app reaches this table on the
-- service-role key and bypasses these policies entirely — they exist so a leaked
-- anon key cannot enumerate payroll, not as the authorization model. That is
-- requireFinance() in the route handlers.
-- ---------------------------------------------------------------------------
alter table employee_advances enable row level security;

-- Matched to salary_payments_read (migration 52), including its caveat: payroll
-- is the one table where "everyone in finance" is worth questioning, and a
-- future tightening should move both together.
create policy employee_advances_read on employee_advances
  for select to authenticated using (app.can_read_finance());

-- ---------------------------------------------------------------------------
-- The handover photo is finance evidence, so it must read as finance-only.
--
-- INVERTED rather than extended, and that is the whole point. Migration 67 wrote
-- this as "if the entity is one of these five finance ones, require finance;
-- otherwise anyone signed in" — which meant naming `employee_advance` here to
-- protect it. Naming it is exactly what `db push` cannot do: this file declares
-- that enum value a few lines up, the CLI wraps EVERY pending migration in ONE
-- transaction, and Postgres refuses to use a value the same transaction declared
-- (55P04, and the push rolls back whole). See the note in DEPLOY.md.
--
-- So the list flips to the OPERATIONAL entities, all of which were committed by
-- migrations 67 and 69. Same answer for all nine values that exist today; the
-- difference is what happens to the tenth. Finance is now the default, so a
-- future finance attachment site is protected the moment its enum value exists,
-- with no policy migration and no chance of forgetting one — and it fails closed
-- (too strict) rather than open, which is the right direction for a table whose
-- rows are photographs of money changing hands.
-- ---------------------------------------------------------------------------
drop policy attachments_read on attachments;

create policy attachments_read on attachments
  for select to authenticated
  using (
    case
      when entity in ('production_order_demand', 'production_order_verification',
                      'production_order_special_item')
        then true
      else app.can_read_finance()
    end
  );

-- ---------------------------------------------------------------------------
-- The Help Desk can now be pointed at an ADV- number.
--
-- FINANCE_TICKET_REFERENCES (shared/types/finance.types.ts) gained an
-- `employee_advance` entry, which is what makes the raiser's reference-number
-- box resolve ADV-000001 to this table. That map and this CHECK have to move
-- together: resolving a number the constraint then refuses turns a valid ticket
-- into a 23514 at insert, and only after the raiser has typed the whole query.
-- ---------------------------------------------------------------------------
alter table finance_tickets drop constraint finance_tickets_reference_type_check;

alter table finance_tickets add constraint finance_tickets_reference_type_check
  check (reference_type in (
    'ledger_entry', 'income_approval', 'finance_transaction',
    'salary_payment', 'employee_advance', 'partner_expense', 'branch_share_payment'
  ));
