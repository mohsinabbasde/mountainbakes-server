import { spawn } from 'node:child_process';
import { pgConnectionEnv } from '../../src/services/backup/postgresBackup';

/**
 * Is the Railway database the same database as the Supabase one?
 *
 *   pnpm railway:verify              compare everything
 *   pnpm railway:verify --structure  skip row contents (for a source still taking writes)
 *
 * Runs the same read-only queries against both and compares the answers. Prints
 * PASS or FAIL per section and exits non-zero if anything failed, so it can gate
 * a cutover.
 *
 * WHAT "THE SAME" MEANS HERE
 *   Structure  every table, column (type, default, nullability), constraint,
 *              index, sequence position, function body, trigger, policy, enum
 *              and RLS switch in public, app, auth and supabase_migrations.
 *   Contents   for every table that was copied: the row count, and a hash over
 *              every value of every row. Two tables with the same hash hold the
 *              same data — ids, timestamps, prices, the lot. This is stronger
 *              than comparing totals, and it is exact: nothing is rounded.
 *   Totals     the SUM of every numeric column, as a second, human-readable
 *              witness for the money and stock columns.
 *   Access     on the target only: that the roles ended up as post-restore.sql
 *              intends. (Access is deliberately NOT the same as on Supabase.)
 *
 * A SOURCE THAT IS STILL LIVE will legitimately differ in Contents and Totals
 * on whichever tables were written to since the copy. During a rehearsal that
 * is expected and the differing tables are listed; at the cutover, with writes
 * frozen, this must pass outright.
 */

const SCHEMAS = `('public', 'app', 'auth', 'supabase_migrations')`;

/** auth tables whose rows are deliberately not copied — see migrate-data.ts. */
const AUTH_NOT_COPIED = `('sessions', 'refresh_tokens', 'audit_log_entries', 'flow_state', 'one_time_tokens', 'mfa_challenges', 'mfa_amr_claims', 'saml_relay_states')`;

/** Tables whose contents are compared: everything copied with its rows. */
const COPIED_TABLES = `
  select n.nspname as s, c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and (n.nspname in ('public', 'app', 'supabase_migrations')
          or (n.nspname = 'auth' and c.relname not in ${AUTH_NOT_COPIED}))`;

// Pinned so a value renders to the same text on both servers whatever their
// own defaults are.
const SESSION = `set timezone = 'UTC'; set datestyle = 'ISO, MDY'; set intervalstyle = 'postgres'; set bytea_output = 'hex'; set extra_float_digits = 1;`;

interface Section { name: string; sql: string; contents?: boolean }

const SECTIONS: Section[] = [
  {
    // The settings that change what a query RETURNS without changing a row:
    // how a timestamp is rendered and which day `current_date` is, and the
    // order `order by name` puts text in.
    name: 'database settings (time zone, encoding, collation)',
    // `reset` drops the time zone this script pins for itself, so what is read
    // is the default a new connection — the API's — would actually get.
    sql: `reset timezone;
          select 'time zone', case when current_setting('TimeZone') in ('UTC', 'Etc/UTC') then 'UTC' else current_setting('TimeZone') end
          union all select 'encoding', pg_encoding_to_char(encoding) from pg_database where datname = current_database()
          union all select 'collation', datlocprovider::text || ':' || coalesce(datlocale, datcollate) from pg_database where datname = current_database()
          union all select 'api statement timeout', coalesce((select split_part(c, '=', 2) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole,
                                                   unnest(s.setconfig) c where r.rolname = 'authenticator' and c like 'statement_timeout=%'), 'none')`,
  },
  {
    name: 'tables',
    sql: `select n.nspname || '.' || c.relname, c.relkind::text
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ${SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm')`,
  },
  {
    name: 'columns',
    sql: `select n.nspname || '.' || c.relname || '.' || a.attname,
                 format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
                   || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' generated=' || a.attgenerated::text
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where n.nspname in ${SCHEMAS} and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`,
  },
  {
    // Postgres 18 records NOT NULL as a constraint row of its own ('n');
    // Postgres 17 does not. Nullability is compared in "columns" instead.
    name: 'constraints',
    sql: `select n.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
            from pg_constraint k
            join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ${SCHEMAS} and k.contype <> 'n'`,
  },
  {
    name: 'indexes',
    sql: `select schemaname || '.' || indexname, indexdef from pg_indexes where schemaname in ${SCHEMAS}`,
  },
  {
    name: 'sequences',
    sql: `select schemaname || '.' || sequencename, coalesce(last_value::text, 'unused') || ' inc=' || increment_by
            from pg_sequences where schemaname in ${SCHEMAS}`,
  },
  {
    name: 'functions',
    sql: `select p.oid::regprocedure::text,
                 md5(p.prosrc) || ' ' || l.lanname || ' definer=' || p.prosecdef || ' vol=' || p.provolatile::text
                   || ' config=' || coalesce(array_to_string(p.proconfig, ','), '') || ' returns=' || pg_get_function_result(p.oid)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
           where n.nspname in ${SCHEMAS} and p.prokind in ('f', 'p')
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
  },
  {
    name: 'triggers',
    sql: `select n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ${SCHEMAS} and not t.tgisinternal`,
  },
  {
    name: 'policies',
    sql: `select schemaname || '.' || tablename || '.' || policyname,
                 cmd || ' ' || permissive || ' to=' || array_to_string(roles, ',') || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '')
            from pg_policies where schemaname in ${SCHEMAS}`,
  },
  {
    name: 'row level security',
    sql: `select n.nspname || '.' || c.relname, 'enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ${SCHEMAS} and c.relkind in ('r', 'p')`,
  },
  {
    name: 'enums',
    sql: `select n.nspname || '.' || t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
            from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
           where n.nspname in ${SCHEMAS} group by 1`,
  },
  {
    // query_to_xml runs one generated query per table without needing a
    // function to exist on either server. Rows are hashed individually and the
    // hashes combined in sorted order, so physical row order does not matter.
    name: 'contents (row count and hash of every row)',
    contents: true,
    sql: `select s || '.' || t,
                 (xpath('/row/c/text()', query_to_xml(format(
                   'select count(*) || '' rows '' || coalesce(md5(string_agg(h, '''' order by h)), ''-'') as c from (select md5(x::text) as h from %I.%I x) q',
                   s, t), false, true, '')))[1]::text
            from (${COPIED_TABLES}) tables`,
  },
  {
    name: 'totals (sum of every numeric column)',
    contents: true,
    sql: `select tables.s || '.' || tables.t || '.' || a.attname,
                 coalesce((xpath('/row/c/text()', query_to_xml(format(
                   'select sum(%I)::text as c from %I.%I', a.attname, tables.s, tables.t), false, true, '')))[1]::text, 'null')
            from (${COPIED_TABLES}) tables
            join pg_class c on c.relname = tables.t and c.relnamespace = tables.s::regnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           where a.atttypid in ('numeric'::regtype, 'integer'::regtype, 'bigint'::regtype, 'smallint'::regtype,
                                'double precision'::regtype, 'real'::regtype)`,
  },
];

/** What post-restore.sql is supposed to have left behind. Target only. */
const ACCESS_CHECKS: { name: string; sql: string; want: string }[] = [
  { name: 'anon cannot use schema public', sql: `select has_schema_privilege('anon', 'public', 'usage')`, want: 'f' },
  { name: 'authenticated cannot use schema public', sql: `select has_schema_privilege('authenticated', 'public', 'usage')`, want: 'f' },
  { name: 'authenticated cannot use schema app', sql: `select has_schema_privilege('authenticated', 'app', 'usage')`, want: 'f' },
  { name: 'service_role can use schema public and app', sql: `select has_schema_privilege('service_role', 'public', 'usage') and has_schema_privilege('service_role', 'app', 'usage')`, want: 't' },
  { name: 'service_role bypasses RLS', sql: `select rolbypassrls from pg_roles where rolname = 'service_role'`, want: 't' },
  {
    name: 'service_role can read and write every public table',
    sql: `select count(*) from pg_tables where schemaname = 'public'
            and not has_table_privilege('service_role', format('%I.%I', schemaname, tablename), 'select, insert, update, delete')`,
    want: '0',
  },
  {
    name: 'service_role can execute every public function',
    sql: `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind in ('f', 'p') and not has_function_privilege('service_role', p.oid, 'execute')`,
    want: '0',
  },
  { name: 'authenticator can become service_role', sql: `select pg_has_role('authenticator', 'service_role', 'set')`, want: 't' },
  { name: 'authenticator is not a superuser', sql: `select rolsuper from pg_roles where rolname = 'authenticator'`, want: 'f' },
  { name: 'auth schema is owned by supabase_auth_admin', sql: `select nspowner::regrole::text from pg_namespace where nspname = 'auth'`, want: 'supabase_auth_admin' },
  {
    name: 'every auth table is owned by supabase_auth_admin',
    sql: `select count(*) from pg_tables where schemaname = 'auth' and tableowner <> 'supabase_auth_admin'`,
    want: '0',
  },
  { name: 'pg_trgm is installed in public', sql: `select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm'`, want: 'public' },
  {
    name: 'no foreign key is left unvalidated',
    sql: `select count(*) from pg_constraint where contype = 'f' and not convalidated and connamespace::regnamespace::text in ${SCHEMAS}`,
    want: '0',
  },
];

const SEP = '\u001f';

function psql(env: Record<string, string>, sql: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-A', '-t', '-q', '-F', SEP, '-v', 'ON_ERROR_STOP=1', '-c', `${SESSION} ${sql}`], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => reject(new Error(`${label}: could not start psql: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${label} failed: ${err.trim().split('\n').slice(-4).join(' | ').replace(env.PGPASSWORD ?? '\u0000', '***')}`));
    });
  });
}

/** key → value. A value may itself contain newlines (an index or trigger definition never does, a policy can). */
function parse(out: string): Map<string, string> {
  const map = new Map<string, string>();
  let key: string | null = null;
  for (const line of out.split('\n')) {
    const i = line.indexOf(SEP);
    if (i >= 0) {
      key = line.slice(0, i);
      map.set(key, line.slice(i + 1));
    } else if (key !== null && line !== '') {
      map.set(key, `${map.get(key)}\n${line}`);
    }
  }
  return map;
}

async function main() {
  const structureOnly = process.argv.includes('--structure');
  const source = (process.env.SUPABASE_DB_URL || '').trim();
  const target = (process.env.RAILWAY_DB_URL || '').trim();
  if (!source) throw new Error('SUPABASE_DB_URL is required');
  if (!target) throw new Error('RAILWAY_DB_URL is required');
  const sourceEnv = pgConnectionEnv(source);
  const targetEnv = pgConnectionEnv(target);
  if (!new URL(target).searchParams.get('sslmode')) targetEnv.PGSSLMODE = 'prefer';

  const version = async (env: Record<string, string>, label: string) =>
    (await psql(env, `select current_setting('server_version')`, label)).trim();
  console.log(`source  ${sourceEnv.PGHOST}/${sourceEnv.PGDATABASE}  Postgres ${await version(sourceEnv, 'source')}`);
  console.log(`target  ${targetEnv.PGHOST}:${targetEnv.PGPORT}/${targetEnv.PGDATABASE}  Postgres ${await version(targetEnv, 'target')}`);
  console.log('');

  let failed = 0;
  let contentsFailed = 0;

  for (const section of SECTIONS) {
    if (section.contents && structureOnly) {
      console.log(`SKIP  ${section.name}`);
      continue;
    }
    const [a, b] = await Promise.all([
      psql(sourceEnv, section.sql, `source: ${section.name}`).then(parse),
      psql(targetEnv, section.sql, `target: ${section.name}`).then(parse),
    ]);
    const diffs: string[] = [];
    for (const [key, value] of a) {
      if (!b.has(key)) diffs.push(`missing on target: ${key}`);
      else if (b.get(key) !== value) diffs.push(`differs: ${key}\n          source: ${value.slice(0, 160)}\n          target: ${b.get(key)!.slice(0, 160)}`);
    }
    for (const key of b.keys()) if (!a.has(key)) diffs.push(`only on target: ${key}`);

    if (diffs.length === 0) {
      console.log(`PASS  ${section.name} — ${a.size} compared`);
    } else {
      failed++;
      if (section.contents) contentsFailed++;
      console.log(`FAIL  ${section.name} — ${diffs.length} of ${Math.max(a.size, b.size)} differ`);
      for (const d of diffs.slice(0, 15)) console.log(`        ${d}`);
      if (diffs.length > 15) console.log(`        … and ${diffs.length - 15} more`);
    }
  }

  console.log('');
  for (const check of ACCESS_CHECKS) {
    const got = (await psql(targetEnv, check.sql, `target: ${check.name}`)).trim();
    if (got === check.want) console.log(`PASS  access: ${check.name}`);
    else {
      failed++;
      console.log(`FAIL  access: ${check.name} — expected ${check.want}, got ${got || '(nothing)'}`);
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(structureOnly ? 'RESULT: PASS (structure and access; contents not compared)' : 'RESULT: PASS — the target is an exact copy');
    return;
  }
  console.log(`RESULT: FAIL — ${failed} section(s) failed`);
  if (contentsFailed === failed) {
    console.log('        Only row contents differ. If the source has taken writes since the copy, that is expected:');
    console.log('        re-run `pnpm railway:migrate --reset-target` with writes frozen and verify again.');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[verify]', err instanceof Error ? err.message : err);
  process.exit(1);
});
