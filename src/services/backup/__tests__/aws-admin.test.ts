import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { desiredLifecycleRules, diffLifecycle } from '../awsAdmin';

const RET = { daily: 7, weekly: 35, monthly: 366, manual: 90 };

describe('S3 lifecycle policy', () => {
  it('scopes each retention class to its own prefix so the daily rule can never touch monthly', () => {
    const rules = desiredLifecycleRules('database-backups', RET);
    const byId = Object.fromEntries(rules.map((r) => [r.ID, r]));
    assert.equal(byId['mountainbakes-db-backups-daily'].Filter?.Prefix, 'database-backups/daily/');
    assert.equal(byId['mountainbakes-db-backups-daily'].Expiration?.Days, 7);
    assert.equal(byId['mountainbakes-db-backups-weekly'].Expiration?.Days, 35);
    assert.equal(byId['mountainbakes-db-backups-monthly'].Expiration?.Days, 366);
    assert.deepEqual(byId['mountainbakes-db-backups-monthly'].Transitions, [{ Days: 30, StorageClass: 'STANDARD_IA' }]);
    assert.equal(byId['mountainbakes-db-backups-manual'].Expiration?.Days, 90);
    assert.equal(byId['mountainbakes-db-backups-manifests'].Expiration?.Days, 400);
    assert.equal(byId['mountainbakes-db-backups-abort-incomplete-multipart'].AbortIncompleteMultipartUpload?.DaysAfterInitiation, 2);
    for (const r of rules) {
      if (r.Expiration) assert.deepEqual(r.NoncurrentVersionExpiration, { NoncurrentDays: 1 }, `${r.ID} handles versioned buckets`);
    }
  });

  it('merges by rule ID and preserves foreign rules', () => {
    const desired = desiredLifecycleRules('database-backups', RET);
    const foreign = { ID: 'uploads-cleanup', Status: 'Enabled' as const, Filter: { Prefix: 'uploads/' }, Expiration: { Days: 30 } };
    const stale = { ...desired[0], Expiration: { Days: 3 } };
    const diff = diffLifecycle([foreign, stale], desired);
    assert.deepEqual(diff.foreign, ['uploads-cleanup']);
    assert.deepEqual(diff.changed, ['mountainbakes-db-backups-daily']);
    assert.equal(diff.missing.length, desired.length - 1);
    assert.equal(diff.merged.length, desired.length + 1);
    assert.ok(diff.merged.some((r) => r.ID === 'uploads-cleanup'));
    assert.equal(diff.merged.find((r) => r.ID === 'mountainbakes-db-backups-daily')?.Expiration?.Days, 7);
    const again = diffLifecycle(diff.merged, desired);
    assert.equal(again.missing.length + again.changed.length, 0, 'idempotent');
  });
});
