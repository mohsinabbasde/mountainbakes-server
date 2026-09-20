import 'dotenv/config';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { supabaseAdmin } from '../config/supabase';
import { getBackupConfig, getS3Client } from '../config/s3';

/**
 * Daily backup: export every table in the public schema to S3 as gzipped
 * NDJSON, one object per table plus a manifest. Read-only against Supabase —
 * it never writes back — and idempotent against S3: re-running the same UTC
 * day overwrites that day's objects.
 *
 * Table list comes from public.list_public_base_tables() (migration 116),
 * not a hardcoded array, so a newly added table is backed up automatically
 * instead of silently missed. A handful of tables are excluded below —
 * transient or security/session telemetry, not business data.
 *
 * Meant to run on Heroku Scheduler (its own one-off dyno), not the in-process
 * node-cron schedulers in src/scheduler/ — see DEPLOY.md.
 *
 * Usage (from server/):
 *   pnpm backup:s3                    # normal daily run
 *   pnpm backup:s3 -- --include-excluded   # one-off: also export excluded tables
 *
 * Exit codes:
 *   0  every non-excluded table backed up successfully
 *   1  the run never started (bad config / unreachable bucket / couldn't list
 *      tables), OR it ran but one or more tables failed (see the manifest)
 */

const PAGE_SIZE = 1000;

const EXCLUDED_TABLES = new Set<string>([
  'idempotency_keys', // transient write-guard state; has its own retention script (purge-idempotency-keys.ts)
  'login_attempts', // security/session telemetry, not business data — shrinks blast radius of a leaked backup
  'login_sessions', // security/session telemetry, not business data
  'geofence_logs', // coarse IP-derived location telemetry, not business data
  'push_subscriptions', // holds push endpoint secrets; a dead subscription is just re-issued by the device
]);

const includeExcluded = process.argv.includes('--include-excluded');

interface TableInfo {
  table_name: string;
  primary_key_columns: string[];
}

interface ManifestEntry {
  table: string;
  rowCount: number;
  compressedBytes: number;
  orderedBy: string[] | 'created_at' | 'none';
  error?: string;
}

async function preflightCheckBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach S3 bucket "${bucket}": ${message}. Check BACKUP_S3_BUCKET, AWS_REGION and credentials.`
    );
  }
}

async function backupTable(
  s3: S3Client,
  bucket: string,
  keyPrefix: string,
  table: TableInfo
): Promise<ManifestEntry> {
  const key = `${keyPrefix}/${table.table_name}.jsonl.gz`;

  const passThrough = new PassThrough();
  const gzip = zlib.createGzip();
  passThrough.pipe(gzip);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: gzip,
      ContentType: 'application/x-ndjson',
      ContentEncoding: 'gzip',
    },
  });
  const uploadDone = upload.done();
  uploadDone.catch(() => undefined); // surfaced via the awaited call below; this just avoids an unhandled rejection if the export loop throws first

  let orderColumns = table.primary_key_columns;
  let orderedBy: ManifestEntry['orderedBy'] = orderColumns.length > 0 ? [...orderColumns] : 'none';

  if (orderColumns.length === 0) {
    // No primary key — probe for created_at as a stable-ish fallback order.
    // .range() pagination is only gapless with an explicit ORDER BY.
    const probe = await supabaseAdmin.from(table.table_name).select('created_at').limit(1);
    if (!probe.error) {
      orderColumns = ['created_at'];
      orderedBy = 'created_at';
    } else {
      console.warn(
        `[${table.table_name}] no primary key and no created_at column — export order is not guaranteed stable.`
      );
    }
  }

  try {
    let from = 0;
    let rowCount = 0;
    for (;;) {
      let query = supabaseAdmin.from(table.table_name).select('*');
      for (const col of orderColumns) query = query.order(col, { ascending: true });
      query = query.range(from, from + PAGE_SIZE - 1);

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) passThrough.write(JSON.stringify(row) + '\n');
      rowCount += data.length;
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    passThrough.end();
    await uploadDone;

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { table: table.table_name, rowCount, compressedBytes: head.ContentLength ?? 0, orderedBy };
  } catch (err) {
    passThrough.destroy();
    gzip.destroy();
    throw err;
  }
}

async function main() {
  console.log('Mountain Bakes ERP — Supabase → S3 Backup');
  console.log('==========================================');

  // Preflight — any failure here aborts the whole run before touching a table.
  const config = getBackupConfig();
  const s3 = getS3Client();
  await preflightCheckBucket(s3, config.bucket);

  const { data, error: listErr } = await supabaseAdmin.rpc('list_public_base_tables');
  if (listErr) throw new Error(`Could not list tables: ${listErr.message}`);

  const allTables = (data ?? []) as TableInfo[];
  const targets = allTables.filter((t) => includeExcluded || !EXCLUDED_TABLES.has(t.table_name));

  const date = new Date().toISOString().slice(0, 10);
  const keyPrefix = `${config.prefix}/${date}`;

  console.log(`Exporting ${targets.length} of ${allTables.length} tables to s3://${config.bucket}/${keyPrefix}/`);
  if (!includeExcluded) console.log(`Excluded: ${Array.from(EXCLUDED_TABLES).join(', ')}`);

  // Per-table failures are caught and recorded here — one bad table does not
  // stop the rest of the backup from running.
  const manifestEntries: ManifestEntry[] = [];
  for (const table of targets) {
    console.log(`\n[${table.table_name}] starting…`);
    try {
      const entry = await backupTable(s3, config.bucket, keyPrefix, table);
      manifestEntries.push(entry);
      console.log(`[${table.table_name}] done — ${entry.rowCount} rows, ${entry.compressedBytes} bytes compressed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      manifestEntries.push({ table: table.table_name, rowCount: 0, compressedBytes: 0, orderedBy: 'none', error: message });
      console.error(`[${table.table_name}] FAILED — ${message}`);
    }
  }

  const failedTables = manifestEntries.filter((e) => e.error).map((e) => e.table);
  const manifest = {
    generatedAt: new Date().toISOString(),
    bucket: config.bucket,
    prefix: keyPrefix,
    excludedTables: includeExcluded ? [] : Array.from(EXCLUDED_TABLES),
    status: failedTables.length === 0 ? 'success' : 'partial_failure',
    failedTables,
    tables: manifestEntries,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${keyPrefix}/_manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log(`\n${manifestEntries.length - failedTables.length}/${manifestEntries.length} tables backed up.`);
  if (failedTables.length > 0) {
    console.error(`Failed: ${failedTables.join(', ')} — see ${keyPrefix}/_manifest.json`);
    process.exit(1);
  }
  console.log('✔ Backup complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nBackup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
