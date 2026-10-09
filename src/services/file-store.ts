import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { getS3Client } from './backup/backupConfig';
import type { S3Like } from './backup/s3BackupStorage';

/**
 * Where uploaded files live — photo attachments and the branding logo.
 *
 * Two drivers behind one interface, chosen by FILE_STORAGE_DRIVER:
 *
 *   supabase (default)  Supabase Storage, exactly as before this module existed.
 *   s3                  The company's S3 bucket, under FILES_S3_PREFIX.
 *
 * The default is deliberate: deploying this code moves nothing. The switch is
 * an operator's decision, made after `pnpm files:copy` has copied what is
 * already stored — see src/scripts/copy-storage-to-s3.ts for the order.
 *
 * Both drivers address a file by the same (bucket, path) pair, and on S3 the
 * object key is `<prefix>/<bucket>/<path>`. So `attachments.storage_path` and
 * `settings.logo_path` mean the same thing under either driver and no row has
 * to be rewritten to change over.
 */

export type FileBucket = 'attachments' | 'branding';

export interface FileStore {
  upload(bucket: FileBucket, path: string, body: Buffer, contentType: string): Promise<void>;
  /** Throws if the store refuses; a path that is already gone is not an error. */
  remove(bucket: FileBucket, paths: string[]): Promise<void>;
  /**
   * Short-lived read URLs, keyed by path. A path that could not be signed is
   * simply absent from the map — the caller decides what a missing photo means.
   */
  signUrls(bucket: FileBucket, paths: string[], ttlSeconds: number): Promise<Map<string, string>>;
  /** A permanent, unauthenticated URL. Only meaningful for `branding`. */
  publicUrl(bucket: FileBucket, path: string): string;
}

// ── Supabase Storage ───────────────────────────────────────────────────────

// `supabaseAdmin.storage` is read at call time, never captured: the integration
// tests replace it on the client object after this module has loaded. And the
// client itself is loaded at call time, never imported: config/supabase.ts
// refuses to load without its env vars, and a server on the s3 driver has none.
const supabaseAdmin = {
  get storage() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../config/supabase') as typeof import('../config/supabase')).supabaseAdmin.storage;
  },
};

const supabaseStore: FileStore = {
  async upload(bucket, path, body, contentType) {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(path, body, { contentType });
    if (error) throw error;
  },

  async remove(bucket, paths) {
    if (paths.length === 0) return;
    const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (error) throw error;
  },

  async signUrls(bucket, paths, ttlSeconds) {
    const urlByPath = new Map<string, string>();
    if (paths.length === 0) return urlByPath;

    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrls(paths, ttlSeconds);
    if (error) throw error;

    // Each result carries its own `path` and its own `error`. Keyed by the
    // returned path rather than by array index: the index only lines up if the
    // response preserves request order, and a silent reordering would attach one
    // document's receipt to another — the one failure mode this feature must not
    // have. `path` is only absent on a malformed response, hence the fallback.
    (data ?? []).forEach((d, i) => {
      const path = d.path ?? paths[i];
      if (!path) return;
      if (d.error || !d.signedUrl) {
        console.warn(`[files] could not sign ${bucket}/${path}:`, d.error ?? 'no URL returned');
        return;
      }
      urlByPath.set(path, d.signedUrl);
    });
    return urlByPath;
  },

  publicUrl(bucket, path) {
    return supabaseAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  },
};

// ── S3 ─────────────────────────────────────────────────────────────────────

export interface S3FileConfig {
  bucket: string;
  prefix: string;
  /** This API's own public origin — the branding logo is served through it. */
  publicApiUrl: string;
}

/** The API path the public logo is served from. Mounted in routes/index.ts. */
export const PUBLIC_BRANDING_PATH = '/api/public/branding';

/**
 * S3 settings from the environment. Throws, naming every problem at once,
 * rather than start storing files somewhere half-configured.
 *
 * FILES_S3_BUCKET has no fallback to the backup bucket on purpose. That bucket
 * carries lifecycle rules that EXPIRE objects; a receipt photo quietly deleted
 * by a rule written for database dumps is not recoverable. Whoever sets this
 * has to name the bucket and own that question.
 */
export function s3FileConfig(env: NodeJS.ProcessEnv = process.env): S3FileConfig {
  const errors: string[] = [];
  const bucket = (env.FILES_S3_BUCKET || '').trim();
  if (!bucket) errors.push('FILES_S3_BUCKET is required when FILE_STORAGE_DRIVER=s3');

  const prefix = (env.FILES_S3_PREFIX || 'files').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix)) {
    errors.push(`FILES_S3_PREFIX "${prefix}" contains characters outside [A-Za-z0-9._-/]`);
  }

  const publicApiUrl = (env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(publicApiUrl)) {
    errors.push('PUBLIC_API_URL must be this API\'s public origin, e.g. https://api.example.com (the logo is served from it)');
  }

  if (errors.length > 0) throw new Error(`File storage is misconfigured: ${errors.join('; ')}`);
  return { bucket, prefix, publicApiUrl };
}

export function s3Key(cfg: Pick<S3FileConfig, 'prefix'>, bucket: FileBucket, path: string): string {
  return `${cfg.prefix}/${bucket}/${path}`;
}

/** S3's batch delete takes at most this many keys per request. */
const DELETE_BATCH = 1000;

export function createS3FileStore(
  cfg: S3FileConfig,
  client: S3Like,
  // Injected so a test can sign without credentials.
  sign: (key: string, ttlSeconds: number) => Promise<string> = (key, ttlSeconds) =>
    getSignedUrl(client as never, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: ttlSeconds }),
): FileStore {
  return {
    async upload(bucket, path, body, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: s3Key(cfg, bucket, path),
        Body: body,
        ContentType: contentType,
        // Explicit, as for backups: encrypted at rest whatever the bucket default is.
        ServerSideEncryption: 'AES256',
      }));
    },

    async remove(bucket, paths) {
      for (let i = 0; i < paths.length; i += DELETE_BATCH) {
        const batch = paths.slice(i, i + DELETE_BATCH);
        const out = await client.send(new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: { Objects: batch.map((p) => ({ Key: s3Key(cfg, bucket, p) })), Quiet: true },
        }));
        // A batch delete answers 200 even when individual keys were refused.
        const failed = (out?.Errors ?? []) as { Key?: string; Message?: string }[];
        if (failed.length > 0) {
          throw new Error(`S3 refused to delete ${failed.length} object(s): ${failed[0]?.Key} — ${failed[0]?.Message}`);
        }
      }
    },

    /**
     * Signing is local arithmetic over the credentials — no request is made, so
     * a page of 100 photos costs nothing on the network. The other side of that:
     * S3 is never asked whether the object exists, so unlike the Supabase driver
     * a missing file is NOT dropped here; its URL is minted and 404s when opened.
     */
    async signUrls(bucket, paths, ttlSeconds) {
      const urlByPath = new Map<string, string>();
      await Promise.all(paths.map(async (path) => {
        try {
          urlByPath.set(path, await sign(s3Key(cfg, bucket, path), ttlSeconds));
        } catch (err) {
          console.warn(`[files] could not sign ${bucket}/${path}:`, err instanceof Error ? err.message : err);
        }
      }));
      return urlByPath;
    },

    // The bucket is private, so there is no S3 URL a signed-out login page or a
    // printed receipt could load. The logo is served by this API instead.
    publicUrl(bucket, path) {
      if (bucket !== 'branding') throw new Error(`${bucket} files are private and have no public URL`);
      return `${cfg.publicApiUrl}${PUBLIC_BRANDING_PATH}/${path}`;
    },
  };
}

// ── Driver selection ───────────────────────────────────────────────────────

export type FileStorageDriver = 'supabase' | 's3';

export function fileStorageDriver(env: NodeJS.ProcessEnv = process.env): FileStorageDriver {
  const raw = (env.FILE_STORAGE_DRIVER || 'supabase').trim().toLowerCase();
  if (raw !== 'supabase' && raw !== 's3') {
    throw new Error(`FILE_STORAGE_DRIVER must be "supabase" or "s3" (got "${raw}")`);
  }
  return raw;
}

let s3Store: FileStore | undefined;

/** The configured store. Resolved per call so a test can change the env. */
export function fileStore(): FileStore {
  if (fileStorageDriver() === 'supabase') return supabaseStore;
  if (!s3Store) s3Store = createS3FileStore(s3FileConfig(), getS3Client(process.env.AWS_REGION));
  return s3Store;
}

/** Test seam. */
export function resetFileStore(): void {
  s3Store = undefined;
}

// ── Public branding (S3 driver only) ───────────────────────────────────────

/**
 * The only shape a logo path ever has (settings.routes.ts writes it). The
 * public route serves nothing that does not match, so it cannot be walked to
 * any other object under the prefix.
 */
export const LOGO_PATH_PATTERN = /^settings\/logo-\d{1,16}\.(png|jpg|webp|svg)$/;

export interface PublicFile {
  body: Readable;
  contentType: string;
  contentLength: number | null;
}

/** Open a branding file for streaming, or null if there is no such file. */
export async function openPublicBrandingFile(path: string): Promise<PublicFile | null> {
  if (fileStorageDriver() !== 's3' || !LOGO_PATH_PATTERN.test(path)) return null;
  const cfg = s3FileConfig();
  try {
    const out = await getS3Client(process.env.AWS_REGION).send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, 'branding', path) }),
    );
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType || 'application/octet-stream',
      contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : null,
    };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Size of an object under the S3 driver's key scheme, or null if absent. Used by the copy script. */
export async function s3ObjectSize(cfg: S3FileConfig, client: S3Like, bucket: FileBucket, path: string): Promise<number | null> {
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, bucket, path) }));
    return typeof out?.ContentLength === 'number' ? out.ContentLength : null;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
