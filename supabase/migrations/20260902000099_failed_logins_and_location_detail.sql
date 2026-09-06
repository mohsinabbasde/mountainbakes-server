-- ---------------------------------------------------------------------------
-- 99: Failed sign-ins, and the location/device detail migration 98 left out.
--
-- Migration 85 recorded a session. Migration 98 made an admin able to ACT on
-- one. This migration finishes the picture in the two places those two left
-- blank:
--
--   * A sign-in that FAILED is invisible. `login_sessions` only ever gets a row
--     after Supabase has already issued a session, so a hundred rejected
--     password attempts against one account leave no trace anywhere an admin can
--     read. That is the single most useful signal a security screen can carry,
--     and it was the one thing missing from it.
--   * A session says "Karachi" without saying HOW it knows. Country and city
--     have been resolved from the IP address since 85, but nothing on the row
--     records that, so a coarse network-level guess and a precise device fix
--     would render identically. `location_source` makes the provenance part of
--     the data rather than a sentence in the page header.
--
-- What has NOT changed, and must not: nothing here authorises anything, RLS
-- stays on with no policies, and no credential material is stored anywhere in
-- this file. The failed-attempt table in particular holds an ATTEMPTED ADDRESS
-- and nothing else about the attempt — never the password, never a hash of it,
-- never a length, never a "close enough" score.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Where the location came from.
--
-- 'IP' means a commercial geolocation database was asked what network the
-- address belongs to. That is a guess about a NETWORK, not an observation of a
-- person: a VPN puts the answer wherever the exit node is, a mobile carrier puts
-- a whole province on one city's gateway, and the database is routinely a
-- country wrong. 'DEVICE_GPS' would mean the browser's Geolocation API returned
-- a fix the user consented to — a different kind of claim entirely, precise to
-- metres and requiring permission. 'UNKNOWN' means the lookup was skipped,
-- refused, rate-limited or timed out.
--
-- NOTHING WRITES 'DEVICE_GPS' TODAY, and that is deliberate rather than
-- unfinished. Prompting every staff member for their physical location merely to
-- file a login record would be a serious escalation of what this feature
-- collects, for a marginal gain over the IP answer; the value exists so that the
-- column can express the distinction the moment a caller has a genuine reason to
-- ask for a fix, and so no reader ever has to assume which kind of location they
-- are looking at.
--
-- Defaulted to 'UNKNOWN' rather than 'IP' so a row written by a future code path
-- that forgets to set it is honest about knowing nothing, instead of claiming a
-- provenance it never had.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column location_source text not null default 'UNKNOWN',
  add column latitude  numeric(9, 6),
  add column longitude numeric(9, 6);

alter table login_sessions
  add constraint login_sessions_location_source_known check (
    location_source in ('IP', 'DEVICE_GPS', 'UNKNOWN')
  );

comment on column login_sessions.location_source is
  'IP | DEVICE_GPS | UNKNOWN — how country/city/latitude/longitude were obtained. IP is a guess about a network, accurate to a city at best and regularly wrong by a country. Read this before presenting the coordinates as a place a person was.';

-- Six decimal places is ~11cm, which is far beyond anything an IP lookup can
-- justify — the precision is here so the column does not have to change if a
-- consented device fix is ever stored, not because the current values earn it.
-- The city centroid a geo provider returns is the whole city's answer, and the
-- UI must never draw a pin on it without saying so.
comment on column login_sessions.latitude is
  'Centroid of whatever `location_source` resolved. For source=IP this is the middle of a city or a network block, NOT where anybody was standing.';


-- ---------------------------------------------------------------------------
-- 2. Client-reported device detail.
--
-- Both columns are reported BY THE BROWSER, which is the important thing about
-- them and the reason they are kept apart from the parsed `browser` / `os` /
-- `device_type` block. Those are read from a header the server received; these
-- are read from JavaScript the page ran, and a tampered client can put anything
-- it likes in either. They are here because they answer the question a user
-- agent cannot — "which of this person's two Android phones is this" — and the
-- UI labels them as reported by the device.
--
-- `screen_size` is stored as the text the client sent ('1920x1080'), not as two
-- integers. It is never computed with; it is shown, and occasionally used to
-- tell one device apart from another with the same user agent.
--
-- `device_name` is a MODEL where a model can be had (Android and some others put
-- one in the user agent, so the server fills this in from the string it already
-- has) and null otherwise. Desktop browsers expose nothing of the kind — there
-- is no API for "this laptop is called Ayesha's MacBook", and inventing one from
-- the OS name would produce a column that looked specific and meant nothing.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column screen_size  text,
  add column device_name  text;

comment on column login_sessions.screen_size is
  'Screen dimensions as the browser reported them, e.g. 1920x1080. Client-reported and therefore forgeable; shown as evidence, never used in a decision.';

comment on column login_sessions.device_name is
  'Device model where the user agent carries one (mostly Android), null otherwise. A guess read from an untrusted string, like every other parsed device column.';


-- ---------------------------------------------------------------------------
-- 3. Back-fill the provenance of the rows that already exist.
--
-- Every row written since migration 85 got its country and city from
-- `geoip.service.ts`, which has only ever performed an IP lookup — so the
-- back-fill is a statement of fact rather than a guess. A row with no resolved
-- country had no successful lookup behind it and keeps 'UNKNOWN', which is the
-- honest answer for a login whose location was never established.
--
-- Coordinates are NOT back-filled. They were not requested from the provider at
-- the time and there is nothing on the row to derive them from; re-resolving
-- thousands of historic addresses would spend the provider's quota to attach a
-- present-day answer to a past login, which is a subtly wrong thing to write
-- into a security record.
-- ---------------------------------------------------------------------------
update login_sessions
   set location_source = 'IP'
 where country is not null
    or city is not null;


-- ---------------------------------------------------------------------------
-- 4. login_attempts — the sign-ins that did not work.
--
-- WHY A SEPARATE TABLE. A failed attempt has no session, no Mountain Bakes user
-- and no authenticated identity of any kind — the whole point is that
-- authentication did not happen. Folding it into `login_sessions` would mean
-- every column that makes that table useful (`user_id`, `user_code`,
-- `auth_session_id`, `last_seen_at`, `ended_at`) sitting null on a growing share
-- of its rows, and every existing query having to exclude them. They are
-- different facts and they get different tables.
--
-- WHAT IDENTIFIES A ROW: the ATTEMPTED ADDRESS, and nothing else. There is
-- deliberately NO `user_id` here, and it is not an oversight — resolving the
-- typed address to an account is exactly the email-as-identity mistake the rest
-- of this feature is built to avoid, and it would also turn the admin screen
-- into a confirmation of which addresses are real accounts. An admin who wants
-- to know whether these attempts hit a live account can search the address in
-- Users, which is a deliberate act by someone entitled to do it.
--
-- WHAT IS NEVER STORED: the password. Not the value, not a hash, not its length,
-- not how close it was. Nothing in the client ever sends it here and nothing in
-- this table could hold it.
--
-- THE ROW IS REPORTED BY THE CLIENT, AND IS THEREFORE FORGEABLE. The app is a
-- static export that authenticates against Supabase directly; the API never sees
-- the failure, so the browser posts it — from an endpoint that by definition
-- cannot require a token. Anybody able to reach the API can therefore write
-- rows here that describe attempts that never happened. That is a real
-- limitation and the reason this table is evidence for a person and never an
-- input to a lockout: a forgeable table that could lock an account out would be
-- a denial-of-service tool with an admin screen attached. What it CAN do is
-- surface a burst of failures nobody has explained, which is the signal an admin
-- actually wants. Volume is bounded by a strict rate limit on the route.
-- ---------------------------------------------------------------------------
create table login_attempts (
  id             uuid primary key default gen_random_uuid(),

  -- Lower-cased and capped by the API before it lands here. Not a foreign key,
  -- not resolved to an account, and not unique — see the note above.
  email          text not null,

  -- Why it failed, as the client understood it. A closed set so the column can
  -- be filtered and counted; the prose an admin reads is built from these in the
  -- UI, so rewording a message never rewrites history.
  reason         text not null,

  -- Same shape and the same reasoning as login_sessions: `text` for the address
  -- because an X-Forwarded-For chain is a comma-joined list that `inet` rejects,
  -- the raw agent kept beside a best-effort parse of it.
  ip_address     text,
  user_agent     text,
  browser        text,
  browser_version text,
  os             text,
  os_version     text,
  device_type    text,

  country        text,
  country_code   text,
  city           text,
  region         text,
  timezone       text,
  location_source text not null default 'UNKNOWN',

  attempted_at   timestamptz not null default now(),
  business_date  date not null,
  created_at     timestamptz not null default now(),

  constraint login_attempts_reason_known check (
    reason in (
      'invalid_credentials',   -- wrong address or wrong password; Supabase does not say which, and neither do we
      'account_disabled',      -- the account exists and has been banned
      'email_not_confirmed',
      'rate_limited',          -- Supabase refused before checking anything
      'no_role',               -- authenticated, but the account carries no role claim — the app's own fail-closed path
      'invalid_session',
      'expired_token',
      'unknown'
    )
  ),

  constraint login_attempts_location_source_known check (
    location_source in ('IP', 'DEVICE_GPS', 'UNKNOWN')
  )
);

-- The list is always "most recent first", either across everything or narrowed
-- to one address or one origin. Those are the three questions the screen asks
-- and there is no fourth, so there is no fourth index.
create index login_attempts_at_idx    on login_attempts (attempted_at desc);
create index login_attempts_email_idx on login_attempts (email, attempted_at desc);
create index login_attempts_ip_idx    on login_attempts (ip_address, attempted_at desc)
  where ip_address is not null;

-- RLS on with NO policies — the same stance every other table in this feature
-- takes. The service-role API is the only reader and bypasses RLS; no browser
-- touches this table directly. That matters more here than usual: a policy
-- permissive enough to let an unauthenticated client insert its own row would
-- also let anybody read every address that has ever been typed into the login
-- form. The insert goes through the API, which holds the service key.
alter table login_attempts enable row level security;

comment on table login_attempts is
  'Failed sign-in attempts: the address that was typed, why it was refused, and the IP, resolved city and parsed browser it came from. Reported by the client because a static-export app authenticates against Supabase directly and the API never sees the failure — and therefore forgeable, which is why it is evidence for a person and never an input to a lockout. Never contains a password, a hash of one, or any other credential material.';
