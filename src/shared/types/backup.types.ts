/**
 * Database backup types — the API contract between the backup system
 * (src/services/backup/, `pnpm backup:*`) and the admin Database Backup screen.
 *
 * Nothing here ever carries a secret: no connection strings, no AWS keys, no
 * presigned URLs beyond the one-off download response.
 */

export type BackupType = 'daily' | 'weekly' | 'monthly' | 'manual';

export const BACKUP_TYPES: readonly BackupType[] = ['daily', 'weekly', 'monthly', 'manual'] as const;

/** The three classes that have a schedule and a retention pool (manual has neither). */
export const SCHEDULED_BACKUP_TYPES: readonly Exclude<BackupType, 'manual'>[] = ['daily', 'weekly', 'monthly'] as const;

/**
 * running   claimed, dump/upload in progress
 * success   uploaded + manifest written; the runner verifies immediately after
 * verified  S3 object size + SHA-256 re-confirmed (the only "good" terminal state)
 * failed    any step failed — see errorCategory
 * stale     a run whose process died mid-way, superseded by a newer claim
 */
export type BackupStatus = 'running' | 'success' | 'verified' | 'failed' | 'stale';

export type BackupTrigger = 'scheduler' | 'manual' | 'api';

/** Coarse, safe-to-display failure classes. The raw error never leaves the server log. */
export type BackupErrorCategory =
  | 'CONFIG_INVALID'
  | 'NOT_DUE'
  | 'LOCK_HELD'
  | 'DB_CONNECTION_FAILED'
  | 'PG_DUMP_FAILED'
  | 'DUMP_EMPTY'
  | 'DISK_ERROR'
  | 'CHECKSUM_FAILED'
  | 'S3_AUTH_FAILED'
  | 'S3_UPLOAD_FAILED'
  | 'S3_VERIFY_FAILED'
  | 'MANIFEST_FAILED'
  | 'INTERRUPTED'
  | 'STALE'
  | 'UNKNOWN';

/** One row of backup_jobs, camelCased. */
export interface BackupJob {
  id: string;
  backupId: string;
  backupType: BackupType;
  status: BackupStatus;
  trigger: BackupTrigger;
  environment: string;
  appVersion: string | null;
  databaseVersion: string | null;
  pgDumpVersion: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  dumpMs: number | null;
  uploadMs: number | null;
  s3Bucket: string;
  s3Key: string | null;
  authS3Key: string | null;
  manifestS3Key: string | null;
  fileSize: number | null;
  authFileSize: number | null;
  checksumSha256: string | null;
  authChecksumSha256: string | null;
  retentionUntil: string | null;
  attempts: number;
  errorCategory: BackupErrorCategory | string | null;
  errorMessage: string | null;
  triggeredBy: string | null;
  triggeredByName: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

/**
 * healthy   a verified backup exists inside the expected window
 * overdue   the last verified backup is older than the window + grace
 * failed    the most recent run failed (even if an older one is in-window)
 * never     no verified backup of this type has ever completed
 */
export type BackupHealthStatus = 'healthy' | 'overdue' | 'failed' | 'never';

export interface BackupTypeHealth {
  status: BackupHealthStatus;
  lastSuccessfulAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptStatus: BackupStatus | null;
  /** Hours since the last verified backup, or null if none. */
  ageHours: number | null;
  /** The window (hours) after which this type is considered overdue. */
  expectedWithinHours: number;
}

export interface BackupHealth {
  daily: BackupTypeHealth;
  weekly: BackupTypeHealth;
  monthly: BackupTypeHealth;
  /** The count of failed runs in the trailing 7 days, across all types. */
  recentFailures: number;
  checkedAt: string;
}

/** GET /api/admin/backups/status */
export interface BackupStatusResponse {
  health: BackupHealth;
  latest: Record<BackupType, BackupJob | null>;
  running: BackupJob[];
  /** Object storage location (bucket + prefix) — a path, not a credential. */
  storage: { bucket: string; prefix: string; region: string | null };
  retention: { dailyDays: number; weeklyDays: number; monthlyDays: number; manualDays: number; authority: 'lifecycle' | 'application' };
  schedule: { timezone: string; daily: string; weekly: string; monthly: string };
}

export interface BackupHistoryResponse {
  jobs: BackupJob[];
  total: number;
  page: number;
  pageSize: number;
}

/** One check of POST /:id/verify. */
export interface BackupVerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface BackupVerifyResult {
  backupId: string;
  ok: boolean;
  verifiedAt: string;
  checks: BackupVerifyCheck[];
}

/** POST /run response — the job was claimed and is running in the background. */
export interface BackupRunResponse {
  backupId: string;
  outcome: 'started' | 'already_completed' | 'in_progress' | 'not_due';
  message: string;
}

export interface BackupDownloadUrlResponse {
  url: string;
  expiresInSeconds: number;
  fileName: string;
}

/**
 * The immutable JSON manifest written to
 * database-backups/manifests/<type>/YYYY/MM/<backup_id>.json alongside each
 * successful backup. This is the authoritative off-site record.
 */
export interface BackupManifest {
  manifestVersion: 1;
  backupId: string;
  backupType: BackupType;
  databaseName: string;
  /** Project identifier only (never the host, user or password). */
  databaseRef: string | null;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  environment: string;
  appVersion: string | null;
  databaseVersion: string | null;
  pgDumpVersion: string | null;
  format: 'pg_dump-custom';
  compression: string;
  files: BackupManifestFile[];
  retentionUntil: string;
  retentionDays: number;
  scope: {
    schemas: string[];
    tables: string[];
    excluded: string[];
  };
  status: 'completed';
  checksumAlgorithm: 'sha256';
}

export interface BackupManifestFile {
  role: 'main' | 'auth';
  fileName: string;
  s3Key: string;
  fileSize: number;
  checksumSha256: string;
  /** S3 ETag as reported by HeadObject after upload (multipart ETags are not MD5). */
  etag: string | null;
}

export interface BackupRestoreTest {
  id: string;
  backupJobId: string | null;
  backupId: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  targetHostRedacted: string | null;
  tableCount: number | null;
  rowCounts: Record<string, number> | null;
  checks: BackupVerifyCheck[] | null;
  errorMessage: string | null;
  runBy: string | null;
  createdAt: string;
}
