-- ---------------------------------------------------------------------------
-- Company Transaction Details — partner advances/draws against a fixed 25%
-- ownership split, and branch share payouts.
--
-- New enum values first, in their own statements before anything references
-- them: Postgres will not let a value added to an enum be USED inside the
-- same transaction that added it.
-- ---------------------------------------------------------------------------
alter type finance_ledger_source add value if not exists 'branch_share_payout';
alter type finance_ledger_source add value if not exists 'branch_share_bonus';

-- ---------------------------------------------------------------------------
-- finance_partners — the fixed ownership list. Four partners, 25% each,
-- named rows rather than free text so a form can offer a dropdown and a
-- report can key off a stable id instead of however "Mohsin" got typed that
-- day. (The pre-existing partner_expenses rows used free-text partner_name —
-- see the backfill below.)
-- ---------------------------------------------------------------------------
-- Profile fields (father_name onward) are nullable and start empty: the four
-- rows below are seeded with just a name and share, and get filled in later
-- through the "Add Partner Detail" form — there is no reliable source to
-- backfill birth dates or addresses from.
create table finance_partners (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  father_name        text,
  date_of_birth      date,
  joined_on          date,
  partner_type       text check (partner_type in ('founder', 'co_founder')),
  address            text,
  contact_number     text,
  emergency_number   text,
  share_pct          numeric(5,2) not null default 25 check (share_pct > 0 and share_pct <= 100),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger finance_partners_touch before update on finance_partners
  for each row execute function app.touch_updated_at();

insert into finance_partners (name, share_pct) values
  ('Mohsin Abbas', 25),
  ('Muhammad Saleem', 25),
  ('Muhammad Shahid', 25),
  ('Salqlain Hussain', 25);

-- ---------------------------------------------------------------------------
-- partner_expenses gains a partner_id (nullable — the three rows that predate
-- this table have no reliable match) and a txn_kind: an ADVANCE is money lent
-- against a partner's future share and must be deducted later; a DRAW is a
-- partner withdrawing money they are already entitled to from the current
-- grand total. Both reduce the "balance remaining" the summary report shows,
-- but they are tracked separately because the report shows them separately.
-- ---------------------------------------------------------------------------
alter table partner_expenses
  add column partner_id uuid references finance_partners (id) on delete restrict,
  add column txn_kind   text not null default 'draw' check (txn_kind in ('advance', 'draw'));

-- Best-effort backfill: the three historical rows used inconsistent casing/
-- spacing ("mohsin ", "Saleem", "Shahid "), but each matches exactly one of
-- the four seeded partners. Left unmatched (partner_id stays null) rather
-- than guessed at.
update partner_expenses set partner_id = (select id from finance_partners where name = 'Mohsin Abbas')
  where partner_id is null and trim(lower(partner_name)) = 'mohsin';
update partner_expenses set partner_id = (select id from finance_partners where name = 'Muhammad Saleem')
  where partner_id is null and trim(lower(partner_name)) = 'saleem';
update partner_expenses set partner_id = (select id from finance_partners where name = 'Muhammad Shahid')
  where partner_id is null and trim(lower(partner_name)) = 'shahid';

-- ---------------------------------------------------------------------------
-- branch_share_payments — actually paying a branch its already-recorded 25%
-- share. Branch income approval (finance-income.service.ts) posts the
-- company share AND the branch share as ledger entries the moment a day is
-- approved, but that only RECORDS the branch's share — nothing pays it out.
-- This table is that payout. `bonus` is a separate optional amount that,
-- when present, posts to Production Expenses instead of the share-payout
-- head, with a note naming the branch — see approveBranchSharePayment.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values ('finance_branch_share', 0) on conflict (id) do nothing;

create table branch_share_payments (
  id                     uuid primary key default gen_random_uuid(),
  payment_no             text not null unique default app.next_finance_number('finance_branch_share', 'BSP'),
  branch_id              uuid not null references branches (id) on delete restrict,
  branch_name            text not null,
  amount                 numeric(14,2) not null default 0 check (amount >= 0),
  bonus                  numeric(14,2) not null default 0 check (bonus >= 0),
  business_date          date not null,
  payment_method         text not null,
  account                finance_account not null,
  status                 finance_doc_status not null default 'pending_approval',
  notes                  text,
  requested_by           uuid references users (id) on delete set null,
  requested_by_name      text not null default '',
  approved_by            uuid references users (id) on delete set null,
  approved_by_name       text,
  approved_at            timestamptz,
  rejection_reason       text,
  ledger_entry_id        uuid references ledger_entries (id) on delete restrict,
  bonus_ledger_entry_id  uuid references ledger_entries (id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint branch_share_payment_has_amount check (amount > 0 or bonus > 0)
);

create index branch_share_payments_branch_idx on branch_share_payments (branch_id, business_date desc);
create index branch_share_payments_status_idx on branch_share_payments (status, created_at desc);

create trigger branch_share_payments_touch before update on branch_share_payments
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- New system ledger head for the base branch-share payout. The bonus reuses
-- the existing EXP-PRODUCTION head (flipped to is_system so it can no longer
-- be deactivated out from under the posting code that now depends on it).
-- ---------------------------------------------------------------------------
insert into ledger_heads (code, name, type, group_name, is_system, sort_order) values
  ('EXP-BRANCH-SHARE-PAYOUT', 'Branch Share Payout', 'expense', 'Partners', true, 25)
on conflict (code) do nothing;

update ledger_heads set is_system = true where code = 'EXP-PRODUCTION';

-- ---------------------------------------------------------------------------
-- RLS — same read-only-for-everyone-but-the-API posture as the rest of the
-- module. No insert/update/delete policy; every write goes through the API.
-- ---------------------------------------------------------------------------
alter table finance_partners       enable row level security;
alter table branch_share_payments  enable row level security;

create policy finance_partners_read on finance_partners
  for select to authenticated using (app.can_read_finance());

create policy branch_share_payments_read on branch_share_payments
  for select to authenticated using (app.can_read_finance());
