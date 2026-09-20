import type { BackupTrigger, BackupType } from '../../shared';
import type { BackupRepository, ClaimResult, JobPatch } from './backupRepository';

/**
 * The cross-process lock is a backup_jobs row in status 'running', claimed by
 * the claim_backup_job() RPC (migration 117). This wrapper adds the two things
 * the runner needs around it: a handle whose release() writes the terminal
 * state exactly once, and a guarantee that a lock is never left 'running' when
 * the process is told to stop.
 */

export interface BackupLockHandle {
  readonly backupId: string;
  readonly released: boolean;
  /** Write the terminal state. Idempotent — a second call is ignored. */
  release(patch: JobPatch & { status: 'verified' | 'success' | 'failed' }): Promise<void>;
}

export interface AcquireInput {
  backupId: string;
  backupType: BackupType;
  trigger: BackupTrigger;
  triggeredBy: string | null;
  triggeredByName: string | null;
  s3Bucket: string;
  environment: string;
  staleMs: number;
}

export type AcquireResult = { result: 'claimed'; lock: BackupLockHandle } | { result: Exclude<ClaimResult, 'claimed'> };

export async function acquireBackupLock(repo: BackupRepository, input: AcquireInput): Promise<AcquireResult> {
  const result = await repo.claim(input);
  if (result !== 'claimed') return { result };

  let released = false;
  const lock: BackupLockHandle = {
    backupId: input.backupId,
    get released() {
      return released;
    },
    async release(patch) {
      if (released) return;
      released = true;
      await repo.update(input.backupId, patch);
    },
  };
  return { result: 'claimed', lock };
}
