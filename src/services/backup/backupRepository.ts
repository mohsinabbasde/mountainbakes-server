import { supabaseAdmin } from '../../config/supabase';
import type { BackupJob, BackupRestoreTest, BackupStatus, BackupTrigger, BackupType } from '../../shared';
import { rowToApi } from '../../utils/case';

/**
 * backup_jobs / backup_restore_tests access, behind an interface so the runner
 * can be unit-tested with an in-memory double. The real implementation goes
 * through the service-role client like every other service — no `pg` client,
 * no second connection pool.
 */

export type ClaimResult = 'claimed' | 'already_completed' | 'in_progress';

export interface ClaimInput {
  backupId: string;
  backupType: BackupType;
  trigger: BackupTrigger;
  triggeredBy: string | null;
  triggeredByName: string | null;
  s3Bucket: string;
  environment: string;
  staleMs: number;
}

export interface JobPatch {
  status?: BackupStatus;
  completedAt?: string | null;
  durationMs?: number | null;
  dumpMs?: number | null;
  uploadMs?: number | null;
  s3Key?: string | null;
  authS3Key?: string | null;
  manifestS3Key?: string | null;
  fileSize?: number | null;
  authFileSize?: number | null;
  checksumSha256?: string | null;
  authChecksumSha256?: string | null;
  retentionUntil?: string | null;
  pgDumpVersion?: string | null;
  databaseVersion?: string | null;
  appVersion?: string | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
  lastVerifiedAt?: string | null;
}

export interface HistoryFilter {
  page: number;
  pageSize: number;
  type?: BackupType;
  status?: BackupStatus;
}

export interface RestoreTestInput {
  backupJobId: string | null;
  backupId: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  targetHostRedacted: string | null;
  tableCount: number | null;
  rowCounts: Record<string, number> | null;
  checks: { name: string; ok: boolean; detail?: string }[] | null;
  errorMessage: string | null;
  runBy: string | null;
}

export interface BackupRepository {
  claim(input: ClaimInput): Promise<ClaimResult>;
  update(backupId: string, patch: JobPatch): Promise<void>;
  getByBackupId(backupId: string): Promise<BackupJob | null>;
  getById(id: string): Promise<BackupJob | null>;
  latestByType(): Promise<Record<BackupType, BackupJob | null>>;
  latestVerifiedByType(): Promise<Record<BackupType, BackupJob | null>>;
  running(): Promise<BackupJob[]>;
  history(filter: HistoryFilter): Promise<{ jobs: BackupJob[]; total: number }>;
  verifiedJobs(): Promise<BackupJob[]>;
  countFailedSince(sinceIso: string): Promise<number>;
  recordRestoreTest(input: RestoreTestInput): Promise<BackupRestoreTest>;
  latestRestoreTest(): Promise<BackupRestoreTest | null>;
}

const TABLE = 'backup_jobs';
const RESTORE_TABLE = 'backup_restore_tests';
const TYPES: BackupType[] = ['daily', 'weekly', 'monthly', 'manual'];

function emptyByType(): Record<BackupType, BackupJob | null> {
  return { daily: null, weekly: null, monthly: null, manual: null };
}

function patchToRow(patch: JobPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const map: Record<keyof JobPatch, string> = {
    status: 'status',
    completedAt: 'completed_at',
    durationMs: 'duration_ms',
    dumpMs: 'dump_ms',
    uploadMs: 'upload_ms',
    s3Key: 's3_key',
    authS3Key: 'auth_s3_key',
    manifestS3Key: 'manifest_s3_key',
    fileSize: 'file_size',
    authFileSize: 'auth_file_size',
    checksumSha256: 'checksum_sha256',
    authChecksumSha256: 'auth_checksum_sha256',
    retentionUntil: 'retention_until',
    pgDumpVersion: 'pg_dump_version',
    databaseVersion: 'database_version',
    appVersion: 'app_version',
    errorCategory: 'error_category',
    errorMessage: 'error_message',
    lastVerifiedAt: 'last_verified_at',
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) row[map[k as keyof JobPatch]] = v;
  }
  return row;
}

export class SupabaseBackupRepository implements BackupRepository {
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const { data, error } = await supabaseAdmin.rpc('claim_backup_job', {
      p_backup_id: input.backupId,
      p_backup_type: input.backupType,
      p_trigger: input.trigger,
      p_triggered_by: input.triggeredBy,
      p_triggered_by_name: input.triggeredByName,
      p_s3_bucket: input.s3Bucket,
      p_environment: input.environment,
      p_stale_ms: input.staleMs,
    });
    if (error) throw new Error(`claim_backup_job failed: ${error.message}`);
    return data as ClaimResult;
  }

  async update(backupId: string, patch: JobPatch): Promise<void> {
    const { error } = await supabaseAdmin.from(TABLE).update(patchToRow(patch)).eq('backup_id', backupId);
    if (error) throw new Error(`backup_jobs update failed: ${error.message}`);
  }

  async getByBackupId(backupId: string): Promise<BackupJob | null> {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('backup_id', backupId).maybeSingle();
    if (error) throw error;
    return data ? rowToApi<BackupJob>(data) : null;
  }

  async getById(id: string): Promise<BackupJob | null> {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? rowToApi<BackupJob>(data) : null;
  }

  private async latestWhere(statuses: BackupStatus[] | null): Promise<Record<BackupType, BackupJob | null>> {
    const out = emptyByType();
    await Promise.all(
      TYPES.map(async (type) => {
        let q = supabaseAdmin.from(TABLE).select('*').eq('backup_type', type).order('started_at', { ascending: false }).limit(1);
        if (statuses) q = q.in('status', statuses);
        const { data, error } = await q;
        if (error) throw error;
        out[type] = data && data[0] ? rowToApi<BackupJob>(data[0]) : null;
      }),
    );
    return out;
  }

  latestByType(): Promise<Record<BackupType, BackupJob | null>> {
    return this.latestWhere(null);
  }

  latestVerifiedByType(): Promise<Record<BackupType, BackupJob | null>> {
    return this.latestWhere(['verified']);
  }

  async running(): Promise<BackupJob[]> {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('status', 'running').order('started_at', { ascending: false });
    if (error) throw error;
    return rowToApi<BackupJob[]>(data ?? []);
  }

  async history(filter: HistoryFilter): Promise<{ jobs: BackupJob[]; total: number }> {
    const from = (filter.page - 1) * filter.pageSize;
    let q = supabaseAdmin.from(TABLE).select('*', { count: 'exact' }).order('started_at', { ascending: false }).range(from, from + filter.pageSize - 1);
    if (filter.type) q = q.eq('backup_type', filter.type);
    if (filter.status) q = q.eq('status', filter.status);
    const { data, error, count } = await q;
    if (error) throw error;
    return { jobs: rowToApi<BackupJob[]>(data ?? []), total: count ?? 0 };
  }

  async verifiedJobs(): Promise<BackupJob[]> {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('status', 'verified').order('started_at', { ascending: false });
    if (error) throw error;
    return rowToApi<BackupJob[]>(data ?? []);
  }

  async countFailedSince(sinceIso: string): Promise<number> {
    const { count, error } = await supabaseAdmin
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .in('status', ['failed', 'stale'])
      .gte('started_at', sinceIso);
    if (error) throw error;
    return count ?? 0;
  }

  async recordRestoreTest(input: RestoreTestInput): Promise<BackupRestoreTest> {
    const { data, error } = await supabaseAdmin
      .from(RESTORE_TABLE)
      .insert({
        backup_job_id: input.backupJobId,
        backup_id: input.backupId,
        status: input.status,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        duration_ms: input.durationMs,
        target_host_redacted: input.targetHostRedacted,
        table_count: input.tableCount,
        row_counts: input.rowCounts,
        checks: input.checks,
        error_message: input.errorMessage,
        run_by: input.runBy,
      })
      .select('*')
      .single();
    if (error) throw error;
    return rowToApi<BackupRestoreTest>(data);
  }

  async latestRestoreTest(): Promise<BackupRestoreTest | null> {
    const { data, error } = await supabaseAdmin.from(RESTORE_TABLE).select('*').order('started_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data && data[0] ? rowToApi<BackupRestoreTest>(data[0]) : null;
  }
}
