import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { BackupJob, BackupRestoreTest, BackupStatus, BackupType } from '../../../shared';
import type { BackupRepository, ClaimInput, ClaimResult, HistoryFilter, JobPatch, RestoreTestInput } from '../backupRepository';
import type { S3Like, UploadFactory } from '../s3BackupStorage';
import type { BackupSystemConfig } from '../backupConfig';
import type { SpawnFn } from '../postgresBackup';

/** In-memory S3. Commands are matched on their constructor name. */
export class FakeS3 implements S3Like {
  objects = new Map<string, { body: Buffer; metadata: Record<string, string>; etag: string; sse?: string; storageClass?: string }>();
  /** Command names that should throw N more times (for retry tests). */
  failures = new Map<string, { remaining: number; error: () => Error }>();
  calls: string[] = [];

  failNext(command: string, times: number, error: () => Error = () => Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } })) {
    this.failures.set(command, { remaining: times, error });
  }

  private maybeFail(name: string) {
    const f = this.failures.get(name);
    if (f && f.remaining > 0) {
      f.remaining -= 1;
      throw f.error();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const name: string = command.constructor.name;
    const input = command.input ?? {};
    this.calls.push(name);
    this.maybeFail(name);
    switch (name) {
      case 'HeadObjectCommand': {
        const o = this.objects.get(input.Key);
        if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return { ContentLength: o.body.length, ETag: o.etag, Metadata: o.metadata };
      }
      case 'PutObjectCommand': {
        const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body));
        this.objects.set(input.Key, { body, metadata: input.Metadata ?? {}, etag: `"etag-${body.length}"`, sse: input.ServerSideEncryption, storageClass: input.StorageClass });
        return {};
      }
      case 'GetObjectCommand': {
        const o = this.objects.get(input.Key);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToString: async () => o.body.toString('utf8') } };
      }
      case 'ListObjectsV2Command': {
        const prefix: string = input.Prefix ?? '';
        const contents = [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => ({ Key: k, Size: o.body.length, LastModified: new Date('2026-09-01T00:00:00Z') }));
        return { Contents: contents, IsTruncated: false };
      }
      case 'DeleteObjectCommand':
        this.objects.delete(input.Key);
        return {};
      default:
        throw new Error(`FakeS3: unsupported command ${name}`);
    }
  }
}

/** Upload double: consumes the stream into FakeS3, honouring failNext('Upload'). */
export function fakeUploadFactory(s3: FakeS3): UploadFactory {
  return (_client, params) => {
    let aborted = false;
    return {
      async abort() {
        aborted = true;
      },
      async done() {
        s3.calls.push('Upload');
        const f = s3.failures.get('Upload');
        if (f && f.remaining > 0) {
          f.remaining -= 1;
          // drain the stream so the file handle closes
          const body = params.Body as NodeJS.ReadableStream;
          body.resume?.();
          throw f.error();
        }
        const chunks: Buffer[] = [];
        for await (const c of params.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
        if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const body = Buffer.concat(chunks);
        s3.objects.set(params.Key!, {
          body,
          metadata: (params.Metadata as Record<string, string>) ?? {},
          etag: `"etag-${body.length}"`,
          sse: params.ServerSideEncryption,
          storageClass: params.StorageClass,
        });
        return { ETag: `"etag-${body.length}"` };
      },
    };
  };
}

export class FakeRepository implements BackupRepository {
  rows = new Map<string, BackupJob>();
  restoreTests: BackupRestoreTest[] = [];
  claimResult: ClaimResult | null = null;

  async claim(input: ClaimInput): Promise<ClaimResult> {
    if (this.claimResult) return this.claimResult;
    const existing = this.rows.get(input.backupId);
    if (existing && (existing.status === 'success' || existing.status === 'verified')) return 'already_completed';
    for (const r of this.rows.values()) {
      if (r.backupType === input.backupType && r.status === 'running') return 'in_progress';
    }
    const now = new Date().toISOString();
    this.rows.set(input.backupId, {
      id: `id-${input.backupId}`,
      backupId: input.backupId,
      backupType: input.backupType,
      status: 'running',
      trigger: input.trigger,
      environment: input.environment,
      appVersion: null,
      databaseVersion: null,
      pgDumpVersion: null,
      startedAt: now,
      completedAt: null,
      durationMs: null,
      dumpMs: null,
      uploadMs: null,
      s3Bucket: input.s3Bucket,
      s3Key: null,
      authS3Key: null,
      manifestS3Key: null,
      fileSize: null,
      authFileSize: null,
      checksumSha256: null,
      authChecksumSha256: null,
      retentionUntil: null,
      attempts: existing ? existing.attempts + 1 : 1,
      errorCategory: null,
      errorMessage: null,
      triggeredBy: input.triggeredBy,
      triggeredByName: input.triggeredByName,
      lastVerifiedAt: null,
      createdAt: now,
    });
    return 'claimed';
  }

  async update(backupId: string, patch: JobPatch): Promise<void> {
    const row = this.rows.get(backupId);
    if (!row) throw new Error(`no row ${backupId}`);
    Object.assign(row, patch);
  }

  async getByBackupId(backupId: string) {
    return this.rows.get(backupId) ?? null;
  }
  async getById(id: string) {
    return [...this.rows.values()].find((r) => r.id === id) ?? null;
  }
  private latest(filter?: (r: BackupJob) => boolean): Record<BackupType, BackupJob | null> {
    const out: Record<BackupType, BackupJob | null> = { daily: null, weekly: null, monthly: null, manual: null };
    for (const r of this.rows.values()) {
      if (filter && !filter(r)) continue;
      const cur = out[r.backupType];
      if (!cur || r.startedAt > cur.startedAt) out[r.backupType] = r;
    }
    return out;
  }
  async latestByType() {
    return this.latest();
  }
  async latestVerifiedByType() {
    return this.latest((r) => r.status === 'verified');
  }
  async running() {
    return [...this.rows.values()].filter((r) => r.status === 'running');
  }
  async history(filter: HistoryFilter) {
    let all = [...this.rows.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (filter.type) all = all.filter((r) => r.backupType === filter.type);
    if (filter.status) all = all.filter((r) => r.status === (filter.status as BackupStatus));
    const from = (filter.page - 1) * filter.pageSize;
    return { jobs: all.slice(from, from + filter.pageSize), total: all.length };
  }
  async verifiedJobs() {
    return [...this.rows.values()].filter((r) => r.status === 'verified');
  }
  async countFailedSince(sinceIso: string) {
    return [...this.rows.values()].filter((r) => (r.status === 'failed' || r.status === 'stale') && r.startedAt >= sinceIso).length;
  }
  async recordRestoreTest(input: RestoreTestInput): Promise<BackupRestoreTest> {
    const t: BackupRestoreTest = { id: `rt-${this.restoreTests.length + 1}`, createdAt: input.startedAt, ...input };
    this.restoreTests.push(t);
    return t;
  }
  async latestRestoreTest() {
    return this.restoreTests[this.restoreTests.length - 1] ?? null;
  }
}

export interface FakeSpawnOptions {
  /** Bytes written to the `--file` target. Default: 4 KiB of pseudo-random data. */
  payload?: Buffer;
  /** Exit code for dump invocations. */
  exitCode?: number;
  stderr?: string;
  versionLine?: string;
  /** If set, invocation N (1-based, counting dumps only) fails with this stderr and exit 1, later ones succeed. */
  failDumpNumber?: number;
  /** Hang until killed (for abort/timeout tests). */
  hang?: boolean;
  onSpawn?: (argv: string[], env: NodeJS.ProcessEnv) => void;
}

/** A pg_dump stand-in: handles `--version` and writes a payload to `--file`. */
export function fakeSpawn(opts: FakeSpawnOptions = {}): SpawnFn & { dumps: number } {
  let dumps = 0;
  const fn = ((cmd: string, argv: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, exitCode: null, signalCode: null, pid: 4242 });
    let killed = false;
    (child as unknown as { kill: (s?: string) => boolean }).kill = () => {
      killed = true;
      setImmediate(() => {
        Object.assign(child, { exitCode: null, signalCode: 'SIGTERM' });
        child.emit('close', null, 'SIGTERM');
      });
      return true;
    };
    opts.onSpawn?.(argv, spawnOpts?.env ?? {});
    setImmediate(() => {
      if (argv.includes('--version')) {
        stdout.write(opts.versionLine ?? 'pg_dump (PostgreSQL) 17.6\n');
        stdout.end();
        stderr.end();
        Object.assign(child, { exitCode: 0 });
        child.emit('close', 0, null);
        return;
      }
      dumps += 1;
      fn.dumps = dumps;
      if (opts.hang) return; // wait for kill()
      const fileIdx = argv.indexOf('--file');
      const shouldFail = opts.failDumpNumber === dumps || (opts.exitCode ?? 0) !== 0;
      if (!shouldFail && fileIdx >= 0) {
        writeFileSync(argv[fileIdx + 1], opts.payload ?? Buffer.alloc(4096, dumps));
      }
      if (shouldFail) stderr.write(opts.stderr ?? 'pg_dump: error: something went wrong\n');
      stdout.end();
      stderr.end();
      if (killed) return;
      const code = shouldFail ? 1 : 0;
      Object.assign(child, { exitCode: code });
      child.emit('close', code, null);
    });
    return child;
  }) as unknown as SpawnFn & { dumps: number };
  fn.dumps = 0;
  return fn;
}

export function testConfig(over: Partial<BackupSystemConfig> = {}): BackupSystemConfig {
  return {
    enabled: true,
    environment: 'test',
    isProduction: false,
    region: 'us-east-1',
    bucket: 'mountainbakes-development-backups',
    prefix: 'database-backups-test',
    productionBucket: 'mountainbakes-bucket',
    dbUrl: 'postgresql://postgres.abcdefghijklmnopqrst:s3cretPassw0rd@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
    databaseRef: 'abcdefghijklmnopqrst',
    databaseName: 'postgres',
    timezone: 'Asia/Karachi',
    retentionDays: { daily: 7, weekly: 35, monthly: 366, manual: 90 },
    retentionAuthority: 'lifecycle',
    alertMessaging: false,
    staleLockMs: 90 * 60_000,
    pgDumpTimeoutMs: 30_000,
    tmpDir: '',
    pgBinDir: null,
    appVersion: 'test-1',
    secrets: ['s3cretPassw0rd'],
    ...over,
  };
}
