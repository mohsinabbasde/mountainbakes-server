import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pgConnectionEnv } from '../../src/services/backup/postgresBackup';

/**
 * Copy the whole database — users included — from Supabase to Railway.
 *
 *   pnpm railway:migrate --create-database create the target database, then copy
 *   pnpm railway:migrate                   first copy into an EMPTY target
 *   pnpm railway:migrate --reset-target    wipe the target's copy and copy again
 *   pnpm railway:migrate --mark-live       the target is now production; refuse to wipe it
 *   pnpm railway:migrate --unmark-live     undo --mark-live (a rollback)
 *
 * READS the source, WRITES the target. Nothing here can alter Supabase: the
 * only thing run against it is pg_dump.
 *
 * WHAT IS COPIED
 *   public, app, supabase_migrations   everything: structure and every row
 *   auth                               the full structure, plus the rows that
 *                                      ARE the accounts — users (with their
 *                                      password hashes), identities, MFA
 *                                      factors and GoTrue's migration history
 *
 * WHAT IS NOT, and why
 *   auth sessions / refresh tokens     every user signs in again on the new
 *                                      system anyway (the Auth URL changes, and
 *                                      with it the browser's storage key)
 *   auth audit log, one-time tokens    history and half-finished flows
 *   storage, vault, realtime, graphql  Supabase platform schemas. Files are
 *                                      moved by `pnpm files:copy`; the rest is
 *                                      not used.
 *
 * THE TARGET IS WIPED FIRST on a repeat run, so a copy is always a clean copy
 * of the source as it is now — never a merge. That is what makes the rehearsal
 * and the real cutover the same command. `--mark-live` is the safety catch on
 * the other side of that: once Railway is production, this script will not
 * touch it.
 *
 * THE TARGET DATABASE MUST SORT TEXT THE WAY SUPABASE DOES. Supabase's database
 * uses the ICU collation `en-US`; the database Railway creates by default
 * (`railway`) uses the C library's `en_US.utf8`. The two put some names in a
 * different order, which shows up as product, customer and employee lists
 * arriving reordered. A database's collation is fixed when it is created, so
 * `--create-database` creates the one named in RAILWAY_DB_URL with the same
 * settings as the source, and a copy into a database that sorts differently is
 * refused unless `--accept-collation` says the difference is understood.
 *
 * Passwords travel in the libpq environment, never in argv, so they do not show
 * in `ps` — the same care services/backup/postgresBackup.ts takes.
 */

const LIVE_MARK = 'mountainbakes:live';

/** auth tables whose ROWS are left behind. Their structure is still copied. */
const AUTH_VOLATILE = [
  'sessions',
  'refresh_tokens',
  'audit_log_entries',
  'flow_state',
  'one_time_tokens',
  'mfa_challenges',
  'mfa_amr_claims',
  'saml_relay_states',
];

interface RunResult { stdout: string; stderr: string }

function run(binary: string, argv: string[], env: Record<string, string>, label: string, secrets: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => reject(new Error(`${label}: could not start ${binary}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      let detail = stderr.trim().split('\n').slice(-12).join('\n');
      for (const s of secrets) if (s) detail = detail.split(s).join('***');
      reject(new Error(`${label} failed (exit ${code}):\n${detail}`));
    });
  });
}

function fmtBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const source = (process.env.SUPABASE_DB_URL || '').trim();
  // RAILWAY_DB_URL only, never DATABASE_URL: that one is the database the API is
  // serving from, and this script wipes its target.
  const target = (process.env.RAILWAY_DB_URL || '').trim();
  if (!target) throw new Error('RAILWAY_DB_URL is required — the Railway Postgres public connection string');

  const targetEnv = pgConnectionEnv(target);
  // Railway's proxy speaks TLS but pgConnectionEnv's default of `require` is a
  // Supabase assumption; `prefer` works for both.
  if (!new URL(target).searchParams.get('sslmode')) targetEnv.PGSSLMODE = 'prefer';
  if (/supabase/i.test(targetEnv.PGHOST)) {
    throw new Error(`The TARGET host is ${targetEnv.PGHOST} — that is Supabase. Refusing to write to it.`);
  }
  const secrets = [targetEnv.PGPASSWORD];
  const here = __dirname;

  const psqlTarget = (sqlArgs: string[], label: string) =>
    run('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', ...sqlArgs], targetEnv, label, secrets);
  const targetValue = async (sql: string) => (await psqlTarget(['-c', sql], 'psql (target)')).stdout.trim();

  const dbName = targetEnv.PGDATABASE.replace(/"/g, '""');

  if (args.has('--create-database')) {
    // CREATE DATABASE cannot run inside the database it creates; `postgres`
    // exists on every server.
    const adminEnv = { ...targetEnv, PGDATABASE: 'postgres' };
    const admin = async (sql: string) =>
      (await run('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], adminEnv, 'psql (target, admin)', secrets)).stdout.trim();
    const exists = await admin(`select count(*) from pg_database where datname = '${targetEnv.PGDATABASE.replace(/'/g, "''")}'`);
    if (exists === '1') {
      console.log(`[migrate] database ${targetEnv.PGDATABASE} already exists — not recreated`);
    } else {
      // template0, because template1's collation cannot be overridden.
      await admin(
        `create database "${dbName}" template template0 encoding 'UTF8' ` +
          `locale_provider icu icu_locale 'en-US' lc_collate 'en_US.utf8' lc_ctype 'en_US.utf8'`,
      );
      console.log(`[migrate] created database ${targetEnv.PGDATABASE} (UTF8, ICU en-US)`);
    }
  }
  const mark = await targetValue(`select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()`);

  if (args.has('--mark-live')) {
    await targetValue(`comment on database "${dbName}" is '${LIVE_MARK}'`);
    console.log(`[migrate] ${targetEnv.PGHOST}/${targetEnv.PGDATABASE} is marked LIVE. This script will no longer wipe it.`);
    return;
  }
  if (args.has('--unmark-live')) {
    await targetValue(`comment on database "${dbName}" is null`);
    console.log(`[migrate] ${targetEnv.PGHOST}/${targetEnv.PGDATABASE} is no longer marked live.`);
    return;
  }

  if (!source) throw new Error('SUPABASE_DB_URL is required — the Supabase session-pooler connection string');
  const sourceEnv = pgConnectionEnv(source);
  secrets.push(sourceEnv.PGPASSWORD);
  if (sourceEnv.PGHOST === targetEnv.PGHOST && sourceEnv.PGPORT === targetEnv.PGPORT) {
    throw new Error('Source and target are the same server');
  }

  // Provider and locale only: the OS-level collate/ctype names differ in
  // spelling between images (en_US.UTF-8, en_US.utf8) and mean the same thing.
  const COLLATION = `select datlocprovider::text || ':' || coalesce(datlocale, datcollate) from pg_database where datname = current_database()`;
  const sourceCollation = (await run('psql', ['-X', '-A', '-t', '-q', '-c', COLLATION], sourceEnv, 'psql (source)', secrets)).stdout.trim();
  const targetCollation = await targetValue(COLLATION);
  if (sourceCollation !== targetCollation && !args.has('--accept-collation')) {
    throw new Error(
      `The target database sorts text differently from the source (source ${sourceCollation}, target ${targetCollation}). ` +
        `Lists ordered by name would come back in a different order. Point RAILWAY_DB_URL at a new database name ` +
        `(e.g. …/mountainbakes) and run with --create-database, or pass --accept-collation to copy anyway.`,
    );
  }

  if (mark === LIVE_MARK) {
    throw new Error(
      `The target is marked LIVE — it is the production database now, and copying over it would destroy ` +
        `everything written since the cutover. If this really is a rollback, run with --unmark-live first.`,
    );
  }

  const existing = Number(await targetValue(
    `select count(*) from pg_tables where schemaname in ('public', 'app', 'auth', 'supabase_migrations')`,
  ));
  if (existing > 0 && !args.has('--reset-target')) {
    throw new Error(`The target already holds ${existing} table(s). Pass --reset-target to wipe that copy and copy again.`);
  }

  console.log(`[migrate] source  ${sourceEnv.PGHOST}/${sourceEnv.PGDATABASE}  (read only)`);
  console.log(`[migrate] target  ${targetEnv.PGHOST}:${targetEnv.PGPORT}/${targetEnv.PGDATABASE}${existing > 0 ? `  (${existing} tables — will be wiped)` : '  (empty)'}`);

  const work = await mkdtemp(path.join(os.tmpdir(), 'mb-migrate-'));
  const authDump = path.join(work, 'auth.dump');
  const mainDump = path.join(work, 'main.dump');
  const started = Date.now();

  try {
    // ── 1. dump ────────────────────────────────────────────────────────────
    // Dumped BEFORE the target is touched: if Supabase cannot be read, the
    // existing copy on Railway is still there.
    const common = ['--format=custom', '--compress=6', '--no-sync', '--no-publications', '--no-subscriptions'];
    console.log('[migrate] dumping auth …');
    await run('pg_dump', [
      ...common, '--schema=auth',
      ...AUTH_VOLATILE.map((t) => `--exclude-table-data=auth.${t}`),
      '--file', authDump,
    ], sourceEnv, 'pg_dump auth', secrets);
    console.log('[migrate] dumping public, app, supabase_migrations …');
    await run('pg_dump', [
      ...common, '--schema=public', '--schema=app', '--schema=supabase_migrations', '--file', mainDump,
    ], sourceEnv, 'pg_dump main', secrets);
    console.log(`[migrate] dumped: auth ${fmtBytes((await stat(authDump)).size)}, main ${fmtBytes((await stat(mainDump)).size)}`);

    // ── 2. empty the target ────────────────────────────────────────────────
    if (existing > 0) {
      console.log('[migrate] wiping the previous copy on the target …');
      await targetValue(`drop schema if exists public, app, auth, supabase_migrations cascade; create schema public;`);
    }

    // ── 3. roles, schemas, extensions ──────────────────────────────────────
    console.log('[migrate] bootstrap (roles, schemas, extensions) …');
    await psqlTarget(['-f', path.join(here, 'bootstrap.sql')], 'bootstrap.sql');

    // ── 4. restore ─────────────────────────────────────────────────────────
    // auth first, so public.users → auth.users resolves. Each restore is one
    // transaction that stops at the first error: a restore that half-worked
    // must not be mistaken for one that worked.
    const strict = ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname', targetEnv.PGDATABASE];
    console.log('[migrate] restoring auth …');
    await run('pg_restore', [...strict, authDump], targetEnv, 'pg_restore auth', secrets);

    // bootstrap.sql already made `public` and `app` (pg_trgm has to be in
    // public before the trigram indexes are built), so the archive's own
    // CREATE SCHEMA for those two is filtered out of the table of contents.
    const toc = path.join(work, 'main.toc');
    await run('pg_restore', ['--list', '--file', toc, mainDump], {}, 'pg_restore --list', secrets);
    const lines = (await readFile(toc, 'utf8')).split('\n');
    await writeFile(toc, lines.filter((l) => !/^\d+; \d+ \d+ SCHEMA - (public|app) /.test(l)).join('\n'));
    console.log('[migrate] restoring public, app, supabase_migrations …');
    await run('pg_restore', [...strict, '--use-list', toc, mainDump], targetEnv, 'pg_restore main', secrets);

    // ── 5. ownership and access ────────────────────────────────────────────
    console.log('[migrate] ownership and grants …');
    await psqlTarget(['-f', path.join(here, 'post-restore.sql')], 'post-restore.sql');
    await targetValue('analyze');

    const summary = await targetValue(
      `select 'public tables ' || (select count(*) from pg_tables where schemaname = 'public')
           || ', functions ' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and p.prokind in ('f', 'p'))
           || ', users ' || (select count(*) from auth.users)
           || ', migrations ' || (select count(*) from supabase_migrations.schema_migrations)`,
    );
    console.log(`[migrate] done in ${((Date.now() - started) / 1000).toFixed(0)}s — ${summary}`);
    console.log('[migrate] next: pnpm railway:verify');
  } finally {
    // The dumps hold every password hash in the company. They do not outlive the run.
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[migrate]', err instanceof Error ? err.message : err);
  process.exit(1);
});
