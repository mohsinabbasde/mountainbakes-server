-- ---------------------------------------------------------------------------
-- production_expenses — final contents before the table was dropped
--
-- Exported 2026-08-12 from project wzjabtuoxrvyareptddq, immediately before
-- migration 20260812000063 dropped the table. Three rows, PKR 11,490.00 total.
-- This file is the only remaining record of them.
--
-- EXP-000011 reads like a test row ("ffg"). EXP-000016 and EXP-000017 are real
-- purchases entered on 2026-08-11 and are the reason this export exists.
--
-- To restore, run this file against the database. It recreates the table as it
-- stood at the drop — the shape from migration 20260719000003 plus the
-- `expense_number` column added by 20260723000024 — then reinserts the rows with
-- their original ids, numbers and timestamps.
--
-- Two things it deliberately does NOT restore, because they belong to the
-- surrounding schema rather than to this table:
--   · the `production_expense_payment_method` enum, which the drop leaves in
--     place (nothing else uses it, so it may since have been removed);
--   · the RLS policies from 20260719000009, which went with the table.
-- Restoring for a one-off read does not need either; putting the feature back
-- would mean reverting the code removal as well.
--
-- The shared EXP-###### counter is unaffected either way: 20260802000046 seeded
-- it into `counters` once, and it has not read from this table since.
-- ---------------------------------------------------------------------------

create table if not exists production_expenses (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  category        text not null,
  description     text,
  amount          numeric(14,2) not null,
  payment_method  production_expense_payment_method not null,
  supplier        text,
  notes           text,
  business_date   date not null,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  expense_number  text not null unique
);

create index if not exists production_expenses_date_idx    on production_expenses (business_date desc);
create index if not exists production_expenses_created_idx on production_expenses (created_at);

-- `created_by` is left as the original uuid. If that user has since been
-- deleted the insert will fail on the foreign key; null it out to load anyway.
insert into production_expenses
  (id, legacy_id, category, description, amount, payment_method, supplier, notes,
   business_date, created_by, created_by_name, created_at, expense_number)
values
  ('e910fa7d-9da4-477a-ac16-304b5c244cd2', null, 'Maintenance', 'ffg', 300.00,
   'cash', '', '', '2026-08-03', '612b8f84-9543-4a46-b511-50def8c04288',
   'production@mountainbakes.com', '2026-08-03T19:49:18.448452+00:00', 'EXP-000011'),

  ('64849cbb-57cb-445e-a148-f06a0e3ffc10', null, 'Ingredients', 'Moca, pineapple ', 8640.00,
   'cash', 'Waseem and sons ', '', '2026-08-11', '612b8f84-9543-4a46-b511-50def8c04288',
   'production@mountainbakes.com', '2026-08-11T17:15:00.889504+00:00', 'EXP-000016'),

  ('6fa7337c-92c1-4bed-87bb-cb2ef577f132', null, 'Ingredients', 'Lotus biscuit 3 pkt ', 2550.00,
   'cash', 'Saleem and son', '', '2026-08-11', '612b8f84-9543-4a46-b511-50def8c04288',
   'production@mountainbakes.com', '2026-08-11T17:16:04.161689+00:00', 'EXP-000017');
