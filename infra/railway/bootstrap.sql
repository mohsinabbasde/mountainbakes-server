-- Railway Postgres: what must exist BEFORE the Supabase dump is restored.
--
-- A Supabase database arrives with a set of roles, schemas and extensions that
-- the platform creates and the migrations merely assume. Plain Postgres has none
-- of them. This file creates exactly the ones this application's schema names.
-- Idempotent: safe to run again.

-- ---------------------------------------------------------------------------
-- Roles
--
--   anon, authenticated, service_role
--       The three roles PostgREST switches into, chosen by the `role` claim of
--       the request's JWT. ~225 GRANT/REVOKE statements and ~56 policies in
--       supabase/migrations name them, so they must exist even though — see
--       post-restore.sql — only service_role is given any access here.
--   authenticator
--       The role PostgREST logs in as. It owns nothing and can do nothing but
--       become one of the three above.
--   supabase_auth_admin
--       The role the Auth server (GoTrue) logs in as. Owns the `auth` schema.
--
-- All are created NOLOGIN with no password. `set-service-passwords` gives the
-- two that services connect as a password, so no credential lives in this file.
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
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;

-- GoTrue addresses its tables unqualified.
alter role supabase_auth_admin set search_path = auth;

-- The limits Supabase puts on these roles, carried over as they are. The one
-- that matters is authenticator's: PostgREST's connections belong to it, so
-- every query the API makes is cut off at 8 seconds today, and a report that
-- has always been stopped at that point should not start running for minutes
-- against the production database just because the hosting changed.
alter role authenticator set statement_timeout = '8s';
alter role authenticator set lock_timeout = '8s';
alter role authenticated set statement_timeout = '8s';
alter role anon set statement_timeout = '3s';

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
-- supabase/migrations calls them today; they are here so a function that does
-- resolves the same way it would have.
-- ---------------------------------------------------------------------------
create schema if not exists app;
create schema if not exists extensions;

create extension if not exists pg_trgm with schema public;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
