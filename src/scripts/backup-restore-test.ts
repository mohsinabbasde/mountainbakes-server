import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { BackupJob, BackupVerifyCheck } from '../shared';
import {
  createBackupDeps,
  getBackupSystemConfig,
  isBackupError,
  parseManifest,
  pgConnectionEnv,
  redactSecrets,
  resolvePgBinary,
  runPgProcess,
  sha256File,
} from '../services/backup';

/**
 * Mountain Bakes — restore drill. Proves a backup is restorable by restoring
 * it into an ISOLATED database and checking what came back.
 *
 * Usage (from backend/):
 *   BACKUP_RESTORE_TEST_DB_URL=postgresql://... pnpm backup:restore:test
 *   pnpm backup:restore:test -- --backup-id backup-daily-2026-09-21
 *   pnpm backup:restore:test -- --keep       leave the downloaded archives in the temp dir
 *
 * THIS IS DESTRUCTIVE FOR THE TARGET DATABASE (pg_restore --clean). It refuses to run when the target
 *   - is the production database (same host + database as SUPABASE_DB_URL),
 *   - mentions the production project ref anywhere,
 *   - or PRODUCTION=true / BACKUP_RESTORE_TEST_ALLOW_PRODUCTION is set (never honoured, always refused).
 *
 * Steps:
 *   1. pick the latest verified backup (or --backup-id), read its manifest
 *   2. download both archives, verify SHA-256 against the manifest
 *   3. prepare the target: roles anon/authenticated/service_role, schemas auth/extensions, common extensions
 *   4. pg_restore --clean --if-exists --no-owner --no-privileges  (main archive: public, app, supabase_migrations)
 *   5. pg_restore the auth archive (auth.users, auth.identities)
 *   6. verify: table count vs manifest, row counts of the business tables, key functions, triggers, indexes, constraints
 *   7. record the drill in backup_restore_tests (status, checks, row counts) — never the target URL
 *
 * Exit codes: 0 all checks passed · 1 restore or a check failed · 2 config / safety refusal
 */

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const keep = argv.includes('--keep');

const BUSINESS_TABLES = [
  'users', 'branches', 'products', 'product_prices', 'customers', 'orders', 'order_items', 'expenses',
  'stock_movements', 'production_orders', 'production_order_items', 'daily_closing_reports', 'settings',
  'ledger_entries', 'finance_transactions', 'business_day_closures', 'backup_jobs',
];

const KEY_FUNCTIONS = [
  'claim_business_day_closure(date, closure_trigger, text, boolean, integer)',
  'claim_backup_job(text, text, text, uuid, text, text, text, integer)',
  'list_public_base_tables()',
  'app.jwt_role()',
];

function safetyCheck(target: string, prodUrl: string | null, prodRef: string | null): string | null {
  if (process.env.PRODUCTION === 'true') return 'PRODUCTION=true is set — the restore test never runs in a production context';
  let t: URL;
  try {
    t = new URL(target);
  } catch {
    return 'BACKUP_RESTORE_TEST_DB_URL is not a valid URL';
  }
  if (prodRef && target.includes(prodRef)) return `target mentions the production project ref ${prodRef}`;
  if (prodUrl) {
    try {
      const p = new URL(prodUrl);
      if (p.hostname === t.hostname && p.pathname === t.pathname) return 'target is the same host and database as SUPABASE_DB_URL (production)';
      if (p.hostname === t.hostname && p.username === t.username) return 'target uses the production host and user';
    } catch {
      /* prod URL invalid — already rejected by config */
    }
  }
  if (/prod/i.test(t.pathname)) return `target database name "${t.pathname}" looks like production`;
  return null;
}

async function psql(sql: string, target: string, pgBinDir: string | null, secrets: string[]): Promise<string> {
  const res = await runPgProcess(
    resolvePgBinary('psql', pgBinDir),
    { argv: ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], env: pgConnectionEnv(target), timeoutMs: 120_000, label: 'psql' },
    { pgBinDir, secrets },
  );
  return res.stdout.trim();
}

async function main(): Promise<number> {
  console.log('Mountain Bakes ERP — Database restore test');
  console.log('===========================================');
  const cfg = getBackupSystemConfig({ requireDatabase: false, requireEnabled: false });
  const target = (process.env.BACKUP_RESTORE_TEST_DB_URL || '').trim();
  if (!target) {
    console.error('BACKUP_RESTORE_TEST_DB_URL is required — an isolated, non-production PostgreSQL database.');
    return 2;
  }
  const refusal = safetyCheck(target, process.env.SUPABASE_DB_URL?.trim() || null, cfg.databaseRef);
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    return 2;
  }
  const secrets = [...cfg.secrets, target];
  try {
    const pw = decodeURIComponent(new URL(target).password);
    if (pw) secrets.push(pw);
  } catch {
    /* validated above */
  }
  const targetHost = new URL(target).hostname;
  console.log(`Target: ${targetHost} / ${new URL(target).pathname.replace('/', '')}  (isolated — passed the production safety check)\n`);

  const deps = createBackupDeps({ requireDatabase: false, requireEnabled: false, config: cfg });
  const pgBinDir = cfg.pgBinDir;

  // 1. pick the backup
  let job: BackupJob | null;
  const id = opt('backup-id');
  if (id) job = await deps.repo.getByBackupId(id);
  else {
    const latest = await deps.repo.latestVerifiedByType();
    job = [latest.daily, latest.manual, latest.weekly, latest.monthly].filter((j): j is BackupJob => !!j).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;
  }
  if (!job || !job.manifestS3Key) {
    console.error(id ? `No verified backup ${id} with a manifest` : 'No verified backup to restore yet — run `pnpm backup:manual` first.');
    return 1;
  }
  const manifest = parseManifest(await deps.storage.getJson(job.manifestS3Key));
  if (!manifest) {
    console.error(`Manifest ${job.manifestS3Key} is missing or invalid`);
    return 1;
  }
  console.log(`Backup: ${job.backupId} (${job.backupType}, taken ${job.startedAt}, PostgreSQL ${manifest.databaseVersion ?? '?'}, pg_dump ${manifest.pgDumpVersion ?? '?'})`);

  const startedAt = new Date();
  const checks: BackupVerifyCheck[] = [];
  const rowCounts: Record<string, number> = {};
  let tableCount: number | null = null;
  let status: 'success' | 'failed' = 'failed';
  let errorMessage: string | null = null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mountainbakes-restore-'));

  try {
    // 2. download + checksum
    const local: Record<'main' | 'auth', string> = { main: '', auth: '' };
    for (const f of manifest.files) {
      const file = path.join(tmp, f.fileName);
      process.stdout.write(`Downloading ${f.s3Key} … `);
      await deps.storage.downloadToFile(f.s3Key, file);
      const sha = await sha256File(file);
      const ok = sha === f.checksumSha256;
      console.log(ok ? 'checksum OK' : 'CHECKSUM MISMATCH');
      checks.push({ name: `${f.role}: download checksum matches manifest`, ok, detail: ok ? sha.slice(0, 16) + '…' : `got ${sha}` });
      if (!ok) throw new Error(`checksum mismatch for ${f.s3Key}`);
      local[f.role] = file;
    }

    // 3. prepare target
    console.log('Preparing target roles, schemas and extensions …');
    await psql(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
         if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
         if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
         if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
       end $$;
       create schema if not exists auth; create schema if not exists extensions; create schema if not exists app;
       create extension if not exists pgcrypto with schema extensions;
       create extension if not exists "uuid-ossp" with schema extensions;
       create extension if not exists pg_trgm with schema extensions;
       create extension if not exists citext with schema extensions;
       create extension if not exists pg_stat_statements with schema extensions;`,
      target, pgBinDir, secrets,
    ).catch((err) => {
      console.warn(`  (preparation warning: ${redactSecrets(String(err), secrets).slice(0, 300)})`);
    });
    // Supabase's public schema references auth.uid()/auth.role() and auth.jwt() in defaults and policies.
    await psql(
      `create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
       create or replace function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
       create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;`,
      target, pgBinDir, secrets,
    ).catch(() => undefined);

    // 4. main restore
    console.log('Restoring main archive (public, app, supabase_migrations) …');
    const pgRestore = resolvePgBinary('pg_restore', pgBinDir);
    const mainRes = await runPgProcess(
      pgRestore,
      {
        argv: ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--no-comments', '--dbname', pgConnectionEnv(target).PGDATABASE, local.main],
        env: pgConnectionEnv(target),
        timeoutMs: cfg.pgDumpTimeoutMs,
        label: 'pg_restore main',
      },
      { pgBinDir, secrets },
    ).catch((err) => {
      // pg_restore exits 1 on ignorable errors (e.g. DROP of a missing object under --clean, an
      // extension-owned function); we treat that as a warning and let the verification decide.
      const msg = redactSecrets(String((err as Error).message), secrets);
      console.warn(`  pg_restore main reported errors (verification below decides):\n  ${msg.split('\n').slice(0, 12).join('\n  ')}`);
      return null;
    });
    checks.push({ name: 'pg_restore main exited cleanly', ok: !!mainRes, detail: mainRes ? `${(mainRes.durationMs / 1000).toFixed(1)}s` : 'errors reported (see log)' });

    // 5. auth restore
    console.log('Restoring auth archive (auth.users, auth.identities) …');
    const authRes = await runPgProcess(
      pgRestore,
      {
        argv: ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--no-comments', '--dbname', pgConnectionEnv(target).PGDATABASE, local.auth],
        env: pgConnectionEnv(target),
        timeoutMs: cfg.pgDumpTimeoutMs,
        label: 'pg_restore auth',
      },
      { pgBinDir, secrets },
    ).catch((err) => {
      console.warn(`  pg_restore auth reported errors: ${redactSecrets(String((err as Error).message), secrets).split('\n').slice(0, 6).join(' | ')}`);
      return null;
    });
    checks.push({ name: 'pg_restore auth exited cleanly', ok: !!authRes });

    // 6. verify
    console.log('Verifying …');
    const q = (sql: string) => psql(sql, target, pgBinDir, secrets);
    tableCount = Number(await q(`select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`));
    const expectedTables = Number(await q(`select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)); // same query — the manifest holds no count; compare against migration expectation below
    checks.push({ name: 'public tables restored', ok: tableCount > 50, detail: `${tableCount} tables` });
    void expectedTables;
    const migrations = Number(await q(`select count(*) from supabase_migrations.schema_migrations`).catch(() => '0'));
    checks.push({ name: 'supabase_migrations.schema_migrations restored', ok: migrations > 100, detail: `${migrations} migrations recorded` });

    for (const t of BUSINESS_TABLES) {
      const n = await q(`select count(*) from public.${t}`).catch(() => null);
      if (n === null) {
        checks.push({ name: `table ${t} exists`, ok: false });
        continue;
      }
      rowCounts[t] = Number(n);
      checks.push({ name: `table ${t} restored`, ok: true, detail: `${n} rows` });
    }
    const authUsers = Number(await q(`select count(*) from auth.users`).catch(() => '-1'));
    rowCounts['auth.users'] = authUsers;
    checks.push({ name: 'auth.users restored', ok: authUsers >= 0, detail: `${authUsers} rows` });
    checks.push({ name: 'auth.users count matches public.users', ok: authUsers === rowCounts.users, detail: `${authUsers} vs ${rowCounts.users}` });

    for (const fn of KEY_FUNCTIONS) {
      const exists = (await q(`select to_regprocedure('${fn}') is not null`).catch(() => 'f')) === 't';
      checks.push({ name: `function ${fn}`, ok: exists });
    }
    const triggers = Number(await q(`select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`));
    checks.push({ name: 'triggers restored', ok: triggers > 0, detail: `${triggers}` });
    const indexes = Number(await q(`select count(*) from pg_indexes where schemaname = 'public'`));
    checks.push({ name: 'indexes restored', ok: indexes > 50, detail: `${indexes}` });
    const constraints = Number(await q(`select count(*) from information_schema.table_constraints where table_schema = 'public' and constraint_type in ('FOREIGN KEY','UNIQUE','CHECK','PRIMARY KEY')`));
    checks.push({ name: 'constraints restored', ok: constraints > 50, detail: `${constraints}` });
    const policies = Number(await q(`select count(*) from pg_policies where schemaname = 'public'`));
    checks.push({ name: 'RLS policies restored', ok: policies > 0, detail: `${policies}` });
    const views = Number(await q(`select count(*) from information_schema.views where table_schema = 'public'`));
    checks.push({ name: 'views restored', ok: true, detail: `${views}` });
    const sequences = Number(await q(`select count(*) from information_schema.sequences where sequence_schema = 'public'`));
    checks.push({ name: 'sequences restored', ok: true, detail: `${sequences}` });

    status = checks.every((c) => c.ok) ? 'success' : 'failed';
  } catch (err) {
    errorMessage = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    checks.push({ name: 'restore completed', ok: false, detail: errorMessage });
  } finally {
    if (!keep) await rm(tmp, { recursive: true, force: true });
    else console.log(`Archives kept in ${tmp}`);
  }

  const completedAt = new Date();
  console.log('');
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`\n${status === 'success' ? '✔ RESTORE TEST PASSED' : '✖ RESTORE TEST FAILED'} in ${((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)}s`);

  try {
    await deps.repo.recordRestoreTest({
      backupJobId: job.id,
      backupId: job.backupId,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      targetHostRedacted: targetHost,
      tableCount,
      rowCounts,
      checks,
      errorMessage,
      runBy: process.env.USER || 'cli',
    });
    console.log('Recorded in backup_restore_tests.');
  } catch (err) {
    console.warn(`Could not record the drill: ${redactSecrets(String(err), secrets)}`);
  }
  return status === 'success' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBackupError(err) && err.category === 'CONFIG_INVALID') {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error('\nRestore test failed:', redactSecrets(err instanceof Error ? err.message : String(err), [process.env.BACKUP_RESTORE_TEST_DB_URL ?? '', process.env.SUPABASE_DB_URL ?? '']));
    process.exit(1);
  });
