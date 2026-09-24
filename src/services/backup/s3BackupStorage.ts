import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BackupType } from '../../shared';
import { BackupError, errorMessage } from './errors';
import type { ObjectHead } from './backupIntegrity';

/**
 * Everything the backup system does against S3, behind an interface the unit
 * tests can replace with an in-memory double. Nothing here knows about
 * backup_jobs or pg_dump; it moves bytes and reports what S3 says about them.
 *
 * Every write sets SSE-S3 explicitly (`ServerSideEncryption: AES256`) so a
 * backup is encrypted at rest even on a bucket whose default encryption has
 * not been configured yet.
 */

// The SDK's command classes are generic; the double only needs `send`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface S3Like { send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any> }

export interface UploadHandle { done(): Promise<{ ETag?: string }>; abort(): Promise<void> }
export type UploadFactory = (client: S3Like, params: PutObjectCommandInput) => UploadHandle;

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | null;
  storageClass: string | null;
}

export interface RetryOptions {
  attempts?: number;
  delaysMs?: number[];
  label: string;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const DEFAULT_DELAYS = [1000, 4000, 16000];

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Client-side (4xx) failures are configuration problems and are not retried; everything else is. */
export function isTransientS3Error(err: unknown): boolean {
  if (isNotFound(err)) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  if (e?.name === 'AbortError') return false;
  return true;
}

/** Bounded exponential backoff: attempt 1, wait 1s, attempt 2, wait 4s, attempt 3. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delays = opts.delaysMs ?? DEFAULT_DELAYS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryable = opts.isRetryable ?? isTransientS3Error;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !retryable(err)) break;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      opts.log?.(`[backup] ${opts.label} failed (attempt ${attempt}/${attempts}): ${errorMessage(err)} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export interface UploadOptions {
  sha256: string;
  backupId: string;
  backupType: BackupType;
  retentionUntil: Date;
  contentType?: string;
  signal?: AbortSignal;
}

export interface BackupStorageDeps {
  s3: S3Like;
  bucket: string;
  createUpload?: UploadFactory;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const defaultUploadFactory: UploadFactory = (client, params) =>
  new Upload({ client: client as ConstructorParameters<typeof Upload>[0]['client'], params, queueSize: 3, partSize: 16 * 1024 * 1024, leavePartsOnError: false });

export class BackupStorage {
  readonly bucket: string;
  private readonly s3: S3Like;
  private readonly createUpload: UploadFactory;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(deps: BackupStorageDeps) {
    this.s3 = deps.s3;
    this.bucket = deps.bucket;
    this.createUpload = deps.createUpload ?? defaultUploadFactory;
    this.sleep = deps.sleep;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  private retryOpts(label: string): RetryOptions {
    return { label, sleep: this.sleep, log: this.log };
  }

  /**
   * Streaming multipart upload of a local file. A fresh read stream is opened
   * on every attempt — a stream that has already been partially consumed
   * cannot be replayed.
   */
  async uploadFile(key: string, filePath: string, opts: UploadOptions): Promise<{ etag: string | null; attempts: number }> {
    let attempts = 0;
    const etag = await withRetry(async (attempt) => {
      attempts = attempt;
      if (opts.signal?.aborted) throw new BackupError('INTERRUPTED', 'upload aborted before start');
      const upload = this.createUpload(this.s3, {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: opts.contentType ?? 'application/octet-stream',
        ServerSideEncryption: 'AES256',
        StorageClass: 'STANDARD',
        Metadata: {
          sha256: opts.sha256,
          'backup-id': opts.backupId,
          'backup-type': opts.backupType,
          'retention-until': opts.retentionUntil.toISOString(),
        },
      });
      const onAbort = () => {
        upload.abort().catch(() => undefined);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await upload.done();
        return result.ETag ?? null;
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }, { ...this.retryOpts(`upload ${key}`), isRetryable: (err) => !opts.signal?.aborted && isTransientS3Error(err) });
    return { etag, attempts };
  }

  /** HeadBucket — S3 reachability + credentials for the status report. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `s3://${this.bucket} reachable` };
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }
  }

  /** Stream an object to a local file (restore test). Never buffers the archive in memory. */
  async downloadToFile(key: string, filePath: string): Promise<void> {
    const res = await withRetry(() => this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })), this.retryOpts(`download ${key}`));
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`GetObject ${key} returned no body`);
    await pipeline(body, createWriteStream(filePath));
  }

  /** HeadObject; null when the key does not exist. */
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const res = await withRetry(() => this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })), this.retryOpts(`head ${key}`));
      return { contentLength: res.ContentLength, etag: res.ETag, metadata: res.Metadata };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putJson(key: string, body: unknown): Promise<void> {
    await withRetry(
      () =>
        this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(body, null, 2),
            ContentType: 'application/json',
            ServerSideEncryption: 'AES256',
          }),
        ),
      this.retryOpts(`put ${key}`),
    );
  }

  /** GetObject parsed as JSON; null when missing or unparseable. */
  async getJson(key: string): Promise<unknown | null> {
    try {
      const res = await withRetry(() => this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })), this.retryOpts(`get ${key}`));
      const text: string = typeof res.Body?.transformToString === 'function' ? await res.Body.transformToString() : String(res.Body ?? '');
      return JSON.parse(text);
    } catch (err) {
      if (isNotFound(err) || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  /** Every object under a prefix (paginated). */
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await withRetry(
        () => this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })),
        this.retryOpts(`list ${prefix}`),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key) continue;
        out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? null, storageClass: o.StorageClass ?? null });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /**
   * Delete ONE object. Deliberately no bulk/wildcard variant: the retention
   * module decides key by key, and every key it passes here has already been
   * checked against the bucket, prefix, type and expiry.
   */
  async deleteObject(key: string): Promise<void> {
    await withRetry(() => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })), this.retryOpts(`delete ${key}`));
  }

  /** Short-lived presigned GET. Nothing stores the result; it is handed to one admin and forgotten. */
  async presignDownload(key: string, expiresInSeconds: number, fileName: string): Promise<string> {
    return getSignedUrl(
      this.s3 as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}
