-- Railway Postgres: ownership and access, applied AFTER the dump is restored.
--
-- The dump is restored with --no-owner --no-privileges, so at this point every
-- object belongs to the restoring superuser and carries default access. This
-- file is the whole access model of the new database. Idempotent.

-- ---------------------------------------------------------------------------
-- auth → owned by the Auth server's role
--
-- GoTrue runs its own migrations against this schema on every start and must
-- own what it alters. A sequence owned by a table column follows its table and
-- refuses to be re-owned on its own, hence the exception handler.
-- ---------------------------------------------------------------------------
alter schema auth owner to supabase_auth_admin;

do $$
declare r record;
begin
  for r in select c.oid::regclass as obj, c.relkind
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'auth' and c.relkind in ('r', 'p', 'v', 'S')
            order by (c.relkind = 'S')   -- tables first, so owned sequences have moved already
  loop
    begin
      execute format('alter %s %s owner to supabase_auth_admin',
                     case r.relkind when 'S' then 'sequence' when 'v' then 'view' else 'table' end, r.obj);
    exception when others then
      null;
    end;
  end loop;

  for r in select t.oid::regtype as obj
             from pg_type t join pg_namespace n on n.oid = t.typnamespace
            where n.nspname = 'auth' and t.typtype in ('e', 'd')
  loop
    execute format('alter type %s owner to supabase_auth_admin', r.obj);
  end loop;

  for r in select p.oid::regprocedure as obj
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'auth'
  loop
    execute format('alter routine %s owner to supabase_auth_admin', r.obj);
  end loop;
end $$;

-- Policies and column defaults in `public` call auth.uid() and friends, and are
-- evaluated as whichever role PostgREST switched into.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public, app → service_role only
--
-- On Supabase, `anon` and `authenticated` hold broad table grants and RLS is
-- what stands between a signed-in browser and the data. That was needed while
-- the browser read `notifications` directly. It no longer does: every client
-- request goes through the Express API, which connects as service_role.
--
-- So here the two client roles are not given the schemas at all. A token minted
-- for a user — which PostgREST would otherwise accept as `authenticated` — can
-- name nothing in `public` or `app`, whatever grants a future migration adds to
-- an individual table. The RLS policies stay in place underneath as they were.
-- ---------------------------------------------------------------------------
revoke all on schema public from public;
revoke all on schema app from public;
revoke all on schema public, app from anon, authenticated;

grant usage on schema public, app to service_role;
grant all on all tables    in schema public, app to service_role;
grant all on all sequences in schema public, app to service_role;
grant execute on all routines in schema public, app to service_role;

-- Whatever a later migration creates is reachable by the API without that
-- migration having to say so — the same convenience Supabase's platform
-- default privileges gave.
alter default privileges in schema public, app grant all on tables    to service_role;
alter default privileges in schema public, app grant all on sequences to service_role;
alter default privileges in schema public, app grant execute on routines to service_role;

grant usage on schema extensions to service_role, supabase_auth_admin;

-- The Auth server's own bookkeeping only; the application schemas are not its business.
revoke all on schema public, app from supabase_auth_admin;
