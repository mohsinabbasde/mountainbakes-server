import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BackupJob, BackupType } from '../../../shared';
import { applyRetention, planRetention } from '../backupRetention';
import { computeHealth, computeTypeHealth } from '../backupHealth';
import { BackupStorage, type StoredObject } from '../s3BackupStorage';
import { FakeS3 } from './fakes';

const PREFIX = 'database-backups';
const RET = { daily: 7, weekly: 35, monthly: 366, manual: 90 };
const NOW = new Date('2026-09-22T22:00:00Z');

function job(type: BackupType, label: string, startedAt: string, over: Partial<BackupJob> = {}): BackupJob {
  const retentionUntil = new Date(new Date(startedAt).getTime() + RET[type] * 86_400_000).toISOString();
  return {
    id: `id-${type}-${label}`,
    backupId: `backup-${type}-${label}`,
    backupType: type,
    status: 'verified',
    trigger: 'scheduler',
    environment: 'production',
    appVersion: null,
    databaseVersion: null,
    pgDumpVersion: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 1000,
    dumpMs: null,
    uploadMs: null,
    s3Bucket: 'mountainbakes-bucket',
    s3Key: `${PREFIX}/${type}/${startedAt.slice(0, 4)}/${startedAt.slice(5, 7)}/mountainbakes-${type}-${label}.dump`,
    authS3Key: null,
    manifestS3Key: null,
    fileSize: 100,
    authFileSize: 10,
    checksumSha256: 'a'.repeat(64),
    authChecksumSha256: 'b'.repeat(64),
    retentionUntil,
    attempts: 1,
    errorCategory: null,
    errorMessage: null,
    triggeredBy: null,
    triggeredByName: null,
    lastVerifiedAt: startedAt,
    createdAt: startedAt,
    ...over,
  };
}

function obj(key: string, lastModified: string): StoredObject {
  return { key, size: 100, lastModified: new Date(lastModified), storageClass: 'STANDARD' };
}

function dailySet(dates: string[]): { objects: StoredObject[]; jobs: BackupJob[] } {
  const jobs = dates.map((d) => job('daily', d, `${d}T22:00:00Z`));
  const objects = jobs.map((j) => obj(j.s3Key!, j.startedAt));
  return { objects, jobs };
}

describe('retention planning', () => {
  it('keeps all seven daily backups while none is older than 7 days', () => {
    const { objects, jobs } = dailySet(['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22']);
    const plan = planRetention(objects, jobs, { prefix: PREFIX, now: new Date('2026-09-22T23:00:00Z'), retentionDays: RET });
    assert.equal(plan.expire.length, 0);
    assert.equal(plan.keep.length, 6); // newest is protected → skipped, not "kept"
    assert.ok(plan.skipped.some((s) => s.reason.includes('newest verified daily')));
  });

  it('expires the eighth (oldest) daily backup once the window passes and leaves the rest', () => {
    const { objects, jobs } = dailySet(['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22']);
    const plan = planRetention(objects, jobs, { prefix: PREFIX, now: new Date('2026-09-23T00:00:00Z'), retentionDays: RET });
    assert.deepEqual(plan.expire.map((e) => e.label), ['2026-09-15']);
    assert.ok(!plan.expire.some((e) => e.label === '2026-09-16'));
  });

  it('weekly expires after 35 days, monthly after 366 days; other classes untouched', () => {
    const jobs = [
      job('weekly', '2026-W33', '2026-08-16T22:45:00Z'), // 37 days before NOW → expired
      job('weekly', '2026-W36', '2026-09-06T22:45:00Z'),
      job('weekly', '2026-W38', '2026-09-19T22:45:00Z'),
      job('monthly', '2025-08', '2025-08-31T23:30:00Z'), // > 366 days → expired
      job('monthly', '2025-09', '2025-09-30T23:30:00Z'), // 357 days → keep
      job('monthly', '2026-08', '2026-08-31T23:30:00Z'),
    ];
    const objects = jobs.map((j) => obj(j.s3Key!, j.startedAt));
    const plan = planRetention(objects, jobs, { prefix: PREFIX, now: NOW, retentionDays: RET });
    assert.deepEqual(plan.expire.map((e) => e.backupId).sort(), ['backup-monthly-2025-08', 'backup-weekly-2026-W33']);
    assert.ok(plan.keep.some((k) => k.backupId === 'backup-monthly-2025-09'));
  });

  it('never selects objects without a verified ledger row, foreign keys, or manifests', () => {
    const jobs = [job('daily', '2026-09-01', '2026-09-01T22:00:00Z', { status: 'failed' }), job('daily', '2026-09-22', '2026-09-22T22:00:00Z')];
    const verified = jobs.filter((j) => j.status === 'verified');
    const objects = [
      obj(jobs[0].s3Key!, jobs[0].startedAt),
      obj(jobs[1].s3Key!, jobs[1].startedAt),
      obj(`${PREFIX}/manifests/daily/2026/09/backup-daily-2026-09-01.json`, '2026-09-01T22:00:00Z'),
      obj('uploads/logo.png', '2020-01-01T00:00:00Z'),
    ];
    const plan = planRetention(objects, verified, { prefix: PREFIX, now: NOW, retentionDays: RET });
    assert.equal(plan.expire.length, 0);
    assert.equal(plan.skipped.length, 4);
  });

  it('applyRetention is a dry run unless confirmed and refuses under lifecycle authority', async () => {
    const s3 = new FakeS3();
    const storage = new BackupStorage({ s3, bucket: 'b', log: () => undefined });
    const { objects, jobs } = dailySet(['2026-09-01', '2026-09-22']);
    for (const o of objects) s3.objects.set(o.key, { body: Buffer.alloc(100), metadata: { 'retention-until': '2026-09-08T22:00:00.000Z' }, etag: '"e"' });
    const plan = planRetention(objects, jobs, { prefix: PREFIX, now: NOW, retentionDays: RET });
    assert.equal(plan.expire.length, 1);

    const dry = await applyRetention(plan, storage, { confirm: false, authority: 'application', prefix: PREFIX, now: NOW, log: () => undefined });
    assert.equal(dry.dryRun, true);
    assert.equal(s3.objects.size, 2);

    await assert.rejects(() => applyRetention(plan, storage, { confirm: true, authority: 'lifecycle', prefix: PREFIX, now: NOW, log: () => undefined }), /Refusing to delete/);
    assert.equal(s3.objects.size, 2);

    const applied = await applyRetention(plan, storage, { confirm: true, authority: 'application', prefix: PREFIX, now: NOW, log: () => undefined });
    assert.deepEqual(applied.deleted, [jobs[0].s3Key]);
    assert.equal(s3.objects.size, 1);
    assert.ok(s3.objects.has(jobs[1].s3Key!));
  });

  it('applyRetention refuses an object whose metadata still says it is retained', async () => {
    const s3 = new FakeS3();
    const storage = new BackupStorage({ s3, bucket: 'b', log: () => undefined });
    const { objects, jobs } = dailySet(['2026-09-01', '2026-09-22']);
    s3.objects.set(objects[0].key, { body: Buffer.alloc(100), metadata: { 'retention-until': '2099-01-01T00:00:00.000Z' }, etag: '"e"' });
    const plan = planRetention(objects, jobs, { prefix: PREFIX, now: NOW, retentionDays: RET });
    const applied = await applyRetention(plan, storage, { confirm: true, authority: 'application', prefix: PREFIX, now: NOW, log: () => undefined });
    assert.equal(applied.deleted.length, 0);
    assert.equal(applied.refused[0].reason.includes('future'), true);
  });
});

describe('health', () => {
  const t = (iso: string) => new Date(iso);
  it('is never without a verified backup, healthy inside the window, overdue past it', () => {
    assert.equal(computeTypeHealth('daily', null, null, NOW).status, 'never');
    const v = job('daily', '2026-09-21', '2026-09-20T22:00:00Z');
    assert.equal(computeTypeHealth('daily', v, v, t('2026-09-22T03:59:00Z')).status, 'healthy'); // 29h59m
    assert.equal(computeTypeHealth('daily', v, v, t('2026-09-22T04:01:00Z')).status, 'overdue'); // 30h01m
    const w = job('weekly', '2026-W38', '2026-09-19T22:45:00Z');
    assert.equal(computeTypeHealth('weekly', w, w, t('2026-09-27T22:00:00Z')).status, 'healthy');
    assert.equal(computeTypeHealth('weekly', w, w, t('2026-09-28T00:00:00Z')).status, 'overdue');
    const m = job('monthly', '2026-08', '2026-08-31T23:30:00Z');
    assert.equal(computeTypeHealth('monthly', m, m, t('2026-10-03T00:00:00Z')).status, 'healthy');
    assert.equal(computeTypeHealth('monthly', m, m, t('2026-10-04T00:00:00Z')).status, 'overdue');
  });

  it('reports failed when the newest run failed even if an in-window success exists', () => {
    const ok = job('daily', '2026-09-21', '2026-09-20T22:00:00Z');
    const bad = job('daily', '2026-09-22', '2026-09-21T22:00:00Z', { status: 'failed', errorCategory: 'S3_UPLOAD_FAILED' });
    const h = computeTypeHealth('daily', bad, ok, t('2026-09-22T00:00:00Z'));
    assert.equal(h.status, 'failed');
    assert.equal(h.lastSuccessfulAt, ok.completedAt);
  });

  it('computeHealth aggregates per type', () => {
    const h = computeHealth({ latest: { daily: null, weekly: null, monthly: null, manual: null }, latestVerified: { daily: null, weekly: null, monthly: null, manual: null }, recentFailures: 2 }, NOW);
    assert.equal(h.daily.status, 'never');
    assert.equal(h.recentFailures, 2);
  });
});
