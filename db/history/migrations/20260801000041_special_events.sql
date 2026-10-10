-- 41: Special Events — advance planning for high-demand occasions.
--
-- The bakery's revenue is not flat. Ramadan, both Eids, Independence Day and
-- Valentine's are multiples of a normal week, and the lead time that matters is
-- weeks, not the next morning. The existing production_orders flow (migration 05)
-- is a DAILY demand pipeline scoped to a business_date — it is the right tool for
-- tomorrow's bread and the wrong one for "Production must start buying Eid
-- packaging 21 days out". This module is that second pipeline, and it deliberately
-- does not touch the daily one.
--
-- ─── One row per OCCURRENCE, not per template ────────────────────────────────
-- The single most important shape decision here. A recurring event could have been
-- one row whose date is mutated each year; it is not, because that destroys last
-- year's confirmed date, last year's branch demands and last year's outcome —
-- exactly the data the year-over-year comparison exists to read. Occurrences of one
-- recurring event share `series_code` and are unique on (series_code, event_year).
-- Rolling forward CREATES next year's row; it never edits this year's.
--
-- ─── Why estimated_date is a stored column ───────────────────────────────────
-- Islamic events are anchored to a Hijri month/day, not a Gregorian date. The
-- Gregorian estimate is computed in TypeScript (shared/utils/hijri.ts, using the
-- built-in Intl 'islamic-umalqura' calendar — no dependency) and WRITTEN here,
-- because Postgres cannot call that helper and because every screen filters or
-- sorts on the resolved date. A computed-on-read value cannot be indexed.
--
-- Umm al-Qura is calculated; Pakistan's Ruet-e-Hilal committee can differ by a day
-- or two. Hence two columns: `estimated_date` (machine, refreshable) and
-- `confirmed_date` (admin override). `event_date` generates from
-- coalesce(confirmed, estimated) so the override always wins and every query has
-- one indexable column to work with.
--
-- ─── What is deliberately NOT here ───────────────────────────────────────────
-- No raw_materials table and no recipe/BOM. Neither exists in this schema, and
-- inventing them to satisfy a "Raw Materials Ready" progress bar would be a much
-- larger module wearing this one's name. Production readiness is four MANUAL
-- percentage stages (event_production_status) that a production user maintains.
-- Packing-material demand lines are a deliberate follow-up: the sibling table
-- would mirror migration 39 exactly and hangs off event_branch_demands.

-- ---------------------------------------------------------------------------
-- Enums. Fixed, load-bearing domains only. `event_type`, `color` and
-- `series_code` stay plain text on purpose — the same rule migration 29 states
-- for expenses.category: a vocabulary expected to churn lives in the app so it
-- can change without a migration and without invalidating historical rows.
-- ---------------------------------------------------------------------------
create type event_category              as enum ('islamic', 'national', 'international', 'company');
create type event_calendar_system       as enum ('gregorian', 'hijri', 'gregorian_nth_weekday');
create type event_status                as enum ('upcoming', 'active', 'completed', 'cancelled');
create type event_priority              as enum ('low', 'normal', 'high', 'critical');
create type event_demand_status         as enum ('draft', 'submitted', 'approved', 'rejected', 'fulfilled');
create type event_production_stage      as enum ('raw_materials', 'packing_materials', 'finished_products', 'staff_assigned');
create type event_notification_audience as enum ('branch', 'production', 'admin');
create type event_reminder_kind         as enum ('event_countdown', 'demand_due', 'preparation_start');
create type event_notification_status   as enum ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled');

-- ---------------------------------------------------------------------------
-- EVT- counter. Same pattern and same reasoning as MB-/EXP-/DMD-/PRC-/STK-/SUP-
-- (migrations 03, 24, 25): a sequence would leave gaps on rollback, and the
-- counter-row UPDATE ... RETURNING is atomic under row locking.
--
-- This block MUST precede the table create — the column default calls the
-- function, so the function has to exist first, and the counters row has to exist
-- or every insert raises.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values ('special_events', 0) on conflict (id) do nothing;

create or replace function next_event_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'special_events' returning count into next_count;
    if not found then raise exception 'counters row "special_events" is missing'; end if;
    return 'EVT-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- special_events — one occurrence.
--
-- Exactly one anchor set is populated, decided by calendar_system:
--   hijri                  → hijri_month + hijri_day          ("1 Shawwal")
--   gregorian              → gregorian_month + gregorian_day  ("14 August")
--   gregorian_nth_weekday  → gregorian_month + nth_weekday + weekday
--                            ("2nd Sunday of May" — Mother's Day)
-- A one-off event (is_recurring = false) needs no anchor at all; the admin just
-- sets confirmed_date.
-- ---------------------------------------------------------------------------
create table special_events (
  id                     uuid primary key default gen_random_uuid(),
  event_number           text not null unique default next_event_number(),
  -- Stable key for the recurring series. Unique with event_year, which is what
  -- lets the comparison feature find "the same event, last year".
  series_code            text not null,
  event_year             integer not null,
  name                   text not null,
  description            text,
  category               event_category not null,
  event_type             text,                                   -- free vocabulary
  calendar_system        event_calendar_system not null default 'gregorian',

  -- Anchors
  hijri_month            smallint check (hijri_month     between 1 and 12),
  hijri_day              smallint check (hijri_day       between 1 and 30),
  gregorian_month        smallint check (gregorian_month between 1 and 12),
  gregorian_day          smallint check (gregorian_day   between 1 and 31),
  nth_weekday            smallint check (nth_weekday     between 1 and 5),
  weekday                smallint check (weekday         between 0 and 6),  -- 0 = Sunday

  is_recurring           boolean not null default true,

  -- Resolved schedule. estimated_date is written by the API from the anchor;
  -- confirmed_date is the admin override and always wins.
  estimated_date         date,
  confirmed_date         date,
  duration_days          smallint not null default 1 check (duration_days >= 1),

  -- NOTE: event_end_date repeats the whole coalesce() rather than saying
  -- `event_date + ...`. A generated column CANNOT reference another generated
  -- column. tsc will not catch that — the migration simply fails to apply.
  event_date     date generated always as (coalesce(confirmed_date, estimated_date)) stored,
  event_end_date date generated always as
    (coalesce(confirmed_date, estimated_date) + (duration_days - 1)) stored,

  demand_due_date        date,
  -- Days before the event that branch demand is due. Kept alongside the resolved
  -- date so refreshing an estimate can recompute the deadline without the admin
  -- re-entering it.
  demand_lead_days       smallint not null default 10 check (demand_lead_days >= 0),
  preparation_start_date date,

  status                 event_status   not null default 'upcoming',
  priority               event_priority not null default 'normal',
  -- true → every active branch participates. false → the event_branches list.
  applies_to_all_branches boolean not null default true,
  color                  text,                                   -- calendar chip, hex
  notes                  text,
  is_active              boolean not null default true,
  created_by             uuid references users (id) on delete set null,
  created_by_name        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint special_events_series_year_key unique (series_code, event_year),
  constraint special_events_anchor_ck check (
       (not is_recurring and confirmed_date is not null)
    or (calendar_system = 'hijri'     and hijri_month     is not null and hijri_day     is not null)
    or (calendar_system = 'gregorian' and gregorian_month is not null and gregorian_day is not null)
    or (calendar_system = 'gregorian_nth_weekday'
        and gregorian_month is not null and nth_weekday is not null and weekday is not null)
  )
);

create index special_events_date_idx   on special_events (event_date)          where is_active;
create index special_events_year_idx   on special_events (event_year, event_date);
create index special_events_status_idx on special_events (status, event_date)  where is_active;
create index special_events_due_idx    on special_events (demand_due_date)     where demand_due_date is not null;
create index special_events_series_idx on special_events (series_code, event_year desc);

create trigger special_events_touch before update on special_events
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- event_branches — which branches participate, when applies_to_all_branches is
-- false. An empty list with the flag true is the normal case and costs nothing.
-- ---------------------------------------------------------------------------
create table event_branches (
  event_id  uuid not null references special_events (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  primary key (event_id, branch_id)
);

create index event_branches_branch_idx on event_branches (branch_id);

-- ---------------------------------------------------------------------------
-- event_branch_demands — one advance-demand header per (event, branch).
--
-- branch_id is ON DELETE RESTRICT, matching orders/expenses: a branch with a
-- demand on record cannot be deleted out from under it.
-- ---------------------------------------------------------------------------
create table event_branch_demands (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references special_events (id) on delete cascade,
  branch_id          uuid not null references branches (id) on delete restrict,
  branch_name        text,
  status             event_demand_status not null default 'draft',
  expected_customers integer,
  notes              text,
  submitted_at       timestamptz,
  submitted_by       uuid references users (id) on delete set null,
  submitted_by_name  text,
  reviewed_at        timestamptz,
  reviewed_by        uuid references users (id) on delete set null,
  reviewed_by_name   text,
  review_remarks     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint event_branch_demands_key unique (event_id, branch_id)
);

create index event_branch_demands_event_idx  on event_branch_demands (event_id, status);
create index event_branch_demands_branch_idx on event_branch_demands (branch_id, event_id);

create trigger event_branch_demands_touch before update on event_branch_demands
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- event_branch_demand_items — product lines. A child table, not a jsonb array,
-- for reasons that are structural rather than stylistic:
--
--   1. The consolidated production view is `group by product_id` across every
--      branch. Over jsonb that is an unindexed scan plus an in-memory reduce on
--      every page load.
--   2. The product-wise chart and the prior-year comparison both JOIN to
--      order_items.product_id. A jsonb blob cannot participate in that join.
--   3. It mirrors production_order_items (migration 05) exactly, including the
--      "review-only columns are null until approval" convention — so the existing
--      review and table code shapes port over with no new patterns.
--
-- product_id is ON DELETE SET NULL with product_name NOT NULL alongside it: the
-- same rule order_items documents — deleting a product must never erase history.
-- unit_price is a snapshot at submission for the same reason.
-- ---------------------------------------------------------------------------
create table event_branch_demand_items (
  id           uuid primary key default gen_random_uuid(),
  demand_id    uuid not null references event_branch_demands (id) on delete cascade,
  product_id   uuid references products (id) on delete set null,
  product_name text not null,
  qty          numeric(14,3) not null check (qty > 0),   -- requested by the branch
  approved_qty numeric(14,3),                            -- null until reviewed
  prepared_qty numeric(14,3) not null default 0,
  unit_price   numeric(14,2),
  remarks      text,
  line_no      integer not null
);

create index event_branch_demand_items_demand_idx  on event_branch_demand_items (demand_id, line_no);
create index event_branch_demand_items_product_idx on event_branch_demand_items (product_id)
  where product_id is not null;

-- ---------------------------------------------------------------------------
-- event_production_status — four manual preparation stages per event.
--
-- Overall readiness is the average of the four percentages and is computed in the
-- service ON READ. It is deliberately not a stored column: that needs a second
-- trigger and can drift from the rows it summarises.
-- ---------------------------------------------------------------------------
create table event_production_status (
  id                    uuid primary key default gen_random_uuid(),
  event_id              uuid not null references special_events (id) on delete cascade,
  stage                 event_production_stage not null,
  completion_percentage smallint not null default 0
    check (completion_percentage between 0 and 100),
  remarks               text,
  started_at            timestamptz,
  completed_at          timestamptz,
  updated_by            uuid references users (id) on delete set null,
  updated_by_name       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint event_production_status_key unique (event_id, stage)
);

create index event_production_status_event_idx on event_production_status (event_id);

create trigger event_production_status_touch before update on event_production_status
  for each row execute function app.touch_updated_at();

-- The four stage rows are seeded by a trigger rather than by the API, so an event
-- created by SQL seed, by the API, or by the annual roll-forward all behave
-- identically. enum_range() means adding a fifth stage later needs no code change.
create or replace function app.seed_event_production_stages() returns trigger
  language plpgsql as $$
  begin
    insert into event_production_status (event_id, stage)
    select new.id, s
    from unnest(enum_range(null::event_production_stage)) as s
    on conflict (event_id, stage) do nothing;
    return new;
  end;
  $$;

create trigger special_events_seed_stages after insert on special_events
  for each row execute function app.seed_event_production_stages();

revoke all on function app.seed_event_production_stages() from public, anon, authenticated;
grant execute on function app.seed_event_production_stages() to service_role;

-- ---------------------------------------------------------------------------
-- event_notifications — the reminder SCHEDULE. Rows are generated when an event
-- is created or its dates move, and consumed by the dispatcher.
--
-- `scheduled_for` is a business date (not an instant): reminders fire on a day,
-- and comparing a date against businessDateStr() is what makes a re-run on the
-- same day a no-op rather than a duplicate.
--
-- `claimed_at` + the 'sending' status are the check-and-set claim that stops a
-- manual dispatch and the cron job double-sending the same reminder — the same
-- atomic pattern review_production_order and claim_business_day_closure use.
-- ---------------------------------------------------------------------------
create table event_notifications (
  id                     uuid primary key default gen_random_uuid(),
  event_id               uuid not null references special_events (id) on delete cascade,
  audience               event_notification_audience not null,
  branch_id              uuid references branches (id) on delete cascade,
  reminder_kind          event_reminder_kind not null,
  offset_days            smallint not null,
  scheduled_for          date not null,
  title                  text not null,
  message                text not null,
  status                 event_notification_status not null default 'pending',
  in_app_notification_id uuid references notifications (id) on delete set null,
  attempts               integer not null default 0,
  claimed_at             timestamptz,
  sent_at                timestamptz,
  error_message          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- One scheduled reminder per (event, audience, branch, kind, offset). The coalesce
-- keeps the production/admin rows (null branch_id) unique while allowing one row
-- per branch — the same trick daily_closing_reports_key uses in migration 27.
-- This is what makes regenerating a schedule safe to call as often as you like.
create unique index event_notifications_key
  on event_notifications (event_id, audience, coalesce(branch_id::text, ''), reminder_kind, offset_days);
create index event_notifications_due_idx   on event_notifications (scheduled_for) where status = 'pending';
create index event_notifications_event_idx on event_notifications (event_id, scheduled_for);

create trigger event_notifications_touch before update on event_notifications
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Event reminders reuse the EXISTING delivery log rather than adding a second
-- one, so the admin sees closing summaries and event reminders side by side and
-- there is one place to look when a message did not arrive. report_id is already
-- nullable, so an event row simply leaves it null.
-- ---------------------------------------------------------------------------
alter table notification_logs
  add column if not exists event_notification_id uuid
    references event_notifications (id) on delete set null;

create index if not exists notification_logs_event_idx
  on notification_logs (event_notification_id) where event_notification_id is not null;

-- ---------------------------------------------------------------------------
-- Master switch, defaulting OFF exactly like closing_notifications_enabled and
-- order_confirmations_enabled: turning it on starts billing real WhatsApp/SMS
-- messages to real numbers. The scheduler respects it; a manual dispatch does not.
-- ---------------------------------------------------------------------------
alter table settings
  add column if not exists event_notifications_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- RLS. Class A (API-owned) throughout — the Express API reaches these with the
-- service-role key, which bypasses RLS, so authorization lives in the route
-- handlers (requireRole + a branchId taken from the JWT, never the request body).
-- The policies below are defence-in-depth and SELECT-only.
--
-- event_notifications gets NO policy on purpose: it is job-internal, the client
-- reads it only through the admin API, and default-deny is the correct posture.
-- ---------------------------------------------------------------------------
alter table special_events            enable row level security;
alter table event_branches            enable row level security;
alter table event_branch_demands      enable row level security;
alter table event_branch_demand_items enable row level security;
alter table event_production_status   enable row level security;
alter table event_notifications       enable row level security;

create policy special_events_select on special_events
  for select to authenticated using (is_active or app.is_super_admin());

create policy event_branches_select on event_branches
  for select to authenticated
  using (app.is_super_admin() or app.jwt_role() = 'production_user' or branch_id = app.jwt_branch_id());

-- Mirrors production_orders_select_branch (migration 09): production users are a
-- central role and see every branch's demand; a branch manager sees only its own.
create policy event_branch_demands_select on event_branch_demands
  for select to authenticated
  using (app.is_super_admin() or app.jwt_role() = 'production_user' or branch_id = app.jwt_branch_id());

create policy event_branch_demand_items_select on event_branch_demand_items
  for select to authenticated
  using (exists (
    select 1 from event_branch_demands d
    where d.id = event_branch_demand_items.demand_id
      and (app.is_super_admin() or app.jwt_role() = 'production_user'
           or d.branch_id = app.jwt_branch_id())
  ));

create policy event_production_status_select on event_production_status
  for select to authenticated using (true);

-- No realtime publication and no `replica identity full` for any of these. The
-- client reaches them through the Express API, and live updates ride the existing
-- `notifications` channel (migration 18) — see RealtimeProvider on the web side.

-- ---------------------------------------------------------------------------
-- Default catalogue for 2026.
--
-- estimated_date is deliberately left NULL: the Gregorian date for a Hijri anchor
-- is computed in TypeScript, so it cannot be written here. Run
-- POST /api/special-events/maintenance/refresh-estimates ONCE after this migration
-- or every seeded event has a null event_date and shows up nowhere.
--
-- `on conflict (series_code, event_year) do nothing` makes a re-run a no-op and,
-- more importantly, means this never overwrites a date or name an admin has since
-- corrected.
-- ---------------------------------------------------------------------------

-- Islamic — anchored to the Hijri calendar. Dates are ESTIMATES; Pakistan's
-- Ruet-e-Hilal committee announcement is what the admin confirms against.
insert into special_events
  (series_code, event_year, name, category, calendar_system, hijri_month, hijri_day,
   duration_days, demand_lead_days, priority, color, event_type, description)
values
  ('ISL-RAMADAN',    2026, 'Ramadan Begins',      'islamic', 'hijri',  9,  1, 1,  14, 'critical', '#16A34A', 'Religious Occasion', 'Sehri/Iftar demand shifts for the whole month.'),
  ('ISL-SHAB-QADR',  2026, 'Shab-e-Qadr',         'islamic', 'hijri',  9, 27, 1,   7, 'normal',   '#16A34A', 'Religious Occasion', null),
  ('ISL-EID-FITR',   2026, 'Eid-ul-Fitr',         'islamic', 'hijri', 10,  1, 3,  14, 'critical', '#16A34A', 'Religious Festival', 'Peak cake, sweets and gift-box demand.'),
  ('ISL-EID-ADHA',   2026, 'Eid-ul-Adha',         'islamic', 'hijri', 12, 10, 3,  14, 'critical', '#16A34A', 'Religious Festival', null),
  ('ISL-NEW-YEAR',   2026, 'Islamic New Year',    'islamic', 'hijri',  1,  1, 1,   7, 'low',      '#16A34A', 'Religious Occasion', null),
  ('ISL-ASHURA',     2026, 'Ashura',              'islamic', 'hijri',  1, 10, 2,   7, 'normal',   '#16A34A', 'Religious Occasion', 'Demand pattern differs from a festival — plan conservatively.'),
  ('ISL-MILAD',      2026, '12 Rabi-ul-Awwal',    'islamic', 'hijri',  3, 12, 1,  10, 'high',     '#16A34A', 'Religious Festival', null),
  ('ISL-SHAB-BARAT', 2026, 'Shab-e-Barat',        'islamic', 'hijri',  8, 15, 1,   7, 'normal',   '#16A34A', 'Religious Occasion', 'Traditional sweets demand.')
on conflict (series_code, event_year) do nothing;

-- National (Pakistan) — fixed Gregorian dates.
insert into special_events
  (series_code, event_year, name, category, calendar_system, gregorian_month, gregorian_day,
   duration_days, demand_lead_days, priority, color, event_type)
values
  ('NAT-KASHMIR',      2026, 'Kashmir Solidarity Day', 'national', 'gregorian',  2,  5, 1,  7, 'low',    '#01411C', 'Public Holiday'),
  ('NAT-PAKISTAN-DAY', 2026, 'Pakistan Day',           'national', 'gregorian',  3, 23, 1, 10, 'high',   '#01411C', 'National Day'),
  ('NAT-LABOUR',       2026, 'Labour Day',             'national', 'gregorian',  5,  1, 1,  7, 'low',    '#01411C', 'Public Holiday'),
  ('NAT-INDEPENDENCE', 2026, 'Independence Day',       'national', 'gregorian',  8, 14, 1, 10, 'high',   '#01411C', 'National Day'),
  ('NAT-DEFENCE',      2026, 'Defence Day',            'national', 'gregorian',  9,  6, 1,  7, 'normal', '#01411C', 'National Day'),
  ('NAT-IQBAL',        2026, 'Iqbal Day',              'national', 'gregorian', 11,  9, 1,  7, 'low',    '#01411C', 'Public Holiday'),
  ('NAT-QUAID',        2026, 'Quaid-e-Azam Day',       'national', 'gregorian', 12, 25, 1,  7, 'normal', '#01411C', 'National Day')
on conflict (series_code, event_year) do nothing;

-- International — fixed Gregorian dates.
insert into special_events
  (series_code, event_year, name, category, calendar_system, gregorian_month, gregorian_day,
   duration_days, demand_lead_days, priority, color, event_type)
values
  ('INT-NEW-YEAR',   2026, 'New Year',        'international', 'gregorian',  1,  1, 1, 10, 'high',   '#DB2777', 'Seasonal'),
  ('INT-VALENTINE',  2026, 'Valentine''s Day' , 'international', 'gregorian',  2, 14, 1, 10, 'high',   '#DB2777', 'Seasonal'),
  ('INT-WOMENS-DAY', 2026, 'Women''s Day' ,     'international', 'gregorian',  3,  8, 1,  7, 'low',    '#DB2777', 'Seasonal'),
  ('INT-CHOCOLATE',  2026, 'Chocolate Day',   'international', 'gregorian',  7,  7, 1,  7, 'low',    '#DB2777', 'Seasonal'),
  ('INT-TEACHERS',   2026, 'Teachers'' Day' ,   'international', 'gregorian', 10,  5, 1,  7, 'normal', '#DB2777', 'Seasonal'),
  ('INT-CHILDRENS',  2026, 'Children''s Day' ,  'international', 'gregorian', 11, 20, 1,  7, 'low',    '#DB2777', 'Seasonal'),
  ('INT-CHRISTMAS',  2026, 'Christmas',       'international', 'gregorian', 12, 25, 1, 10, 'normal', '#DB2777', 'Seasonal')
on conflict (series_code, event_year) do nothing;

-- International, nth-weekday anchored. These two are the sole reason the
-- 'gregorian_nth_weekday' calendar system exists — "2nd Sunday of May" has no
-- fixed date. weekday 0 = Sunday.
insert into special_events
  (series_code, event_year, name, category, calendar_system, gregorian_month, nth_weekday, weekday,
   duration_days, demand_lead_days, priority, color, event_type)
values
  ('INT-MOTHERS', 2026, 'Mother''s Day', 'international', 'gregorian_nth_weekday', 5, 2, 0, 1, 10, 'high',   '#DB2777', 'Seasonal'),
  ('INT-FATHERS', 2026, 'Father''s Day', 'international', 'gregorian_nth_weekday', 6, 3, 0, 1,  7, 'normal', '#DB2777', 'Seasonal')
on conflict (series_code, event_year) do nothing;

-- Company. Only the anniversary is seeded — branch openings, promotional
-- campaigns, seasonal sales and mega-sale weekends are created ad hoc by the
-- admin, since none of them has a date that recurs on its own.
insert into special_events
  (series_code, event_year, name, category, calendar_system, gregorian_month, gregorian_day,
   duration_days, demand_lead_days, priority, color, event_type, description)
values
  ('CO-ANNIVERSARY', 2026, 'Mountain Bakes Anniversary', 'company', 'gregorian', 1, 1, 1, 14, 'normal', '#F97316', 'Company Event',
   'Placeholder date — set the real anniversary month/day, then confirm.')
on conflict (series_code, event_year) do nothing;
