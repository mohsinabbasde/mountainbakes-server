-- Railway Postgres: what must exist BEFORE the Supabase dump is restored.
--
-- A Supabase database arrives with roles, schemas and extensions that the
-- platform creates and the migrations merely assume. Plain Postgres has none of
-- them. This file creates exactly the ones this application's schema names.
-- Idempotent: safe to run again.

-- ---------------------------------------------------------------------------
-- Roles
--
--   mb_api
--       The role the Express API logs in as, and the only thing that connects
--       to this database apart from an administrator. It owns nothing; it can
--       read and write the tables and call the functions, and no more. NOLOGIN
--       until `pnpm railway:role` gives it a password, so no credential lives
--       in this file.
--
--   service_role
--       What holds the grants. ~225 GRANT/REVOKE statements across the
--       migrations already name it, and every future one will, so the grants
--       stay on it and mb_api is simply a member. Nothing logs in as it.
--
--   anon, authenticated
--       The roles a browser reached Supabase's REST endpoint as. Nothing can
--       become either of them here — there is no such endpoint — and
--       post-restore.sql takes the schemas away from both. They exist only so
--       that a migration which mentions them still applies.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mb_api') then
    create role mb_api nologin inherit;
  end if;
end $$;

grant service_role to mb_api;

-- The limits PostgREST's connections ran under on Supabase, carried over to the
-- role that replaces them. Every query the API makes is cut off at 8 seconds
-- today, and a report that has always been stopped at that point should not
-- start running for minutes against the production database just because the
-- hosting changed. Set on the ROLE, not the database: a backup or a migration,
-- run as an administrator, is supposed to take as long as it takes.
alter role mb_api set statement_timeout = '8s';
alter role mb_api set lock_timeout = '8s';

-- Unqualified names in the SQL functions resolve as they did behind PostgREST.
alter role mb_api set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Time zone
--
-- Supabase runs in UTC. Every `now()::date`, `current_date` and timestamp cast
-- inside the SQL functions depends on the session time zone, and every
-- timestamp the API returns is rendered in it. Pinned on the database so it
-- does not depend on how the server image happens to be configured.
-- ---------------------------------------------------------------------------
do $$
begin
  execute format('alter database %I set timezone to %L', current_database(), 'UTC');
end $$;
set timezone to 'UTC';

-- ---------------------------------------------------------------------------
-- Schemas and extensions
--
-- pg_trgm lives in PUBLIC, not `extensions`: migration 109 created it
-- unqualified, production has it there, and the nine dumped trigram indexes
-- name public.gin_trgm_ops. Anywhere else and those indexes fail to restore.
--
-- pgcrypto and uuid-ossp sit in `extensions` as they do on Supabase. Nothing in
-- the migrations calls them today; they are here so a function that does
-- resolves the same way it would have.
-- ---------------------------------------------------------------------------
create schema if not exists app;
create schema if not exists extensions;

create extension if not exists pg_trgm with schema public;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
