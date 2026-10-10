-- Railway Postgres: access, and the last traces of Supabase, applied AFTER the
-- dump is restored.
--
-- The dump is restored with --no-owner --no-privileges, so at this point every
-- object belongs to the restoring administrator and carries default access.
-- This file is the whole access model of the new database. Idempotent.

-- ---------------------------------------------------------------------------
-- public, app → service_role only (and so mb_api, which is a member)
--
-- On Supabase, `anon` and `authenticated` held broad table grants and
-- row-level security stood between a signed-in browser and the data. Here
-- there is no browser-reachable endpoint at all: the Express API is the only
-- client, it authorises every request itself, and it connects as mb_api.
--
-- So the two client roles are not given the schemas, whatever grants a future
-- migration adds to an individual table, and row-level security is not
-- restored (see migrate-data.ts): with one trusted client there is nothing for
-- it to separate, and a table with RLS switched on and no policy is a table
-- the API cannot read.
-- ---------------------------------------------------------------------------
revoke all on schema public from public;
revoke all on schema app from public;
revoke all on schema public, app from anon, authenticated;

grant usage on schema public, app, extensions to service_role;
grant all on all tables    in schema public, app to service_role;
grant all on all sequences in schema public, app to service_role;
grant execute on all routines in schema public, app to service_role;

-- Whatever a later migration creates is reachable by the API without that
-- migration having to say so — the same convenience Supabase's platform
-- default privileges gave.
alter default privileges in schema public, app grant all on tables    to service_role;
alter default privileges in schema public, app grant all on sequences to service_role;
alter default privileges in schema public, app grant execute on routines to service_role;

-- ---------------------------------------------------------------------------
-- users.id
--
-- A user's id used to be handed down from Supabase Auth: the account was
-- created there first and `users.id` was a foreign key to it (not restored —
-- there is no `auth` schema here). The API now chooses the id itself; the
-- default is for anything that inserts a user without one.
-- ---------------------------------------------------------------------------
alter table public.users alter column id set default gen_random_uuid();

-- ---------------------------------------------------------------------------
-- The helpers the row-level-security policies were written with
--
-- These read the role and branch out of the JWT that PostgREST placed in
-- `request.jwt.claims`. Nothing sets that any more and nothing but the policies
-- ever called them. Dropped without CASCADE on purpose: if something does still
-- depend on one, this statement fails and says what, instead of quietly taking
-- it along.
-- ---------------------------------------------------------------------------
drop function if exists app.can_read_finance();
drop function if exists app.is_finance();
drop function if exists app.is_super_admin();
drop function if exists app.jwt_branch_id();
drop function if exists app.jwt_role();
