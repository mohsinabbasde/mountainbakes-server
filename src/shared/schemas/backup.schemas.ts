import { z } from 'zod';

export const BackupTypeSchema = z.enum(['daily', 'weekly', 'monthly', 'manual']);

export const BackupStatusSchema = z.enum(['running', 'success', 'verified', 'failed', 'stale']);

/** POST /api/admin/backups/run */
export const RunBackupSchema = z.object({
  type: BackupTypeSchema.default('manual'),
  /** Run a weekly/monthly even when it is not its scheduled day. */
  force: z.boolean().optional(),
});
export type RunBackupInput = z.infer<typeof RunBackupSchema>;

/** GET /api/admin/backups/history query string */
export const BackupHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: BackupTypeSchema.optional(),
  status: BackupStatusSchema.optional(),
});
export type BackupHistoryQuery = z.infer<typeof BackupHistoryQuerySchema>;

const ManifestFileSchema = z.object({
  role: z.enum(['main', 'auth']),
  fileName: z.string().min(1),
  s3Key: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  etag: z.string().nullable(),
});

/**
 * Validates a manifest read back from S3 before anything trusts it (verify,
 * retention, restore test). A manifest that fails this is treated as absent.
 */
export const BackupManifestSchema = z.object({
  manifestVersion: z.literal(1),
  backupId: z.string().min(1),
  backupType: BackupTypeSchema,
  databaseName: z.string(),
  databaseRef: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  environment: z.string(),
  appVersion: z.string().nullable(),
  databaseVersion: z.string().nullable(),
  pgDumpVersion: z.string().nullable(),
  format: z.literal('pg_dump-custom'),
  compression: z.string(),
  files: z.array(ManifestFileSchema).min(1),
  retentionUntil: z.string(),
  retentionDays: z.number().int().positive(),
  scope: z.object({
    schemas: z.array(z.string()),
    tables: z.array(z.string()),
    excluded: z.array(z.string()),
  }),
  status: z.literal('completed'),
  checksumAlgorithm: z.literal('sha256'),
});
