import { supabaseAdmin } from '../../config/supabase';
import { getBackupSystemConfig, getS3Client, type BackupSystemConfig, type ConfigOptions } from './backupConfig';
import { SupabaseBackupRepository } from './backupRepository';
import { BackupStorage } from './s3BackupStorage';
import { alertBackupFailure } from './backupAlerts';
import type { BackupDeps, DatabaseInfo } from './backupService';

/**
 * Wire the real collaborators. Called by the CLI and the admin API; the unit
 * tests build a BackupDeps of their own with in-memory doubles instead.
 */

export async function fetchDatabaseInfo(): Promise<DatabaseInfo> {
  try {
    const { data, error } = await supabaseAdmin.rpc('backup_database_info');
    if (error) throw error;
    const d = (data ?? {}) as Record<string, unknown>;
    return {
      serverVersion: typeof d.server_version === 'string' ? d.server_version : null,
      databaseName: typeof d.database_name === 'string' ? d.database_name : null,
      sizeBytes: typeof d.size_bytes === 'number' ? d.size_bytes : Number(d.size_bytes) || null,
      publicTableCount: typeof d.public_table_count === 'number' ? d.public_table_count : Number(d.public_table_count) || null,
    };
  } catch (err) {
    console.warn(`[backup] backup_database_info unavailable (${err instanceof Error ? err.message : err}) — manifest will omit the server version`);
    return { serverVersion: null, databaseName: null, sizeBytes: null, publicTableCount: null };
  }
}

export function createBackupDeps(opts: ConfigOptions & { signal?: AbortSignal; config?: BackupSystemConfig } = {}): BackupDeps {
  const config = opts.config ?? getBackupSystemConfig(opts);
  const log = (line: string) => console.log(line);
  return {
    config,
    storage: new BackupStorage({ s3: getS3Client(config.region), bucket: config.bucket, log }),
    repo: new SupabaseBackupRepository(),
    pg: { pgBinDir: config.pgBinDir, secrets: config.secrets, log },
    now: () => new Date(),
    log,
    alert: (alert) => alertBackupFailure(alert, { messaging: config.alertMessaging }),
    databaseInfo: fetchDatabaseInfo,
    signal: opts.signal,
  };
}
