import { dbFor, disconnectPrisma } from '../../src/db';
import { getS3Client } from '../../src/services/backup/backupConfig';
import {
  createS3FileStore,
  s3FileConfig,
  s3Key,
  s3ObjectSize,
  type FileBucket,
} from '../../src/services/file-store';

const db = dbFor('scripts');

/**
 * Copy every stored file from Supabase Storage to S3, which is where the API
 * keeps files.
 *
 *   pnpm files:copy                      report what would be copied; writes nothing
 *   pnpm files:copy --confirm            copy
 *   pnpm files:copy --confirm --rewrite-logo-url
 *                                        copy, then point settings.logo_url at this API
 *
 * WHAT IT COPIES. Every row of `attachments` (the row is what makes a file
 * findable, so a file with no row is not worth moving) and the one logo named
 * by `settings.logo_path`. Paths are kept as they are — the S3 key is
 * `<FILES_S3_PREFIX>/<bucket>/<path>` — so no row changes except the logo URL.
 *
 * WHICH DATABASE. The rows are read, and `settings.logo_url` is written, in the
 * database DATABASE_URL names. Run it against the one the API is going to
 * serve from: after `railway:migrate`, that is the Railway copy.
 *
 * WHERE THE FILES COME FROM. Supabase Storage, read over its HTTP API with
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — the only two Supabase settings
 * anything in this repository still reads, and only this script and its
 * neighbours in infra/railway do.
 *
 * RE-RUNNABLE. A file already in S3 at its recorded size is skipped, so a
 * second run copies only what arrived since the first. Run it once ahead of
 * the cutover, and once more during it, after writes have stopped.
 *
 * It never deletes anything, on either side. Supabase Storage keeps its copy.
 */

/** One stored file, or null if Supabase Storage has no such object. */
async function download(bucket: FileBucket, path: string): Promise<{ body: Buffer; contentType: string | null } | null> {
  const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to read the files being copied');
  const res = await fetch(`${base}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Supabase Storage answered ${res.status} for ${bucket}/${path}`);
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

const PAGE = 1000;

interface Tally { copied: number; skipped: number; missing: number; failed: number; bytes: number }

async function copyOne(
  ctx: { cfg: ReturnType<typeof s3FileConfig>; client: ReturnType<typeof getS3Client>; confirm: boolean; tally: Tally },
  bucket: FileBucket,
  path: string,
  expectedSize: number | null,
  contentType: string | null,
): Promise<void> {
  const { cfg, client, confirm, tally } = ctx;
  try {
    const existing = await s3ObjectSize(cfg, client, bucket, path);
    if (existing !== null && (expectedSize === null || existing === expectedSize)) {
      tally.skipped++;
      return;
    }
    if (!confirm) {
      tally.copied++;
      tally.bytes += expectedSize ?? 0;
      return;
    }

    const file = await download(bucket, path);
    if (!file) {
      tally.missing++;
      console.warn(`  missing at source: ${bucket}/${path}`);
      return;
    }
    const { body } = file;
    await createS3FileStore(cfg, client).upload(bucket, path, body, contentType || file.contentType || 'application/octet-stream');

    // Read it back rather than trust the 200: the size S3 reports is what a
    // later run of this script will compare against.
    const stored = await s3ObjectSize(cfg, client, bucket, path);
    if (stored !== body.length) throw new Error(`size after upload is ${stored}, expected ${body.length}`);
    tally.copied++;
    tally.bytes += body.length;
  } catch (err) {
    tally.failed++;
    console.error(`  FAILED ${bucket}/${path}:`, err instanceof Error ? err.message : err);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has('--confirm');
  const rewriteLogo = args.has('--rewrite-logo-url');
  if (rewriteLogo && !confirm) throw new Error('--rewrite-logo-url needs --confirm');

  const cfg = s3FileConfig();
  const client = getS3Client(process.env.AWS_REGION);
  const tally: Tally = { copied: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
  const ctx = { cfg, client, confirm, tally };

  console.log(`[files:copy] ${confirm ? 'COPYING' : 'DRY RUN (nothing is written; pass --confirm to copy)'}`);
  const database = new URL((process.env.DATABASE_URL || '').trim());
  console.log(`[files:copy] target s3://${cfg.bucket}/${cfg.prefix}/   rows from ${database.hostname}${database.pathname}`);

  // Keyset over (created_at, id) would be tidier, but rows are append-only and
  // nothing here deletes, so a stable order plus an offset cannot skip a row.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('attachments')
      .select('storage_path, size_bytes, mime_type')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    // Eight at a time: quick enough for a few thousand photos, and gentle on
    // the service being read from.
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(rows.slice(i, i + 8).map((r) =>
        copyOne(ctx, 'attachments', r.storage_path as string, Number(r.size_bytes), r.mime_type as string)));
    }
    console.log(`[files:copy] attachments: ${from + rows.length} row(s) examined`);
    if (rows.length < PAGE) break;
  }

  const { data: settings, error: settingsErr } = await db
    .from('settings')
    .select('logo_path, logo_url')
    .maybeSingle();
  if (settingsErr) throw settingsErr;
  const logoPath = (settings?.logo_path as string | null) ?? null;
  if (logoPath) await copyOne(ctx, 'branding', logoPath, null, null);
  else console.log('[files:copy] no logo on record');

  console.log(
    `[files:copy] ${confirm ? 'copied' : 'would copy'} ${tally.copied} (${(tally.bytes / 1024 / 1024).toFixed(1)} MB), ` +
      `already in S3 ${tally.skipped}, missing at source ${tally.missing}, failed ${tally.failed}`,
  );

  if (rewriteLogo && logoPath && tally.failed === 0) {
    const logoUrl = createS3FileStore(cfg, client).publicUrl('branding', logoPath);
    if (settings?.logo_url === logoUrl) {
      console.log('[files:copy] settings.logo_url already points at this API');
    } else {
      const { error } = await db.from('settings').update({ logo_url: logoUrl }).eq('id', true);
      if (error) throw error;
      console.log(`[files:copy] settings.logo_url → ${logoUrl}`);
      console.log(`[files:copy] (S3 object ${s3Key(cfg, 'branding', logoPath)}; restart the API to drop its cached settings)`);
    }
  }

  if (tally.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[files:copy]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
