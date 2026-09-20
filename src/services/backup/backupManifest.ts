import type { BackupManifest, BackupManifestFile } from '../../shared';
import { BackupManifestSchema } from '../../shared';
import type { BackupPlan } from './backupNaming';
import { AUTH_TABLES, EXCLUDED_SCOPE, MAIN_SCHEMAS } from './postgresBackup';

export interface ManifestInput {
  plan: BackupPlan;
  files: BackupManifestFile[];
  startedAt: Date;
  completedAt: Date;
  environment: string;
  appVersion: string | null;
  databaseVersion: string | null;
  pgDumpVersion: string | null;
  databaseName: string;
  databaseRef: string | null;
}

/** The immutable per-run record. Contains paths and checksums — never credentials. */
export function buildManifest(input: ManifestInput): BackupManifest {
  return {
    manifestVersion: 1,
    backupId: input.plan.backupId,
    backupType: input.plan.backupType,
    databaseName: input.databaseName,
    databaseRef: input.databaseRef,
    createdAt: input.completedAt.toISOString(),
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    environment: input.environment,
    appVersion: input.appVersion,
    databaseVersion: input.databaseVersion,
    pgDumpVersion: input.pgDumpVersion,
    format: 'pg_dump-custom',
    compression: 'pg_dump --compress=6 (zlib, built into the custom format)',
    files: input.files,
    retentionUntil: input.plan.retentionUntil.toISOString(),
    retentionDays: input.plan.retentionDays,
    scope: {
      schemas: [...MAIN_SCHEMAS],
      tables: [...AUTH_TABLES],
      excluded: [...EXCLUDED_SCOPE],
    },
    status: 'completed',
    checksumAlgorithm: 'sha256',
  };
}

/** Validate a manifest read back from S3. Anything malformed is treated as absent. */
export function parseManifest(raw: unknown): BackupManifest | null {
  const parsed = BackupManifestSchema.safeParse(raw);
  return parsed.success ? (parsed.data as BackupManifest) : null;
}
