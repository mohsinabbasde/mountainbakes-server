import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackupStorage } from '../s3BackupStorage';
import { runBackup, verifyBackup, type BackupDeps } from '../backupService';
import type { FailureAlert } from '../backupAlerts';
import { FakeRepository, FakeS3, fakeSpawn, fakeUploadFactory, testConfig } from './fakes';

const NOW = new Date('2026-09-20T22:00:00Z'); // 03:00 PKT Monday 21 Sep

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'mb-service-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeDeps(over: Partial<BackupDeps> & { s3?: FakeS3; repo?: FakeRepository; spawn?: ReturnType<typeof fakeSpawn>; alerts?: FailureAlert[] } = {}) {
  const s3 = over.s3 ?? new FakeS3();
  const repo = over.repo ?? new FakeRepository();
  const spawn = over.spawn ?? fakeSpawn();
  const alerts = over.alerts ?? [];
  const logs: string[] = [];
  const config = over.config ?? testConfig({ tmpDir: tmpRoot });
  const deps: BackupDeps = {
    config,
    storage: new BackupStorage({ s3, bucket: config.bucket, createUpload: fakeUploadFactory(s3), sleep: async () => undefined, log: (l) => logs.push(l) }),
    repo,
    pg: { spawn, pgBinDir: null, secrets: config.secrets },
    now: () => NOW,
    log: (l) => logs.push(l),
    alert: async (a) => {
      alerts.push(a);
    },
    databaseInfo: async () => ({ serverVersion: '17.6', databaseName: 'postgres', sizeBytes: 1_000_000, publicTableCount: 80 }),
    sleep: async () => undefined,
    ...over,
  };
  return { deps, s3, repo, spawn, alerts, logs };
}

describe('runBackup', () => {
  it('happy path: dumps, uploads both archives, verifies, writes the manifest, marks verified, cleans temp', async () => {
    const { deps, s3, repo, logs } = makeDeps();
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'success');
    const row = repo.rows.get('backup-daily-2026-09-21')!;
    assert.equal(row.status, 'verified');
    assert.equal(row.s3Key, 'database-backups-test/daily/2026/09/mountainbakes-daily-2026-09-21.dump');
    assert.equal(row.authS3Key, 'database-backups-test/daily/2026/09/mountainbakes-daily-2026-09-21-auth.dump');
    assert.equal(row.fileSize, 4096);
    assert.match(row.checksumSha256!, /^[0-9a-f]{64}$/);
    assert.equal(row.retentionUntil, '2026-09-27T22:00:00.000Z');
    assert.equal(row.pgDumpVersion, '17.6');
    assert.equal(row.databaseVersion, '17.6');
    assert.ok(s3.objects.has(row.s3Key!));
    assert.ok(s3.objects.has(row.authS3Key!));
    const manifest = JSON.parse(s3.objects.get(row.manifestS3Key!)!.body.toString());
    assert.equal(manifest.backupId, 'backup-daily-2026-09-21');
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.files[0].checksumSha256, row.checksumSha256);
    assert.ok(!JSON.stringify(manifest).includes('s3cretPassw0rd'));
    assert.equal(s3.objects.get(row.s3Key!)!.sse, 'AES256');
    assert.equal((await readdir(tmpRoot)).length, 0, 'temp dir cleaned');
    assert.ok(logs.some((l) => l.includes('S3 verification successful')));
    assert.ok(logs.some((l) => l.includes('completed successfully')));
  });

  it('skips a weekly run that is not due, unless forced', async () => {
    const { deps, repo } = makeDeps();
    const res = await runBackup('weekly', { trigger: 'scheduler' }, deps); // Monday PKT
    assert.equal(res.outcome, 'not_due');
    assert.equal(repo.rows.size, 0, 'no lock claimed');
    const forced = await runBackup('weekly', { trigger: 'manual', force: true }, deps);
    assert.equal(forced.outcome, 'success');
    assert.equal(forced.outcome === 'success' && forced.plan.label, '2026-W39');
  });

  it('does not dump when the lock is held by another run', async () => {
    const { deps, repo, spawn } = makeDeps();
    repo.claimResult = 'in_progress';
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'in_progress');
    assert.equal(spawn.dumps, 0);
  });

  it('is idempotent: a second run of the same day finds the verified objects and uploads nothing', async () => {
    const { deps, s3, repo, spawn } = makeDeps();
    await runBackup('daily', { trigger: 'scheduler' }, deps);
    const uploadsBefore = s3.calls.filter((c) => c === 'Upload').length;
    // Ledger says already completed
    const again = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(again.outcome, 'already_completed');
    // Ledger lost the row (e.g. restored DB) but S3 still has manifest + objects → still no re-upload
    repo.rows.delete('backup-daily-2026-09-21');
    const third = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(third.outcome, 'already_completed');
    assert.equal(s3.calls.filter((c) => c === 'Upload').length, uploadsBefore);
    assert.equal(spawn.dumps, 3, 'only the first run dumped (probe + main + auth)');
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.status, 'verified');
  });

  it('replaces a partial earlier upload (object present, no matching manifest)', async () => {
    const { deps, s3, repo } = makeDeps();
    const key = 'database-backups-test/daily/2026/09/mountainbakes-daily-2026-09-21.dump';
    s3.objects.set(key, { body: Buffer.alloc(10), metadata: {}, etag: '"partial"' });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'success');
    assert.equal(s3.objects.get(key)!.body.length, 4096);
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.status, 'verified');
  });

  it('pg_dump failure → FAILED row with category, alert sent, lock released, temp cleaned, no S3 object', async () => {
    const { deps, s3, repo, alerts } = makeDeps({ spawn: fakeSpawn({ exitCode: 1, stderr: 'pg_dump: error: permission denied for schema app (password s3cretPassw0rd)' }) });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'failed');
    const row = repo.rows.get('backup-daily-2026-09-21')!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCategory, 'PG_DUMP_FAILED');
    assert.ok(!row.errorMessage!.includes('s3cretPassw0rd'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].category, 'PG_DUMP_FAILED');
    assert.ok(!alerts[0].safeMessage.includes('s3cretPassw0rd'));
    assert.equal(s3.objects.size, 0);
    assert.equal((await readdir(tmpRoot)).length, 0);
  });

  it('retries a connection-class dump failure once, then succeeds', async () => {
    const spawn = fakeSpawn({ failDumpNumber: 2, stderr: 'pg_dump: error: server closed the connection unexpectedly' }); // probe=1, main=2 fails, retry=3
    const { deps, repo } = makeDeps({ spawn });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'success');
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.status, 'verified');
    assert.equal(spawn.dumps, 4); // probe + failed main + retried main + auth
  });

  it('S3 upload failure after three attempts → FAILED S3_UPLOAD_FAILED, alert, no false success', async () => {
    const s3 = new FakeS3();
    s3.failNext('Upload', 10);
    const { deps, repo, alerts } = makeDeps({ s3 });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'failed');
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.errorCategory, 'S3_UPLOAD_FAILED');
    assert.equal(alerts.length, 1);
    assert.equal(s3.calls.filter((c) => c === 'Upload').length, 3);
    assert.equal((await readdir(tmpRoot)).length, 0);
  });

  it('S3 verification mismatch → FAILED S3_VERIFY_FAILED and the ledger never says verified', async () => {
    const s3 = new FakeS3();
    // A HeadObject that lies about the size
    const origSend = s3.send.bind(s3);
    s3.send = async (cmd) => {
      const r = await origSend(cmd);
      if (cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.endsWith('.dump')) return { ...r, ContentLength: 1 };
      return r;
    };
    const { deps, repo } = makeDeps({ s3 });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'failed');
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.errorCategory, 'S3_VERIFY_FAILED');
  });

  it('manifest write failure → FAILED MANIFEST_FAILED even though the archives uploaded', async () => {
    const s3 = new FakeS3();
    s3.failNext('PutObjectCommand', 10);
    const { deps, repo } = makeDeps({ s3 });
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'failed');
    assert.equal(repo.rows.get('backup-daily-2026-09-21')!.errorCategory, 'MANIFEST_FAILED');
  });

  it('SIGTERM mid-dump → INTERRUPTED, lock released as failed, temp cleaned', async () => {
    const ac = new AbortController();
    const { deps, repo, alerts } = makeDeps({ spawn: fakeSpawn({ hang: true }), signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const res = await runBackup('daily', { trigger: 'scheduler' }, deps);
    assert.equal(res.outcome, 'failed');
    const row = repo.rows.get('backup-daily-2026-09-21')!;
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCategory, 'INTERRUPTED');
    assert.equal(alerts[0].category, 'INTERRUPTED');
    assert.equal((await readdir(tmpRoot)).length, 0);
  });

  it('two simultaneous runs of the same type: exactly one dumps', async () => {
    const shared = new FakeRepository();
    const s3 = new FakeS3();
    const a = makeDeps({ repo: shared, s3 });
    const b = makeDeps({ repo: shared, s3 });
    const [ra, rb] = await Promise.all([runBackup('daily', { trigger: 'scheduler' }, a.deps), runBackup('daily', { trigger: 'manual' }, b.deps)]);
    const outcomes = [ra.outcome, rb.outcome].sort();
    assert.deepEqual(outcomes, ['in_progress', 'success']);
    assert.equal(a.spawn.dumps + b.spawn.dumps, 3); // probe + main + auth, once
    assert.equal(s3.objects.size, 3);
  });
});

describe('verifyBackup', () => {
  it('passes for an intact backup and fails when an object is corrupted or missing', async () => {
    const { deps, s3, repo } = makeDeps();
    await runBackup('daily', { trigger: 'scheduler' }, deps);
    const job = repo.rows.get('backup-daily-2026-09-21')!;
    const ok = await verifyBackup(job, deps);
    assert.equal(ok.ok, true);
    assert.ok(ok.checks.length >= 8);

    s3.objects.get(job.authS3Key!)!.metadata.sha256 = 'f'.repeat(64);
    const bad = await verifyBackup(job, deps);
    assert.equal(bad.ok, false);
    assert.ok(bad.checks.some((c) => c.name === 'auth: checksum matches' && !c.ok));

    s3.objects.delete(job.s3Key!);
    const missing = await verifyBackup(job, deps);
    assert.ok(missing.checks.some((c) => c.name === 'main: object exists' && !c.ok));
  });
});
