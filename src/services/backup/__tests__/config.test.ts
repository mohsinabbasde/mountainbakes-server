import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { databaseRefFromUrl, getBackupSystemConfig, redactSecrets } from '../backupConfig';
import { BackupError } from '../errors';

const GOOD: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  BACKUP_ENABLED: 'true',
  AWS_REGION: 'ap-northeast-1',
  AWS_ACCESS_KEY_ID: 'AKIA_TEST',
  AWS_SECRET_ACCESS_KEY: 'verysecretkey123',
  BACKUP_S3_BUCKET: 'mountainbakes-development-backups',
  SUPABASE_DB_URL: 'postgresql://postgres.abcdefghijklmnopqrst:p%40ssw0rd@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
};

function expectErrors(env: NodeJS.ProcessEnv, ...fragments: string[]) {
  try {
    getBackupSystemConfig({ env });
    assert.fail('expected a CONFIG_INVALID error');
  } catch (err) {
    assert.ok(err instanceof BackupError, String(err));
    assert.equal(err.category, 'CONFIG_INVALID');
    for (const f of fragments) assert.match(err.message, new RegExp(f));
  }
}

describe('backup configuration', () => {
  it('accepts a complete development configuration and parses the project ref', () => {
    const cfg = getBackupSystemConfig({ env: GOOD });
    assert.equal(cfg.bucket, 'mountainbakes-development-backups');
    assert.equal(cfg.prefix, 'database-backups');
    assert.equal(cfg.databaseRef, 'abcdefghijklmnopqrst');
    assert.deepEqual(cfg.retentionDays, { daily: 7, weekly: 35, monthly: 366, manual: 90 });
    assert.equal(cfg.retentionAuthority, 'lifecycle');
    assert.ok(cfg.secrets.includes('p@ssw0rd'), 'decoded password is a known secret');
  });

  it('reports every missing variable at once', () => {
    expectErrors({}, 'BACKUP_ENABLED', 'AWS_REGION', 'BACKUP_S3_BUCKET', 'SUPABASE_DB_URL', 'AWS credentials');
  });

  it('refuses the production bucket outside production unless explicitly allowed', () => {
    expectErrors({ ...GOOD, BACKUP_S3_BUCKET: 'mountainbakes-bucket' }, 'production bucket');
    const cfg = getBackupSystemConfig({ env: { ...GOOD, BACKUP_S3_BUCKET: 'mountainbakes-bucket', BACKUP_ALLOW_PRODUCTION_BUCKET: 'true' } });
    assert.equal(cfg.bucket, 'mountainbakes-bucket');
  });

  it('requires the production bucket in production', () => {
    expectErrors({ ...GOOD, NODE_ENV: 'production' }, 'must be "mountainbakes-bucket"');
    const cfg = getBackupSystemConfig({ env: { ...GOOD, NODE_ENV: 'production', BACKUP_S3_BUCKET: 'mountainbakes-bucket' } });
    assert.equal(cfg.isProduction, true);
  });

  it('rejects invalid retention, timezone, authority and the transaction pooler port', () => {
    expectErrors({ ...GOOD, BACKUP_DAILY_RETENTION_DAYS: '0' }, 'BACKUP_DAILY_RETENTION_DAYS');
    expectErrors({ ...GOOD, BACKUP_MONTHLY_RETENTION_DAYS: 'twelve' }, 'BACKUP_MONTHLY_RETENTION_DAYS');
    expectErrors({ ...GOOD, BACKUP_TIMEZONE: 'UTC' }, 'BACKUP_TIMEZONE');
    expectErrors({ ...GOOD, BACKUP_RETENTION_AUTHORITY: 'nobody' }, 'BACKUP_RETENTION_AUTHORITY');
    expectErrors({ ...GOOD, SUPABASE_DB_URL: 'postgresql://u:p@host:6543/postgres' }, '6543');
  });

  it('does not require the database URL or the enabled flag when told not to', () => {
    const env = { ...GOOD };
    delete env.SUPABASE_DB_URL;
    delete env.BACKUP_ENABLED;
    const cfg = getBackupSystemConfig({ env, requireDatabase: false, requireEnabled: false });
    assert.equal(cfg.dbUrl, null);
    assert.equal(cfg.enabled, false);
  });

  it('redacts URL passwords and known secret values', () => {
    const text = 'pg_dump: error: connection to server at "postgresql://postgres.ref:p@ssw0rd@host:5432/db" failed; key verysecretkey123 leaked';
    const out = redactSecrets(text, ['p@ssw0rd', 'verysecretkey123']);
    assert.ok(!out.includes('p@ssw0rd'));
    assert.ok(!out.includes('verysecretkey123'));
    assert.ok(out.includes('postgres.ref:***@host'));
    assert.equal(databaseRefFromUrl('postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'), 'abcdefghijklmnopqrst');
  });
});
