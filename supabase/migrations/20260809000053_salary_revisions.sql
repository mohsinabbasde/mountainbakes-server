-- ---------------------------------------------------------------------------
-- salary_revisions — effective-dated base-salary changes on the payroll master.
--
-- finance_employees.base_salary was a plain column overwritten in place: a
-- raise had no reason, no record of what it used to be, and no way to say
-- "implement this on 1st of next month" rather than right now. This table
-- fixes that by recording each change as its own row instead of mutating the
-- old value away.
--
-- It does NOT retroactively touch anything: salary_payments snapshots
-- gross_salary at the moment a payslip is created and never re-reads the
-- employee master, so a revision here — whatever its effective_from — can
-- never restate a payslip that already exists. The app layer resolves
-- "today's" base salary by picking the latest row here with
-- effective_from <= the current business date, falling back to
-- finance_employees.base_salary for an employee with no revisions yet.
--
-- Modelled on finance_audit_logs' append-only trigger: correcting a mistaken
-- revision means recording another one, not editing this one. Same "the trail
-- is the truth" rule the ledger and the audit log already follow.
-- ---------------------------------------------------------------------------
create table salary_revisions (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references finance_employees (id) on delete cascade,
  employee_name    text not null,
  previous_salary  numeric(14,2) not null,
  new_salary       numeric(14,2) not null check (new_salary >= 0),
  reason           text not null,
  effective_from   date not null,
  changed_by       uuid references users (id) on delete set null,
  changed_by_name  text not null default '',
  created_at       timestamptz not null default now()
);

create index salary_revisions_employee_idx on salary_revisions (employee_id, effective_from desc);

create or replace function app.salary_revisions_immutable() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'salary_revisions is append-only (% attempted)', tg_op;
  end;
  $$;

create trigger salary_revisions_no_change
  before update or delete on salary_revisions
  for each row execute function app.salary_revisions_immutable();

-- Same read-only-for-everyone-but-the-API posture as the rest of the module —
-- see the big comment above the other finance RLS policies in
-- 20260805000052_finance_ledger.sql. No insert/update/delete policy exists;
-- every write goes through the API.
alter table salary_revisions enable row level security;

create policy salary_revisions_read on salary_revisions
  for select to authenticated using (app.can_read_finance());
