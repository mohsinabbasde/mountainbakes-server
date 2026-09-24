import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createBackupDeps,
  getBackupSystemConfig,
  isBackupError,
  pgConnectionEnv,
  redactSecrets,
  resolvePgBinary,
  runBackup,
  runPgProcess,
  sha256File,
  verifyBackup,
} from '../services/backup';

/**
 * Mountain Bakes — backup integration test. A REAL end-to-end run against a
 * throwaway S3 prefix, then cleaned up:
 *
 *   dump (pg_dump) → upload → HeadObject verify → manifest → ledger row →
 *   re-verify from S3 → download → SHA-256 → `pg_restore --list` (archive is
 *   readable and contains the expected objects) → delete the test objects and
 *   the backup_jobs row.
 *
 * Usage (from backend/):
 *   pnpm backup:integration
 *
 * Forces BACKUP_S3_PREFIX=database-backups-test so nothing touches the real
 * database-backups/ tree (that prefix is also where the IAM policy allows
 * s3:DeleteObject for a dev/test user). Refuses to run with NODE_ENV=production.
 *
 * Exit codes: 0 pass · 1 fail · 2 config
 */

const TEST_PREFIX = 'database-backups-test';

async function main(): Promise<number> {
  console.log('Mountain Bakes ERP — Backup integration test');
  console.log('=============================================');
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run the integration test with NODE_ENV=production.');
    return 2;
  }
  process.env.BACKUP_S3_PREFIX = TEST_PREFIX;
  const cfg = getBackupSystemConfig();
  const deps = createBackupDeps({ config: cfg });
  console.log(`Bucket s3://${cfg.bucket}/${cfg.prefix}/  (test prefix)\n`);

  const fails: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fails.push(name);
  };

  // 1. real run
  const res = await runBackup('manual', { trigger: 'manual', force: true, triggeredByName: 'integration-test' }, deps);
  check('backup run succeeded', res.outcome === 'success', res.outcome === 'failed' ? `${res.category}: ${res.message}` : res.outcome);
  if (res.outcome !== 'success') return 1;
  const job = res.job!;
  const keys = [res.plan.mainKey, res.plan.authKey, res.plan.manifestKey];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mb-integration-'));
  try {
    // 2. objects + ledger
    for (const k of keys) check(`object exists ${k}`, !!(await deps.storage.head(k)));
    check('ledger row verified', job.status === 'verified', job.status);
    check('ledger has sha256 + size', !!job.checksumSha256 && !!job.fileSize && job.fileSize > 0);

    // 3. independent re-verification
    const v = await verifyBackup(job, deps);
    check('verifyBackup passes', v.ok, `${v.checks.filter((c) => c.ok).length}/${v.checks.length}`);

    // 4. download + checksum + archive readability
    const local = path.join(tmp, res.plan.mainFileName);
    await deps.storage.downloadToFile(res.plan.mainKey, local);
    const sha = await sha256File(local);
    check('downloaded main sha256 matches ledger', sha === job.checksumSha256);
    const listing = await runPgProcess(
      resolvePgBinary('pg_restore', cfg.pgBinDir),
      { argv: ['--list', local], env: {}, timeoutMs: 60_000, label: 'pg_restore --list' },
      { pgBinDir: cfg.pgBinDir, secrets: cfg.secrets },
    );
    const toc = listing.stdout;
    check('archive lists TABLE public.orders', /TABLE public orders /.test(toc) || /TABLE public orders\b/.test(toc));
    check('archive lists FUNCTION claim_business_day_closure', /claim_business_day_closure/.test(toc));
    check('archive lists schema app objects', /\bapp\b/.test(toc));
    check('archive lists supabase_migrations', /supabase_migrations/.test(toc));
    const authLocal = path.join(tmp, res.plan.authFileName);
    await deps.storage.downloadToFile(res.plan.authKey, authLocal);
    const authToc = await runPgProcess(
      resolvePgBinary('pg_restore', cfg.pgBinDir),
      { argv: ['--list', authLocal], env: {}, timeoutMs: 60_000, label: 'pg_restore --list auth' },
      { pgBinDir: cfg.pgBinDir, secrets: cfg.secrets },
    );
    check('auth archive lists auth.users + auth.identities', /TABLE auth users/.test(authToc.stdout) && /TABLE auth identities/.test(authToc.stdout));
    void pgConnectionEnv; // (kept for parity with restore test; connection env is built inside runPgDump)
  } finally {
    await rm(tmp, { recursive: true, force: true });
    // 5. cleanup test objects + row
    for (const k of keys) {
      try {
        await deps.storage.deleteObject(k);
        console.log(`  cleaned ${k}`);
      } catch (err) {
        console.warn(`  could not delete ${k}: ${redactSecrets(String(err), cfg.secrets)} (dev credentials need s3:DeleteObject on ${TEST_PREFIX}/*)`);
      }
    }
    try {
      const { supabaseAdmin } = await import('../config/supabase');
      await supabaseAdmin.from('backup_jobs').delete().eq('backup_id', job.backupId);
      console.log(`  cleaned backup_jobs row ${job.backupId}`);
    } catch (err) {
      console.warn(`  could not delete the ledger row: ${redactSecrets(String(err), cfg.secrets)}`);
    }
  }
  console.log(fails.length === 0 ? '\n✔ INTEGRATION TEST PASSED' : `\n✖ INTEGRATION TEST FAILED: ${fails.join('; ')}`);
  return fails.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBackupError(err) && err.category === 'CONFIG_INVALID') {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error('\nIntegration test failed:', redactSecrets(err instanceof Error ? err.message : String(err), [process.env.SUPABASE_DB_URL ?? '']));
    process.exit(1);
  });
