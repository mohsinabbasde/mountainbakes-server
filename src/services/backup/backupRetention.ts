import type { BackupJob, BackupType } from '../../shared';
import type { RetentionDays } from './backupConfig';
import { parseBackupKey } from './backupNaming';
import type { BackupStorage, StoredObject } from './s3BackupStorage';
import { BackupError } from './errors';

/**
 * Retention — reporting first, deletion only on explicit request.
 *
 * The AUTHORITY for deletion is the S3 Lifecycle configuration (see
 * docs/database-backup.md): daily/ 7 days, weekly/ 35 days, monthly/ 366
 * days, manual/ 90 days, each rule scoped to its own prefix so the daily rule
 * can never touch a monthly backup. This module computes the same answer from
 * the objects and the ledger so the status screen and `backup:retention` can
 * SHOW what is expired, and — only when BACKUP_RETENTION_AUTHORITY=application
 * AND --confirm are both present — perform the same deletions itself.
 *
 * Safety rules, all enforced here regardless of who asked:
 *   - only keys that parse as <prefix>/<type>/YYYY/MM/mountainbakes-<type>-<label>[-auth].dump
 *   - only objects whose backup has a VERIFIED ledger row (a failed run's
 *     leftovers are not "a backup" and are left for lifecycle)
 *   - never the newest verified backup of a type, however old
 *   - only when retention_until (ledger, else lastModified + policy days) is
 *     in the past
 *   - one DeleteObject per key, each re-checked with HeadObject first; no
 *     bulk delete, no wildcard
 */

export interface RetentionItem {
  key: string;
  type: BackupType;
  label: string;
  role: 'main' | 'auth';
  size: number;
  lastModified: Date | null;
  retentionUntil: Date | null;
  backupId: string;
  source: 'ledger' | 'lastModified';
}

export interface RetentionPlan {
  now: Date;
  keep: RetentionItem[];
  expire: RetentionItem[];
  skipped: { key: string; reason: string }[];
}

export interface PlanOptions {
  prefix: string;
  now: Date;
  retentionDays: RetentionDays;
}

export function planRetention(objects: StoredObject[], verifiedJobs: BackupJob[], opts: PlanOptions): RetentionPlan {
  const plan: RetentionPlan = { now: opts.now, keep: [], expire: [], skipped: [] };
  const jobsById = new Map(verifiedJobs.map((j) => [j.backupId, j]));

  // Newest verified backup per type is protected no matter what.
  const newestByType = new Map<BackupType, BackupJob>();
  for (const j of verifiedJobs) {
    const cur = newestByType.get(j.backupType);
    if (!cur || j.startedAt > cur.startedAt) newestByType.set(j.backupType, j);
  }

  for (const obj of objects) {
    const parsed = parseBackupKey(opts.prefix, obj.key);
    if (!parsed) {
      plan.skipped.push({ key: obj.key, reason: 'outside the backup layout (manifest or foreign object)' });
      continue;
    }
    const backupId = `backup-${parsed.type}-${parsed.label}`;
    const job = jobsById.get(backupId);
    if (!job) {
      plan.skipped.push({ key: obj.key, reason: 'no verified ledger row for this backup' });
      continue;
    }
    if (newestByType.get(parsed.type)?.backupId === backupId) {
      plan.skipped.push({ key: obj.key, reason: `newest verified ${parsed.type} backup — never deleted by retention` });
      continue;
    }
    let retentionUntil: Date | null = null;
    let source: RetentionItem['source'] = 'ledger';
    if (job.retentionUntil) retentionUntil = new Date(job.retentionUntil);
    else if (obj.lastModified) {
      retentionUntil = new Date(obj.lastModified.getTime() + opts.retentionDays[parsed.type] * 86_400_000);
      source = 'lastModified';
    }
    const item: RetentionItem = {
      key: obj.key,
      type: parsed.type,
      label: parsed.label,
      role: parsed.role,
      size: obj.size,
      lastModified: obj.lastModified,
      retentionUntil,
      backupId,
      source,
    };
    if (retentionUntil && retentionUntil.getTime() < opts.now.getTime()) plan.expire.push(item);
    else plan.keep.push(item);
  }
  return plan;
}

export interface ApplyOptions {
  confirm: boolean;
  authority: 'lifecycle' | 'application';
  prefix: string;
  now: Date;
  log?: (line: string) => void;
}

export interface ApplyResult {
  dryRun: boolean;
  deleted: string[];
  refused: { key: string; reason: string }[];
}

export async function applyRetention(plan: RetentionPlan, storage: BackupStorage, opts: ApplyOptions): Promise<ApplyResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const result: ApplyResult = { dryRun: !opts.confirm, deleted: [], refused: [] };
  if (!opts.confirm) return result;
  if (opts.authority !== 'application') {
    throw new BackupError(
      'CONFIG_INVALID',
      'Refusing to delete: BACKUP_RETENTION_AUTHORITY is "lifecycle". S3 Lifecycle rules own expiry; set BACKUP_RETENTION_AUTHORITY=application to let this command delete.',
    );
  }
  for (const item of plan.expire) {
    if (!item.key.startsWith(`${opts.prefix}/${item.type}/`)) {
      result.refused.push({ key: item.key, reason: 'key is not under the expected type prefix' });
      continue;
    }
    if (!item.retentionUntil || item.retentionUntil.getTime() >= opts.now.getTime()) {
      result.refused.push({ key: item.key, reason: 'not expired' });
      continue;
    }
    const head = await storage.head(item.key);
    if (!head) {
      result.refused.push({ key: item.key, reason: 'already gone' });
      continue;
    }
    const metaUntil = head.metadata?.['retention-until'];
    if (metaUntil && new Date(metaUntil).getTime() >= opts.now.getTime()) {
      result.refused.push({ key: item.key, reason: 'object metadata says retention-until is in the future' });
      continue;
    }
    await storage.deleteObject(item.key);
    result.deleted.push(item.key);
    log(`[backup] retention deleted ${item.key} (expired ${item.retentionUntil.toISOString()})`);
  }
  return result;
}
