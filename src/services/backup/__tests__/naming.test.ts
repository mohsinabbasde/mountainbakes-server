import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backupIdFor, buildBackupPlan, isDue, isoWeekOf, labelFor, parseBackupKey, previousMonthOf } from '../backupNaming';

const cfg = { prefix: 'database-backups', retentionDays: { daily: 7, weekly: 35, monthly: 366, manual: 90 } };

describe('backup naming', () => {
  it('names the daily backup for the Karachi date, not the UTC date', () => {
    // 22:00 UTC Sunday 20 Sep = 03:00 PKT Monday 21 Sep
    const now = new Date('2026-09-20T22:00:00Z');
    assert.equal(labelFor('daily', now), '2026-09-21');
    assert.equal(backupIdFor('daily', now), 'backup-daily-2026-09-21');
    const plan = buildBackupPlan('daily', now, cfg);
    assert.equal(plan.mainKey, 'database-backups/daily/2026/09/mountainbakes-daily-2026-09-21.dump');
    assert.equal(plan.authKey, 'database-backups/daily/2026/09/mountainbakes-daily-2026-09-21-auth.dump');
    assert.equal(plan.manifestKey, 'database-backups/manifests/daily/2026/09/backup-daily-2026-09-21.json');
    assert.equal(plan.retentionUntil.toISOString(), '2026-09-27T22:00:00.000Z');
  });

  it('uses the ISO week of the Karachi run date for weekly backups', () => {
    // Saturday 22:45 UTC = Sunday 03:45 PKT, 2026-09-20 is ISO week 38
    const now = new Date('2026-09-19T22:45:00Z');
    assert.equal(labelFor('weekly', now), '2026-W38');
    assert.equal(buildBackupPlan('weekly', now, cfg).mainKey, 'database-backups/weekly/2026/09/mountainbakes-weekly-2026-W38.dump');
  });

  it('handles ISO week-year boundaries', () => {
    assert.deepEqual(isoWeekOf('2027-01-01'), { year: 2026, week: 53 });
    assert.deepEqual(isoWeekOf('2026-01-01'), { year: 2026, week: 1 });
    assert.deepEqual(isoWeekOf('2024-12-30'), { year: 2025, week: 1 });
  });

  it('labels the monthly backup for the month that just ended and files it under that month', () => {
    // 23:30 UTC 30 Sep = 04:30 PKT 1 Oct
    const now = new Date('2026-09-30T23:30:00Z');
    assert.equal(labelFor('monthly', now), '2026-09');
    assert.equal(buildBackupPlan('monthly', now, cfg).mainKey, 'database-backups/monthly/2026/09/mountainbakes-monthly-2026-09.dump');
    assert.equal(previousMonthOf('2026-01-01'), '2025-12');
  });

  it('manual backups carry a UTC timestamp and never collide with scheduled names', () => {
    const now = new Date('2026-09-21T10:15:00Z');
    const plan = buildBackupPlan('manual', now, cfg);
    assert.equal(plan.backupId, 'backup-manual-2026-09-21T10-15-00Z');
    assert.equal(plan.mainKey, 'database-backups/manual/2026/09/mountainbakes-manual-2026-09-21T10-15-00Z.dump');
  });

  it('weekly is due only on a Karachi Sunday, monthly only on the Karachi 1st', () => {
    assert.equal(isDue('weekly', new Date('2026-09-19T22:45:00Z')).due, true); // Sunday 03:45 PKT
    assert.equal(isDue('weekly', new Date('2026-09-20T22:45:00Z')).due, false); // Monday PKT
    assert.equal(isDue('weekly', new Date('2026-09-20T18:00:00Z')).due, true); // still Sunday 23:00 PKT
    assert.equal(isDue('monthly', new Date('2026-09-30T23:30:00Z')).due, true); // 1 Oct 04:30 PKT
    assert.equal(isDue('monthly', new Date('2026-10-01T23:30:00Z')).due, false); // 2 Oct PKT
    assert.equal(isDue('daily', new Date()).due, true);
  });

  it('parses keys back to type/label/role and rejects foreign keys', () => {
    assert.deepEqual(parseBackupKey('database-backups', 'database-backups/daily/2026/09/mountainbakes-daily-2026-09-21.dump'), { type: 'daily', label: '2026-09-21', role: 'main' });
    assert.deepEqual(parseBackupKey('database-backups', 'database-backups/weekly/2026/09/mountainbakes-weekly-2026-W38-auth.dump'), { type: 'weekly', label: '2026-W38', role: 'auth' });
    assert.equal(parseBackupKey('database-backups', 'database-backups/manifests/daily/2026/09/backup-daily-2026-09-21.json'), null);
    assert.equal(parseBackupKey('database-backups', 'uploads/photo.jpg'), null);
    assert.equal(parseBackupKey('database-backups', 'database-backups/daily/2026/09/mountainbakes-weekly-2026-W38.dump'), null);
  });
});
