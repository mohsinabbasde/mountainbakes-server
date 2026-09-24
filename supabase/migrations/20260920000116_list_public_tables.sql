-- 116: List every base table in the public schema, for the daily
-- backup:s3 export (src/scripts/backup-to-s3.ts).
--
-- The backup script needs "every table that exists right now," not a
-- maintained list. A hardcoded array (the way public.data_engine_aggregate's
-- allowlist mirrors src/data-engine/registry.ts by hand) is the wrong shape
-- here: that allowlist's failure mode is safe (a table missing from it just
-- isn't exposed to browsers yet), but a hardcoded backup list's failure mode
-- is dangerous — a newly added table would silently never be backed up, and
-- nobody would notice until a restore was needed. Reading information_schema
-- at call time cannot go stale by definition.
--
-- Each table's primary-key column(s) come along too, because the export
-- paginates every table with .range(), and .range() is only gapless with an
-- explicit ORDER BY — the script orders each table by its own primary key
-- before paginating it.
--
-- It is called ONLY by the API's service-role client (the backup script).
-- EXECUTE is revoked from anon and authenticated so a browser holding a
-- Supabase JWT cannot use it to enumerate the schema.

create or replace function public.list_public_base_tables()
  returns table (table_name text, primary_key_columns text[])
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select
      t.table_name::text,
      coalesce(
        (
          select array_agg(kcu.column_name::text order by kcu.ordinal_position)
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_name = tc.constraint_name
           and kcu.table_schema = tc.table_schema
          where tc.table_schema = 'public'
            and tc.table_name = t.table_name
            and tc.constraint_type = 'PRIMARY KEY'
        ),
        '{}'::text[]
      ) as primary_key_columns
    from information_schema.tables t
    where t.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
    order by t.table_name;
  $$;

comment on function public.list_public_base_tables() is
  'Lists every base table in the public schema plus its primary-key columns, for the backup:s3 script. Called by the API service role only; browsers are revoked below.';

revoke execute on function public.list_public_base_tables() from public, anon, authenticated;
