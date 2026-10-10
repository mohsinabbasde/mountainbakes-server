-- 48: branch geofencing — authorised selling areas, and the audit trail for them.
--
-- Sales may only be recorded while the device is inside the configured radius of
-- the branch it is selling for. Enforcement lives in the API (the browser copy is
-- UX only, exactly like RouteGuard is to the role checks); this migration provides
-- the data those checks read, and the log they write.
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `branches`
--
--   1. A location is written by a different screen, by a different role, on a
--      different cadence than the rest of a branch record. Admin → Branch Locations
--      owns it; Admin → Branches never touches it.
--   2. "This branch has no geofence" is then an ABSENT ROW rather than four nullable
--      columns every consumer has to null-check in agreement. The admin dashboard's
--      "Missing GPS" tile is a left-join miss, not a `latitude is null` convention
--      that some future query will get wrong.
--   3. It leaves room for the obvious extension — more than one authorised area per
--      branch (a shop plus its warehouse) — without a second migration reshaping
--      `branches` again. The unique constraint below is what holds it to one for
--      now, and dropping a constraint is cheaper than splitting a table.
--
-- NO POSTGIS. The radii here are 5–100 km and the check is a single point-in-circle
-- test, which Haversine answers in a few floating-point operations. Enabling PostGIS
-- to avoid writing one formula would add an extension to every environment for a
-- query plan that never gets more complex than "one row by branch_id". The formula
-- lives in src/shared/utils/geo.ts and is the SAME code the browser runs, which is
-- worth more here than a spatial index over a table with one row per branch.

-- ---------------------------------------------------------------------------
-- branch_locations
-- ---------------------------------------------------------------------------

create table branch_locations (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches (id) on delete cascade,
  -- Denormalised cache of branches.name, same pattern as branches.manager_name.
  -- The admin table lists locations and the audit log stamps a name at write time,
  -- so both read it without a join. Refreshed by the route on every upsert.
  branch_name     text,
  address         text,
  latitude        numeric(10, 7) not null,
  longitude       numeric(10, 7) not null,
  -- numeric(10,7) is ~11 mm of precision at the equator. GPS is good to metres at
  -- best, so this is already far finer than anything that reaches it.
  radius_km       numeric(6, 2) not null default 50,
  google_place_id text,
  -- Disabling leaves the coordinates in place: it is how an admin suspends the rule
  -- for one branch (a relocation, a temporary stall) without losing the location.
  is_active       boolean not null default true,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One geofence per branch. Also what makes the upsert in the route safe to retry.
  constraint branch_locations_branch_unique unique (branch_id),
  -- Reject a coordinate pair that is off the planet. The API validates this too
  -- (geofence.schemas.ts); the constraint is what stops a hand-run SQL fix from
  -- installing a location no device can ever be inside.
  constraint branch_locations_lat_range  check (latitude  between -90  and 90),
  constraint branch_locations_lng_range  check (longitude between -180 and 180),
  -- Zero would be a geofence nothing can satisfy — a silent shutdown of the branch.
  constraint branch_locations_radius_positive check (radius_km > 0 and radius_km <= 500)
);

-- The hot path is exactly one shape: "the active geofence for this branch", read on
-- every guarded request. The unique constraint above already indexes branch_id; this
-- partial index keeps the active-only lookup off the table.
create index branch_locations_active_idx on branch_locations (branch_id) where is_active;

create trigger branch_locations_touch before update on branch_locations
  for each row execute function app.touch_updated_at();

-- The API uses the service-role key and bypasses RLS (authorization is enforced in
-- application code), but every table carries policies for consistency.
alter table branch_locations enable row level security;

-- A branch user may read their OWN branch's geofence — the status card on their
-- dashboard renders the branch coordinates and radius. They may not read another
-- branch's, and they may not write any of it.
create policy branch_locations_select on branch_locations
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy branch_locations_write on branch_locations
  for all to authenticated
  using (app.is_super_admin())
  with check (app.is_super_admin());

-- ---------------------------------------------------------------------------
-- geofence_logs — the audit trail.
-- ---------------------------------------------------------------------------
--
-- Every CHECKED attempt is recorded, allowed as well as blocked. A log that only
-- holds refusals cannot answer "was this cashier at the shop when they rang up that
-- sale", which is the question the log exists to answer. Blocked rows are the
-- interesting minority, not the point.
--
-- Nothing here references orders. The check runs BEFORE the sale is created and a
-- blocked attempt produces no order at all, so there is no id to point at; the pair
-- is reconstructed from (user, branch, timestamp) when auditing. Recording the
-- attempt is the requirement — the whole purpose is to capture the ones that never
-- became a sale.
--
-- `outcome` is text with a check constraint rather than an enum: the set is defined
-- in TypeScript (GeofenceOutcome in shared/utils/geo.ts) and a new member should not
-- need a migration to alter a type that other tables might depend on.

create table geofence_logs (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid references branches (id) on delete set null,
  branch_name  text,
  user_id      uuid references users (id) on delete set null,
  user_name    text,
  user_role    user_role,
  -- The guarded operation: 'sale.create', 'order.create', 'stock.return', 'verify'.
  action       text not null,
  latitude     numeric(10, 7),
  longitude    numeric(10, 7),
  accuracy_m   integer,
  distance_km  numeric(10, 3),
  radius_km    numeric(6, 2),
  outcome      text not null,
  allowed      boolean not null,
  -- Device context, for spotting the same account reporting from two places. Held
  -- as plain text: `inet` rejects the comma-joined list an X-Forwarded-For chain
  -- produces, and the value is evidence to read, not something to subnet-match on.
  ip_address   text,
  user_agent   text,
  created_at   timestamptz not null default now(),

  constraint geofence_logs_outcome_known check (
    outcome in (
      'allowed', 'blocked', 'no_position', 'inaccurate',
      'stale', 'not_configured', 'disabled', 'exempt'
    )
  )
);

-- Admin auditing reads newest-first, usually narrowed to a branch or a user.
create index geofence_logs_created_idx on geofence_logs (created_at desc);
create index geofence_logs_branch_idx  on geofence_logs (branch_id, created_at desc);
create index geofence_logs_user_idx    on geofence_logs (user_id, created_at desc);
-- Blocked attempts are what an admin actually goes looking for, and they are a small
-- fraction of the table — a partial index keeps that scan proportional to the
-- exceptions rather than to the traffic.
create index geofence_logs_blocked_idx on geofence_logs (created_at desc) where not allowed;

alter table geofence_logs enable row level security;

-- Audit rows are admin-only reading. A branch user seeing their own history would
-- tell them exactly which readings pass, which is the last thing an anti-bypass log
-- should hand out. Writes come from the service role, which bypasses RLS entirely.
create policy geofence_logs_select on geofence_logs
  for select to authenticated using (app.is_super_admin());

-- ---------------------------------------------------------------------------
-- settings — the global geofencing block.
-- ---------------------------------------------------------------------------
--
-- geofencing_enabled defaults to FALSE. Applying this migration must not change the
-- behaviour of a running system: locations have to be configured and checked on the
-- map before anything starts being refused, and that is an admin's decision to make
-- from the settings screen, not a side effect of a deploy.
--
-- `add column if not exists` because the settings table is a single row that has
-- been extended by several migrations already, and a re-run should be a no-op.

alter table settings
  add column if not exists geofencing_enabled              boolean not null default false,
  add column if not exists geofence_default_radius_km      numeric(6, 2) not null default 50,
  add column if not exists geofence_verify_interval_min    integer not null default 5,
  add column if not exists geofence_require_high_accuracy  boolean not null default true,
  add column if not exists geofence_gps_timeout_sec        integer not null default 20,
  -- Must comfortably exceed the verify interval above, or the API starts rejecting
  -- fixes the client has not been given a chance to refresh. 300s against a 5-minute
  -- interval leaves a full cycle of slack.
  add column if not exists geofence_max_position_age_sec   integer not null default 300;
