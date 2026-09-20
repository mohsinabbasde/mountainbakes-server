import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareObject, fileSize, sha256File } from '../backupIntegrity';
import { buildManifest, parseManifest } from '../backupManifest';
import { buildBackupPlan } from '../backupNaming';

describe('integrity', () => {
  it('streams a SHA-256 that matches crypto.createHash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-integrity-'));
    try {
      const file = path.join(dir, 'x.dump');
      const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
      await writeFile(file, data);
      assert.equal(await sha256File(file), createHash('sha256').update(data).digest('hex'));
      assert.equal(await fileSize(file), data.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compareObject flags missing, size mismatch, empty and checksum mismatch', () => {
    const sha = 'a'.repeat(64);
    assert.equal(compareObject(null, { size: 10, sha256: sha }, 'main')[0].ok, false);
    const good = compareObject({ contentLength: 10, etag: '"e"', metadata: { sha256: sha } }, { size: 10, sha256: sha }, 'main');
    assert.ok(good.every((c) => c.ok));
    const badSize = compareObject({ contentLength: 9, etag: '"e"', metadata: { sha256: sha } }, { size: 10, sha256: sha }, 'main');
    assert.equal(badSize.find((c) => c.name.includes('size'))!.ok, false);
    const empty = compareObject({ contentLength: 0, etag: '"e"', metadata: { sha256: sha } }, { size: 0, sha256: sha }, 'main');
    assert.equal(empty.find((c) => c.name.includes('non-empty'))!.ok, false);
    const badSha = compareObject({ contentLength: 10, etag: '"e"', metadata: { sha256: 'b'.repeat(64) } }, { size: 10, sha256: sha }, 'main');
    assert.equal(badSha.find((c) => c.name.includes('checksum'))!.ok, false);
  });

  it('manifest round-trips through the zod schema and rejects a bad checksum', () => {
    const plan = buildBackupPlan('daily', new Date('2026-09-20T22:00:00Z'), { prefix: 'database-backups', retentionDays: { daily: 7, weekly: 35, monthly: 366, manual: 90 } });
    const m = buildManifest({
      plan,
      files: [
        { role: 'main', fileName: plan.mainFileName, s3Key: plan.mainKey, fileSize: 100, checksumSha256: 'c'.repeat(64), etag: null },
        { role: 'auth', fileName: plan.authFileName, s3Key: plan.authKey, fileSize: 10, checksumSha256: 'd'.repeat(64), etag: '"x"' },
      ],
      startedAt: new Date('2026-09-20T22:00:00Z'),
      completedAt: new Date('2026-09-20T22:03:00Z'),
      environment: 'test',
      appVersion: null,
      databaseVersion: '17.6',
      pgDumpVersion: '17.6',
      databaseName: 'postgres',
      databaseRef: 'ref',
    });
    assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(m))), m);
    assert.equal(parseManifest({ ...m, files: [{ ...m.files[0], checksumSha256: 'nope' }] }), null);
    assert.equal(parseManifest(null), null);
    assert.ok(!JSON.stringify(m).includes('password'));
  });
});
