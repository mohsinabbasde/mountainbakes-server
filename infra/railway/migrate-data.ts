import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pgConnectionEnv } from '../../src/services/backup/postgresBackup';

/**
 * Copy the application's database from Supabase to Railway.
 *
 *   pnpm railway:migrate --create-database create the target database, then copy
 *   pnpm railway:migrate                   first copy into an EMPTY target
 *   pnpm railway:migrate --reset-target    wipe the target's copy and copy again
 *   pnpm railway:migrate --from-dump <file> copy from a backup archive instead of from Supabase
 *   pnpm railway:migrate --mark-live       the target is now production; refuse to wipe it
 *   pnpm railway:migrate --unmark-live     undo --mark-live (a rollback)
 *
 * READS the source, WRITES the target. Nothing here can alter Supabase: the
 * only thing run against it is pg_dump.
 *
 * WHAT IS COPIED
 *   public, app     everything the application owns: every table and every
 *                   row, the functions, the triggers, the types, the indexes
 *
 * WHAT IS NOT, and why
 *   auth            Supabase Auth's schema. Accounts now live in `public`
 *                   (users, user_credentials — the password hashes were copied
 *                   there by migration 149), and the API signs people in
 *                   itself.
 *   row-level security, and its policies
 *                   written for browsers that reached the database through
 *                   Supabase's REST endpoint. Nothing reaches this one but the
 *                   API. See post-restore.sql.
 *   users.id → auth.users
 *                   the one foreign key out of `public` into `auth`.
 *   supabase_migrations
 *                   the Supabase CLI's record of which migrations ran. From
 *                   here on that record is Prisma's (`pnpm db:baseline`).
 *   storage, vault, realtime, graphql
 *                   Supabase platform schemas. Files are moved by
 *                   `pnpm files:copy`; the rest is not used.
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
 * `--from-dump <file>` restores a main archive written by the backup system
 * (`pnpm backup:manual`, downloaded from S3) through exactly the same steps, in
 * place of a fresh dump. Supabase is then not read for the data at all, so the
 * target ends up as the database was WHEN THAT BACKUP WAS TAKEN — anything
 * written since is not in it. The archive is left where it is.
 *
 * Passwords travel in the libpq environment, never in argv, so they do not show
 * in `ps` — the same care services/backup/postgresBackup.ts takes.
 */

const LIVE_MARK = 'mountainbakes:live';

/**
 * Entries of the archive's table of contents that are not restored. Matched
 * against `pg_restore --list` lines, which read
 * `<id>; <catalog oid> <object oid> <TYPE> <schema> <name…> <owner>`.
 */
const NOT_RESTORED: RegExp[] = [
  // bootstrap.sql already made these two (pg_trgm has to be in public before
  // the trigram indexes are built).
  /^\d+; \d+ \d+ SCHEMA - (public|app) /,
  /^\d+; \d+ \d+ POLICY /,
  /^\d+; \d+ \d+ ROW SECURITY /,
  /^\d+; \d+ \d+ FK CONSTRAINT public users users_id_fkey /,
  // Only in a backup archive (--from-dump): the Supabase CLI's migration record.
  /^\d+; \d+ \d+ SCHEMA - supabase_migrations /,
  /^\d+; \d+ \d+ [A-Z ]+ supabase_migrations /,
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
  const fromDumpAt = process.argv.indexOf('--from-dump');
  const fromDump = fromDumpAt >= 0 ? path.resolve(process.argv[fromDumpAt + 1] ?? '') : null;
  if (fromDump && !(await stat(fromDump).catch(() => null))?.isFile()) {
    throw new Error(`--from-dump: ${fromDump} is not a file`);
  }
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

  if (!source) {
    // Still read with --from-dump, though not for the data: it is what the
    // target's collation is compared with.
    throw new Error('SUPABASE_DB_URL is required — the Supabase session-pooler connection string');
  }
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

  // After this copy, the only passwords there are, are the ones in
  // public.user_credentials. A source where that table is missing or behind is
  // a target nobody can sign in to — found out now, not on the morning after.
  // (With --from-dump the same question is put to the archive, below.)
  const sourceValue = async (sql: string) =>
    (await run('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], sourceEnv, 'psql (source)', secrets)).stdout.trim();
  if (!fromDump && (await sourceValue(`select to_regclass('public.user_credentials') is not null`)) !== 't') {
    throw new Error('The source has no public.user_credentials table — migration 149 (custom auth) has not been applied to it.');
  }
  // Compared with Supabase Auth's copy while the source still has one.
  const hasAuth = !fromDump && (await sourceValue(`select to_regclass('auth.users') is not null`)) === 't';
  const stale = fromDump ? 0 : Number(await sourceValue(
    hasAuth
      ? `select count(*) from public.users u
           left join public.user_credentials c on c.user_id = u.id
           left join auth.users a on a.id = u.id
          where c.user_id is null or c.password_hash is distinct from a.encrypted_password`
      : `select count(*) from public.users u
          where not exists (select 1 from public.user_credentials c where c.user_id = u.id)`,
  ));
  if (stale > 0 && !args.has('--accept-stale-passwords')) {
    throw new Error(
      `${stale} account(s) have no password in public.user_credentials, or one that differs from Supabase Auth's. ` +
        `They could not sign in after the move with the password they use today. Re-run the import at the end of ` +
        `migration 149 (the "Carry the existing passwords over" block) and try again, or pass --accept-stale-passwords ` +
        `if the API's own sign-in is already the one in use and Supabase Auth's copy is the stale one.`,
    );
  }

  console.log(fromDump
    ? `[migrate] source  ${fromDump}  (a backup archive)`
    : `[migrate] source  ${sourceEnv.PGHOST}/${sourceEnv.PGDATABASE}  (read only)`);
  console.log(`[migrate] target  ${targetEnv.PGHOST}:${targetEnv.PGPORT}/${targetEnv.PGDATABASE}${existing > 0 ? `  (${existing} tables — will be wiped)` : '  (empty)'}`);

  const work = await mkdtemp(path.join(os.tmpdir(), 'mb-migrate-'));
  const mainDump = fromDump ?? path.join(work, 'main.dump');
  const started = Date.now();

  try {
    // ── 1. dump ────────────────────────────────────────────────────────────
    // Dumped BEFORE the target is touched: if Supabase cannot be read, the
    // existing copy on Railway is still there.
    if (!fromDump) {
      console.log('[migrate] dumping public, app …');
      await run('pg_dump', [
        '--format=custom', '--compress=6', '--no-sync', '--no-publications', '--no-subscriptions',
        '--schema=public', '--schema=app', '--file', mainDump,
      ], sourceEnv, 'pg_dump', secrets);
      console.log(`[migrate] dumped: ${fmtBytes((await stat(mainDump)).size)}`);
    }

    // What the archive holds, read BEFORE the target is touched for the same
    // reason: an archive that cannot be read, or that predates the API's own
    // sign-in, must not cost the copy that is already there.
    const toc = path.join(work, 'main.toc');
    await run('pg_restore', ['--list', '--file', toc, mainDump], {}, 'pg_restore --list', secrets);
    const lines = (await readFile(toc, 'utf8')).split('\n');
    if (!lines.some((l) => /^\d+; \d+ \d+ TABLE DATA public user_credentials /.test(l))) {
      throw new Error('The archive has no public.user_credentials — it was taken before migration 149 (custom auth). Nobody could sign in to a copy made from it.');
    }

    // ── 2. empty the target ────────────────────────────────────────────────
    if (existing > 0) {
      console.log('[migrate] wiping the previous copy on the target …');
      await targetValue(`drop schema if exists public, app, auth, supabase_migrations cascade; create schema public;`);
    }

    // ── 3. roles, schemas, extensions ──────────────────────────────────────
    console.log('[migrate] bootstrap (roles, schemas, extensions) …');
    await psqlTarget(['-f', path.join(here, 'bootstrap.sql')], 'bootstrap.sql');

    // ── 4. restore ─────────────────────────────────────────────────────────
    // One transaction that stops at the first error: a restore that
    // half-worked must not be mistaken for one that worked.
    const kept = lines.filter((l) => !NOT_RESTORED.some((re) => re.test(l)));
    await writeFile(toc, kept.join('\n'));
    console.log(`[migrate] restoring public, app (${lines.length - kept.length} Supabase-only entries left out) …`);
    await run('pg_restore', [
      '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error',
      '--dbname', targetEnv.PGDATABASE, '--use-list', toc, mainDump,
    ], targetEnv, 'pg_restore', secrets);

    // ── 5. access ──────────────────────────────────────────────────────────
    console.log('[migrate] access …');
    await psqlTarget(['-f', path.join(here, 'post-restore.sql')], 'post-restore.sql');
    await targetValue('analyze');

    const summary = await targetValue(
      `select 'public tables ' || (select count(*) from pg_tables where schemaname = 'public')
           || ', functions ' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and p.prokind in ('f', 'p'))
           || ', users ' || (select count(*) from public.users)
           || ', with a password ' || (select count(*) from public.user_credentials)`,
    );
    console.log(`[migrate] done in ${((Date.now() - started) / 1000).toFixed(0)}s — ${summary}`);
    console.log('[migrate] next: pnpm railway:verify, then pnpm railway:role');
  } finally {
    // The dump holds every password hash in the company. It does not outlive
    // the run. (An archive handed in with --from-dump is not in `work`, and is
    // the caller's to keep or delete.)
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[migrate]', err instanceof Error ? err.message : err);
  process.exit(1);
});
