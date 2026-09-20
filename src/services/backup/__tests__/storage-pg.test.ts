import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackupStorage, isTransientS3Error, withRetry } from '../s3BackupStorage';
import { buildPgDumpArgs, getPgDumpVersion, pgConnectionEnv, probeConnection, runPgDump } from '../postgresBackup';
import { BackupError } from '../errors';
import { FakeS3, fakeSpawn, fakeUploadFactory } from './fakes';

describe('S3 storage', () => {
  it('withRetry waits 1s/4s/16s and gives up after three attempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } });
          },
          { label: 't', sleep: async (ms) => void waits.push(ms), log: () => undefined },
        ),
      /503/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 4000]);
  });

  it('withRetry does not retry client errors (403 = wrong credentials/policy)', async () => {
    let calls = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
        },
        { label: 't', sleep: async () => undefined },
      ),
    );
    assert.equal(calls, 1);
    assert.equal(isTransientS3Error(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 429 } })), true);
  });

  it('uploads with SSE-S3 and checksum metadata, then HeadObject reports them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-storage-'));
    try {
      const file = path.join(dir, 'f.dump');
      await writeFile(file, Buffer.alloc(2048, 1));
      const s3 = new FakeS3();
      const storage = new BackupStorage({ s3, bucket: 'b', createUpload: fakeUploadFactory(s3), sleep: async () => undefined, log: () => undefined });
      s3.failNext('Upload', 2); // transient twice, then succeeds
      const res = await storage.uploadFile('k/f.dump', file, { sha256: 'a'.repeat(64), backupId: 'id', backupType: 'daily', retentionUntil: new Date('2026-09-28T00:00:00Z') });
      assert.equal(res.attempts, 3);
      const stored = s3.objects.get('k/f.dump')!;
      assert.equal(stored.sse, 'AES256');
      assert.equal(stored.metadata.sha256, 'a'.repeat(64));
      assert.equal(stored.metadata['backup-type'], 'daily');
      const head = await storage.head('k/f.dump');
      assert.equal(head?.contentLength, 2048);
      assert.equal(await storage.head('missing'), null);
      await storage.putJson('m.json', { a: 1 });
      assert.deepEqual(await storage.getJson('m.json'), { a: 1 });
      assert.equal(await storage.getJson('nope.json'), null);
      assert.equal((await storage.list('k/')).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pg_dump driver', () => {
  it('builds the exact argv for the main and auth archives', () => {
    assert.deepEqual(buildPgDumpArgs({ outFile: '/t/m.dump', schemas: ['public', 'app', 'supabase_migrations'] }), [
      '--format=custom', '--compress=6', '--no-sync', '--no-publications', '--no-subscriptions', '--file', '/t/m.dump',
      '--schema=public', '--schema=app', '--schema=supabase_migrations',
    ]);
    assert.deepEqual(buildPgDumpArgs({ outFile: '/t/a.dump', tables: ['auth.users', 'auth.identities'] }).slice(-2), ['--table=auth.users', '--table=auth.identities']);
    assert.ok(buildPgDumpArgs({ outFile: '/t/p.dump', schemas: ['supabase_migrations'], schemaOnly: true }).includes('--schema-only'));
  });

  it('passes the connection through libpq env vars, never argv', async () => {
    const env = pgConnectionEnv('postgresql://postgres.ref:p%40ss@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require');
    assert.equal(env.PGHOST, 'aws-0-ap-northeast-1.pooler.supabase.com');
    assert.equal(env.PGUSER, 'postgres.ref');
    assert.equal(env.PGPASSWORD, 'p@ss');
    assert.equal(env.PGDATABASE, 'postgres');
    assert.equal(env.PGSSLMODE, 'require');
    let seenArgv: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const spawn = fakeSpawn({ onSpawn: (argv, e) => { seenArgv = argv; seenEnv = e; } });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-pg-'));
    try {
      await runPgDump({ dbUrl: 'postgresql://u:secretpw@h:5432/db', outFile: path.join(dir, 'x.dump'), schemas: ['public'], timeoutMs: 5000 }, { spawn, pgBinDir: null, secrets: ['secretpw'] });
      assert.ok(!seenArgv.join(' ').includes('secretpw'));
      assert.equal(seenEnv.PGPASSWORD, 'secretpw');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses the version, probes, and classifies connection failures as retryable with redacted stderr', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-pg-'));
    try {
      assert.equal(await getPgDumpVersion({ spawn: fakeSpawn({ versionLine: 'pg_dump (PostgreSQL) 18.1 (Ubuntu 18.1-1)\n' }), pgBinDir: null }), '18.1');
      const ok = await probeConnection('postgresql://u:pw@h:5432/db', dir, { spawn: fakeSpawn(), pgBinDir: null });
      assert.ok(ok.durationMs >= 0);

      const conn = fakeSpawn({ exitCode: 1, stderr: 'pg_dump: error: connection to server at "h" failed: password authentication failed for user "u" (password was secretpw)\n' });
      await assert.rejects(
        () => runPgDump({ dbUrl: 'postgresql://u:secretpw@h:5432/db', outFile: path.join(dir, 'y.dump'), schemas: ['public'], timeoutMs: 5000 }, { spawn: conn, pgBinDir: null, secrets: ['secretpw'] }),
        (err: unknown) => err instanceof BackupError && err.category === 'DB_CONNECTION_FAILED' && err.retryable && !err.message.includes('secretpw') && err.message.includes('***'),
      );

      const generic = fakeSpawn({ exitCode: 1, stderr: 'pg_dump: error: query failed\n' });
      await assert.rejects(
        () => runPgDump({ dbUrl: 'postgresql://u:pw@h:5432/db', outFile: path.join(dir, 'z.dump'), schemas: ['public'], timeoutMs: 5000 }, { spawn: generic, pgBinDir: null }),
        (err: unknown) => err instanceof BackupError && err.category === 'PG_DUMP_FAILED' && !err.retryable,
      );

      const empty = fakeSpawn({ payload: Buffer.alloc(0) });
      await assert.rejects(
        () => runPgDump({ dbUrl: 'postgresql://u:pw@h:5432/db', outFile: path.join(dir, 'e.dump'), schemas: ['public'], timeoutMs: 5000 }, { spawn: empty, pgBinDir: null }),
        (err: unknown) => err instanceof BackupError && err.category === 'DUMP_EMPTY',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('kills a hung pg_dump on timeout and on abort', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-pg-'));
    try {
      await assert.rejects(
        () => runPgDump({ dbUrl: 'postgresql://u:pw@h:5432/db', outFile: path.join(dir, 't.dump'), schemas: ['public'], timeoutMs: 50 }, { spawn: fakeSpawn({ hang: true }), pgBinDir: null }),
        (err: unknown) => err instanceof BackupError && err.category === 'PG_DUMP_FAILED' && /exceeded 50ms/.test(err.message),
      );
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(
        () => runPgDump({ dbUrl: 'postgresql://u:pw@h:5432/db', outFile: path.join(dir, 'a.dump'), schemas: ['public'], timeoutMs: 5000, signal: ac.signal }, { spawn: fakeSpawn({ hang: true }), pgBinDir: null }),
        (err: unknown) => err instanceof BackupError && err.category === 'INTERRUPTED',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
