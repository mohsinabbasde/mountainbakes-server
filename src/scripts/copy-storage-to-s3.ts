import { supabaseAdmin } from '../config/supabase';
import { getS3Client } from '../services/backup/backupConfig';
import {
  createS3FileStore,
  fileStorageDriver,
  s3FileConfig,
  s3Key,
  s3ObjectSize,
  type FileBucket,
} from '../services/file-store';

/**
 * Copy every stored file from Supabase Storage to S3, so FILE_STORAGE_DRIVER
 * can be switched to `s3` without losing a photo.
 *
 *   pnpm files:copy                      report what would be copied; writes nothing
 *   pnpm files:copy --confirm            copy
 *   pnpm files:copy --confirm --rewrite-logo-url
 *                                        copy, then point settings.logo_url at S3
 *
 * WHAT IT COPIES. Every row of `attachments` (the row is what makes a file
 * findable, so a file with no row is not worth moving) and the one logo named
 * by `settings.logo_path`. Paths are kept as they are — the S3 key is
 * `<FILES_S3_PREFIX>/<bucket>/<path>` — so no row changes except the logo URL.
 *
 * RE-RUNNABLE. A file already in S3 at its recorded size is skipped, so a
 * second run copies only what arrived since the first. That is the changeover:
 *
 *   1. pnpm files:copy --confirm              (the API is still on Supabase)
 *   2. set FILE_STORAGE_DRIVER=s3, restart    (new uploads now go to S3)
 *   3. pnpm files:copy --confirm --rewrite-logo-url
 *                                             (picks up uploads made between 1 and 2)
 *
 * It never deletes anything, on either side. Supabase Storage keeps its copy.
 */

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

    const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
    if (error || !data) {
      tally.missing++;
      console.warn(`  missing at source: ${bucket}/${path}${error ? ` (${error.message})` : ''}`);
      return;
    }
    const body = Buffer.from(await data.arrayBuffer());
    await createS3FileStore(cfg, client).upload(bucket, path, body, contentType || data.type || 'application/octet-stream');

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
  console.log(`[files:copy] target s3://${cfg.bucket}/${cfg.prefix}/   API driver is currently "${fileStorageDriver()}"`);

  // Keyset over (created_at, id) would be tidier, but rows are append-only and
  // nothing here deletes, so a stable order plus an offset cannot skip a row.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('attachments')
      .select('storage_path, size_bytes, mime_type')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    // Eight at a time: quick enough for a few thousand photos, and gentle on
    // a Storage API that is also serving the live app.
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(rows.slice(i, i + 8).map((r) =>
        copyOne(ctx, 'attachments', r.storage_path as string, Number(r.size_bytes), r.mime_type as string)));
    }
    console.log(`[files:copy] attachments: ${from + rows.length} row(s) examined`);
    if (rows.length < PAGE) break;
  }

  const { data: settings, error: settingsErr } = await supabaseAdmin
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
      console.log('[files:copy] settings.logo_url already points at S3');
    } else {
      const { error } = await supabaseAdmin.from('settings').update({ logo_url: logoUrl }).eq('id', true);
      if (error) throw error;
      console.log(`[files:copy] settings.logo_url → ${logoUrl}`);
      console.log(`[files:copy] (S3 object ${s3Key(cfg, 'branding', logoPath)}; restart the API to drop its cached settings)`);
    }
  }

  if (tally.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[files:copy]', err instanceof Error ? err.message : err);
  process.exit(1);
});
