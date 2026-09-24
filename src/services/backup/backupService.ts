import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BackupJob, BackupManifest, BackupManifestFile, BackupTrigger, BackupType, BackupVerifyCheck, BackupVerifyResult } from '../../shared';
import type { BackupSystemConfig } from './backupConfig';
import { redactSecrets } from './backupConfig';
import { BackupError, categorize, errorMessage, isBackupError } from './errors';
import { buildBackupPlan, isDue, type BackupPlan } from './backupNaming';
import { compareObject, fileSize, sha256File } from './backupIntegrity';
import { buildManifest, parseManifest } from './backupManifest';
import { acquireBackupLock, type BackupLockHandle } from './backupLock';
import type { BackupRepository } from './backupRepository';
import type { BackupStorage } from './s3BackupStorage';
import { AUTH_TABLES, MAIN_SCHEMAS, getPgDumpVersion, probeConnection, runPgDump, type PgDeps } from './postgresBackup';
import type { FailureAlert } from './backupAlerts';

/**
 * The backup run, end to end:
 *
 *   isDue? → claim lock → duplicate check → temp dir → pg_dump version →
 *   connection probe → dump MAIN → dump AUTH → SHA-256 both → upload both →
 *   HeadObject both (size + sha metadata) → write manifest → HeadObject manifest
 *   → release lock as VERIFIED → delete temp dir
 *
 * Any failure → release lock as FAILED (category + redacted message) → alert →
 * delete temp dir → rethrow. A backup is never marked successful before the
 * uploaded objects have been read back from S3 and compared.
 */

export interface DatabaseInfo {
  serverVersion: string | null;
  databaseName: string | null;
  sizeBytes: number | null;
  publicTableCount: number | null;
}

export interface BackupDeps {
  config: BackupSystemConfig;
  storage: BackupStorage;
  repo: BackupRepository;
  pg: PgDeps;
  now: () => Date;
  log: (line: string) => void;
  alert: (alert: FailureAlert) => Promise<void>;
  /** Server version + size via the backup_database_info RPC; null-safe. */
  databaseInfo: () => Promise<DatabaseInfo>;
  signal?: AbortSignal;
  /** Test seam: wait between connection retries. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  trigger: BackupTrigger;
  force?: boolean;
  triggeredBy?: string | null;
  triggeredByName?: string | null;
}

export type BackupRunResult =
  | { outcome: 'success'; backupId: string; job: BackupJob | null; plan: BackupPlan; durationMs: number }
  | { outcome: 'not_due' | 'already_completed' | 'in_progress'; backupId: string; reason: string }
  | { outcome: 'failed'; backupId: string; category: string; message: string };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function cleanupTemp(dir: string | null, log: (l: string) => void): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log(`[backup] WARNING: could not remove temp dir ${dir}: ${errorMessage(err)}`);
  }
}

/**
 * Same-key duplicate protection. If the manifest for this backup_id exists
 * and both objects match it byte-for-byte (size + sha256 metadata), the
 * earlier run completed and this one is a no-op. Anything less — no manifest,
 * a missing object, a size or checksum mismatch — is a partial/corrupt
 * earlier attempt and is replaced by this run's verified upload.
 */
async function findCompletedDuplicate(plan: BackupPlan, deps: BackupDeps): Promise<BackupManifest | null> {
  const manifest = parseManifest(await deps.storage.getJson(plan.manifestKey));
  if (!manifest) return null;
  for (const f of manifest.files) {
    const head = await deps.storage.head(f.s3Key);
    const checks = compareObject(head, { size: f.fileSize, sha256: f.checksumSha256 }, f.role);
    if (!checks.every((c) => c.ok)) return null;
  }
  return manifest;
}

async function withConnectionRetry<T>(fn: () => Promise<T>, label: string, deps: BackupDeps): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isBackupError(err) && err.retryable && !deps.signal?.aborted) {
      deps.log(`[backup] ${label}: ${err.message} — retrying once in 5s`);
      await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(5000);
      return fn();
    }
    throw err;
  }
}

export async function runBackup(type: BackupType, opts: RunOptions, deps: BackupDeps): Promise<BackupRunResult> {
  const { config, log } = deps;
  const startedAt = deps.now();

  const due = isDue(type, startedAt);
  const plan = buildBackupPlan(type, startedAt, config);
  if (!due.due && !opts.force) {
    log(`[backup] ${type} not due: ${due.reason}`);
    return { outcome: 'not_due', backupId: plan.backupId, reason: due.reason };
  }

  log(`[backup] ${type} started — ${plan.backupId} → s3://${config.bucket}/${plan.mainKey}`);

  const acquired = await acquireBackupLock(deps.repo, {
    backupId: plan.backupId,
    backupType: type,
    trigger: opts.trigger,
    triggeredBy: opts.triggeredBy ?? null,
    triggeredByName: opts.triggeredByName ?? null,
    s3Bucket: config.bucket,
    environment: config.environment,
    staleMs: config.staleLockMs,
  });
  if (acquired.result === 'in_progress') {
    log(`[backup] ${type} skipped: another ${type} backup is still running (lock held)`);
    return { outcome: 'in_progress', backupId: plan.backupId, reason: `a ${type} backup is already running` };
  }
  if (acquired.result !== 'claimed') {
    log(`[backup] ${type} skipped: ${plan.backupId} already completed and verified`);
    return { outcome: 'already_completed', backupId: plan.backupId, reason: `${plan.backupId} was already completed` };
  }
  const lock: BackupLockHandle = acquired.lock;

  let tmpDir: string | null = null;
  let attempts = 1;
  try {
    // Duplicate protection against the objects themselves, not just the ledger.
    const dup = await findCompletedDuplicate(plan, deps);
    if (dup) {
      const main = dup.files.find((f) => f.role === 'main');
      const auth = dup.files.find((f) => f.role === 'auth');
      await lock.release({
        status: 'verified',
        completedAt: deps.now().toISOString(),
        durationMs: deps.now().getTime() - startedAt.getTime(),
        s3Key: main?.s3Key ?? plan.mainKey,
        authS3Key: auth?.s3Key ?? null,
        manifestS3Key: plan.manifestKey,
        fileSize: main?.fileSize ?? null,
        authFileSize: auth?.fileSize ?? null,
        checksumSha256: main?.checksumSha256 ?? null,
        authChecksumSha256: auth?.checksumSha256 ?? null,
        retentionUntil: dup.retentionUntil,
        pgDumpVersion: dup.pgDumpVersion,
        databaseVersion: dup.databaseVersion,
        appVersion: dup.appVersion,
        lastVerifiedAt: deps.now().toISOString(),
        errorCategory: null,
        errorMessage: 'already completed by an earlier run; objects re-verified',
      });
      log(`[backup] ${type} already completed: ${plan.mainKey} exists and matches its manifest — nothing uploaded`);
      return { outcome: 'already_completed', backupId: plan.backupId, reason: 'objects already exist and verify against their manifest' };
    }

    await mkdir(config.tmpDir, { recursive: true });
    tmpDir = await mkdtemp(path.join(config.tmpDir, `${plan.backupId}-`));
    const mainFile = path.join(tmpDir, plan.mainFileName);
    const authFile = path.join(tmpDir, plan.authFileName);

    const pgDumpVersion = await getPgDumpVersion(deps.pg);
    log(`[backup] pg_dump ${pgDumpVersion}`);
    const info = await deps.databaseInfo();
    if (info.serverVersion) log(`[backup] server PostgreSQL ${info.serverVersion}, database size ${info.sizeBytes !== null ? fmtBytes(info.sizeBytes) : 'unknown'}`);

    if (!config.dbUrl) throw new BackupError('CONFIG_INVALID', 'SUPABASE_DB_URL is not set');
    const dbUrl = config.dbUrl;
    const probe = await withConnectionRetry(() => probeConnection(dbUrl, tmpDir!, deps.pg), 'connection probe', deps);
    log(`[backup] database connectivity OK (${probe.durationMs}ms)`);

    const dumpStart = Date.now();
    const main = await withConnectionRetry(
      () => runPgDump({ dbUrl, outFile: mainFile, schemas: MAIN_SCHEMAS, timeoutMs: config.pgDumpTimeoutMs, signal: deps.signal }, deps.pg),
      'main dump',
      deps,
    );
    log(`[backup] pg_dump main completed in ${(main.durationMs / 1000).toFixed(1)}s — ${fmtBytes(main.bytes)} (schemas: ${MAIN_SCHEMAS.join(', ')})`);
    const auth = await withConnectionRetry(
      () => runPgDump({ dbUrl, outFile: authFile, tables: AUTH_TABLES, timeoutMs: config.pgDumpTimeoutMs, signal: deps.signal }, deps.pg),
      'auth dump',
      deps,
    );
    log(`[backup] pg_dump auth completed in ${(auth.durationMs / 1000).toFixed(1)}s — ${fmtBytes(auth.bytes)} (tables: ${AUTH_TABLES.join(', ')})`);
    const dumpMs = Date.now() - dumpStart;

    const [mainSha, authSha, mainSize, authSize] = await Promise.all([sha256File(mainFile), sha256File(authFile), fileSize(mainFile), fileSize(authFile)]);
    if (mainSize === 0 || authSize === 0) throw new BackupError('DUMP_EMPTY', 'a dump file is empty');
    log(`[backup] checksum calculated — main sha256 ${mainSha.slice(0, 16)}…, auth sha256 ${authSha.slice(0, 16)}…`);

    const uploadStart = Date.now();
    const uploadMeta = { backupId: plan.backupId, backupType: type, retentionUntil: plan.retentionUntil, signal: deps.signal };
    let mainUp: { etag: string | null; attempts: number };
    let authUp: { etag: string | null; attempts: number };
    try {
      mainUp = await deps.storage.uploadFile(plan.mainKey, mainFile, { ...uploadMeta, sha256: mainSha });
      authUp = await deps.storage.uploadFile(plan.authKey, authFile, { ...uploadMeta, sha256: authSha });
    } catch (err) {
      if (deps.signal?.aborted) throw new BackupError('INTERRUPTED', 'upload interrupted');
      throw new BackupError('S3_UPLOAD_FAILED', `S3 upload failed after retries: ${errorMessage(err)}`, { cause: err });
    }
    attempts = Math.max(mainUp.attempts, authUp.attempts);
    const uploadMs = Date.now() - uploadStart;
    log(`[backup] uploaded in ${(uploadMs / 1000).toFixed(1)}s`);

    // Verify what S3 actually holds before anything is called a backup.
    const checks: BackupVerifyCheck[] = [];
    const mainHead = await deps.storage.head(plan.mainKey);
    checks.push(...compareObject(mainHead, { size: mainSize, sha256: mainSha }, 'main'));
    const authHead = await deps.storage.head(plan.authKey);
    checks.push(...compareObject(authHead, { size: authSize, sha256: authSha }, 'auth'));
    const failedChecks = checks.filter((c) => !c.ok);
    if (failedChecks.length > 0) {
      throw new BackupError('S3_VERIFY_FAILED', `S3 verification failed: ${failedChecks.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`);
    }
    log('[backup] S3 verification successful');

    const files: BackupManifestFile[] = [
      { role: 'main', fileName: plan.mainFileName, s3Key: plan.mainKey, fileSize: mainSize, checksumSha256: mainSha, etag: mainHead?.etag ?? null },
      { role: 'auth', fileName: plan.authFileName, s3Key: plan.authKey, fileSize: authSize, checksumSha256: authSha, etag: authHead?.etag ?? null },
    ];
    const completedAt = deps.now();
    const manifest = buildManifest({
      plan,
      files,
      startedAt,
      completedAt,
      environment: config.environment,
      appVersion: config.appVersion,
      databaseVersion: info.serverVersion,
      pgDumpVersion,
      databaseName: info.databaseName ?? config.databaseName,
      databaseRef: config.databaseRef,
    });
    try {
      await deps.storage.putJson(plan.manifestKey, manifest);
      const mh = await deps.storage.head(plan.manifestKey);
      if (!mh || !(mh.contentLength && mh.contentLength > 0)) throw new Error('manifest HeadObject failed');
    } catch (err) {
      throw new BackupError('MANIFEST_FAILED', `could not write manifest: ${errorMessage(err)}`, { cause: err });
    }
    log(`[backup] manifest written — ${plan.manifestKey}`);

    const durationMs = completedAt.getTime() - startedAt.getTime();
    await lock.release({
      status: 'verified',
      completedAt: completedAt.toISOString(),
      durationMs,
      dumpMs,
      uploadMs,
      s3Key: plan.mainKey,
      authS3Key: plan.authKey,
      manifestS3Key: plan.manifestKey,
      fileSize: mainSize,
      authFileSize: authSize,
      checksumSha256: mainSha,
      authChecksumSha256: authSha,
      retentionUntil: plan.retentionUntil.toISOString(),
      pgDumpVersion,
      databaseVersion: info.serverVersion,
      appVersion: config.appVersion,
      lastVerifiedAt: completedAt.toISOString(),
      errorCategory: null,
      errorMessage: null,
    });
    log(`[backup] ${type} completed successfully in ${(durationMs / 1000).toFixed(1)}s — retained until ${plan.retentionUntil.toISOString().slice(0, 10)}`);
    const job = await deps.repo.getByBackupId(plan.backupId);
    return { outcome: 'success', backupId: plan.backupId, job, plan, durationMs };
  } catch (err) {
    const category = deps.signal?.aborted ? 'INTERRUPTED' : categorize(err);
    const safeMessage = redactSecrets(errorMessage(err), config.secrets);
    const failedAt = deps.now();
    log(`[backup] ${type} failed reason=${category} attempt=${attempts}/3 — ${safeMessage}`);
    try {
      await lock.release({
        status: 'failed',
        completedAt: failedAt.toISOString(),
        durationMs: failedAt.getTime() - startedAt.getTime(),
        errorCategory: category,
        errorMessage: safeMessage.slice(0, 4000),
      });
    } catch (releaseErr) {
      log(`[backup] WARNING: could not record failure: ${redactSecrets(errorMessage(releaseErr), config.secrets)}`);
    }
    try {
      await deps.alert({ backupId: plan.backupId, backupType: type, startedAt, failedAt, category, safeMessage, attempts, environment: config.environment });
    } catch {
      /* alert never throws; belt and braces */
    }
    return { outcome: 'failed', backupId: plan.backupId, category, message: safeMessage };
  } finally {
    await cleanupTemp(tmpDir, log);
  }
}

/**
 * Re-verify an existing backup against S3: manifest present and valid, both
 * objects present, sizes equal, sha256 metadata equal. Never downloads the
 * archive and never touches the database being backed up.
 */
export async function verifyBackup(job: BackupJob, deps: Pick<BackupDeps, 'storage' | 'repo' | 'now' | 'log'>): Promise<BackupVerifyResult> {
  const checks: BackupVerifyCheck[] = [];
  const manifest = job.manifestS3Key ? parseManifest(await deps.storage.getJson(job.manifestS3Key)) : null;
  checks.push({ name: 'manifest present and valid', ok: !!manifest, detail: job.manifestS3Key ?? 'no manifest key recorded' });

  const expected: { role: 'main' | 'auth'; key: string | null; size: number | null; sha: string | null }[] = manifest
    ? manifest.files.map((f) => ({ role: f.role, key: f.s3Key, size: f.fileSize, sha: f.checksumSha256 }))
    : [
        { role: 'main', key: job.s3Key, size: job.fileSize, sha: job.checksumSha256 },
        { role: 'auth', key: job.authS3Key, size: job.authFileSize, sha: job.authChecksumSha256 },
      ];
  for (const e of expected) {
    if (!e.key || e.size === null || !e.sha) {
      checks.push({ name: `${e.role}: recorded`, ok: false, detail: 'no key/size/checksum recorded for this file' });
      continue;
    }
    const head = await deps.storage.head(e.key);
    checks.push(...compareObject(head, { size: e.size, sha256: e.sha }, e.role));
    if (manifest) {
      const ledgerSha = e.role === 'main' ? job.checksumSha256 : job.authChecksumSha256;
      checks.push({ name: `${e.role}: ledger matches manifest`, ok: ledgerSha === e.sha, detail: ledgerSha === e.sha ? undefined : 'backup_jobs checksum differs from manifest' });
    }
  }
  const ok = checks.every((c) => c.ok);
  const verifiedAt = deps.now().toISOString();
  if (ok) {
    await deps.repo.update(job.backupId, { lastVerifiedAt: verifiedAt, ...(job.status === 'success' ? { status: 'verified' } : {}) });
  }
  deps.log(`[backup] verify ${job.backupId}: ${ok ? 'OK' : 'FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length} checks passed)`);
  return { backupId: job.backupId, ok, verifiedAt, checks };
}
