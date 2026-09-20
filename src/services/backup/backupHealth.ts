import type { BackupHealth, BackupHealthStatus, BackupJob, BackupType, BackupTypeHealth } from '../../shared';

/**
 * Stale-backup detection. A type is healthy only when a VERIFIED backup exists
 * inside its expected window; an old backup existing somewhere is not health.
 *
 *   daily    every 24h  + 6h grace  = 30h
 *   weekly   every 7d   + 1d grace  = 192h
 *   monthly  every ~31d + 2d grace  = 792h
 */
export const EXPECTED_WITHIN_HOURS: Record<Exclude<BackupType, 'manual'>, number> = {
  daily: 30,
  weekly: 8 * 24,
  monthly: 33 * 24,
};

export interface HealthInput {
  /** Newest run of each type, any status. */
  latest: Record<BackupType, BackupJob | null>;
  /** Newest VERIFIED run of each type. */
  latestVerified: Record<BackupType, BackupJob | null>;
  recentFailures: number;
}

export function computeTypeHealth(type: Exclude<BackupType, 'manual'>, latest: BackupJob | null, latestVerified: BackupJob | null, now: Date): BackupTypeHealth {
  const expectedWithinHours = EXPECTED_WITHIN_HOURS[type];
  const lastSuccessfulAt = latestVerified?.completedAt ?? latestVerified?.startedAt ?? null;
  const ageHours = lastSuccessfulAt ? (now.getTime() - new Date(lastSuccessfulAt).getTime()) / 3_600_000 : null;

  let status: BackupHealthStatus;
  if (!latestVerified || ageHours === null) status = 'never';
  else if (latest && (latest.status === 'failed' || latest.status === 'stale') && latest.startedAt > (latestVerified.startedAt ?? '')) status = 'failed';
  else if (ageHours > expectedWithinHours) status = 'overdue';
  else status = 'healthy';

  return {
    status,
    lastSuccessfulAt,
    lastAttemptAt: latest?.startedAt ?? null,
    lastAttemptStatus: latest?.status ?? null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    expectedWithinHours,
  };
}

export function computeHealth(input: HealthInput, now: Date = new Date()): BackupHealth {
  return {
    daily: computeTypeHealth('daily', input.latest.daily, input.latestVerified.daily, now),
    weekly: computeTypeHealth('weekly', input.latest.weekly, input.latestVerified.weekly, now),
    monthly: computeTypeHealth('monthly', input.latest.monthly, input.latestVerified.monthly, now),
    recentFailures: input.recentFailures,
    checkedAt: now.toISOString(),
  };
}
