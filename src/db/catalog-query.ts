/**
 * The one query that describes the database to the query layer: tables and
 * their column types, primary and unique keys, foreign keys, and functions.
 * `pnpm db:catalog` runs it against the real database and writes the result to
 * catalog.generated.json; the tests run it against pglite.
 *
 * RUN IT WITH AN EMPTY search_path (`set search_path = ''`). Every type outside
 * pg_catalog then comes back schema-qualified (public.user_role, not
 * user_role), so the casts generated from it do not depend on the search_path
 * of whoever runs them.
 */
export const CATALOG_QUERY = `
select json_build_object(
  'tables', (
    select coalesce(json_object_agg(c.relname, json_build_object(
      'columns', (
        select json_object_agg(a.attname, pg_catalog.format_type(a.atttypid, null) order by a.attnum)
          from pg_catalog.pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'pk', coalesce((
        select json_agg(a.attname order by k.ord)
          from pg_catalog.pg_index i
          cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where i.indrelid = c.oid and i.indisprimary), '[]'::json),
      -- Every set of columns that is unique on its own (whole-table, plain
      -- column indexes only). It decides whether an embedded child is one
      -- object or a list.
      'unique', coalesce((
        select json_agg(u.cols order by u.cols::text)
          from (
            select (select json_agg(a.attname order by a.attname)
                      from unnest(i.indkey::int2[]) as k(attnum)
                      join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
              from pg_catalog.pg_index i
             where i.indrelid = c.oid and i.indisunique and i.indpred is null and i.indexprs is null
          ) u), '[]'::json)
    ) order by c.relname), '{}'::json)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       -- Prisma Migrate's own bookkeeping is not the application's to query.
       and c.relname <> '_prisma_migrations'),
  'foreignKeys', (
    select coalesce(json_agg(json_build_object(
      'name', con.conname,
      'table', c.relname,
      'columns', (
        select json_agg(a.attname order by k.ord)
          from unnest(con.conkey) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum),
      'refTable', rc.relname,
      'refColumns', (
        select json_agg(a.attname order by k.ord)
          from unnest(con.confkey) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)
    ) order by c.relname, con.conname), '[]'::json)
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_class rc on rc.oid = con.confrelid
      join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
     where con.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'),
  'functions', (
    select coalesce(json_agg(json_build_object(
      'name', p.proname,
      'args', coalesce((
        select json_agg(json_build_object(
                 'name', an.name,
                 'type', pg_catalog.format_type(at.t, null),
                 'hasDefault', at.i > p.pronargs - p.pronargdefaults) order by at.i)
          from unnest(p.proargtypes::oid[]) with ordinality as at(t, i)
          left join (
            select x.name, row_number() over (order by x.ord) as i
              from unnest(p.proargnames) with ordinality as x(name, ord)
             where p.proargmodes is null or (p.proargmodes::text[])[x.ord] in ('i', 'b', 'v')
          ) an on an.i = at.i), '[]'::json),
      'returnsSet', p.proretset,
      -- 'v' can write; 's' and 'i' only read, so they are safe to run twice.
      'volatility', p.provolatile,
      'returns', case
        when p.prorettype = 'pg_catalog.void'::regtype then 'void'
        when rt.typtype = 'c' or p.prorettype = 'pg_catalog.record'::regtype then 'composite'
        else 'scalar' end,
      'returnType', pg_catalog.format_type(p.prorettype, null)
    ) order by p.proname, p.oid), '[]'::json)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_type rt on rt.oid = p.prorettype
     where n.nspname = 'public' and p.prokind = 'f'
       and p.prorettype <> 'pg_catalog.trigger'::regtype
       -- pg_trgm lives in public and brings its own functions; they are not ours.
       and not exists (
         select 1 from pg_catalog.pg_depend d
          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))
)`;

interface RawCatalog {
  tables: Record<string, unknown>;
  foreignKeys: unknown[];
  functions: Array<{ name: string; args: Array<{ name: string | null }> }>;
}

/** The query's one JSON value, as the `Catalog` shape: functions keyed by name. */
export function shapeCatalog(raw: RawCatalog): { tables: Record<string, unknown>; foreignKeys: unknown[]; functions: Record<string, unknown[]> } {
  // The layer calls functions by argument NAME, as PostgREST does. One that
  // cannot be called that way is a function it cannot describe.
  for (const fn of raw.functions) {
    if (fn.args.some((a) => !a.name)) {
      throw new Error(`public.${fn.name} has an unnamed argument; it cannot be called through db.rpc`);
    }
  }
  const functions: Record<string, unknown[]> = {};
  for (const fn of raw.functions) (functions[fn.name] ??= []).push(fn);
  return { tables: raw.tables, foreignKeys: raw.foreignKeys, functions };
}
