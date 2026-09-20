import { S3Client } from '@aws-sdk/client-s3';

/**
 * Lazy S3 client + config for the `backup:s3` script ONLY.
 *
 * Unlike src/config/supabase.ts, nothing here may throw at import time: this
 * file must stay safe to import even though nothing does yet, and the main
 * server (src/app.ts / server.ts) never imports it — it must keep booting
 * normally on a host with zero AWS environment variables set. Each getter
 * validates and throws only when actually CALLED, which only happens inside
 * src/scripts/backup-to-s3.ts.
 */

export interface BackupConfig {
  bucket: string;
  region: string;
  prefix: string;
}

export function getBackupConfig(): BackupConfig {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  const bucket = process.env.BACKUP_S3_BUCKET;

  const missing = [
    !accessKeyId && 'AWS_ACCESS_KEY_ID',
    !secretAccessKey && 'AWS_SECRET_ACCESS_KEY',
    !region && 'AWS_REGION',
    !bucket && 'BACKUP_S3_BUCKET',
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0) {
    throw new Error(
      `backup:s3 is not configured — missing ${missing.join(', ')}. Set them in the server ` +
        'environment (see server/.env.example, "S3 Backups" section).'
    );
  }

  return {
    bucket: bucket!,
    region: region!,
    prefix: process.env.BACKUP_S3_PREFIX || 'backups',
  };
}

let cachedClient: S3Client | undefined;

export function getS3Client(): S3Client {
  if (cachedClient) return cachedClient;

  const { region } = getBackupConfig();
  cachedClient = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return cachedClient;
}
