# Database Backup System

Automated, verified PostgreSQL backups of the Mountain Bakes Supabase database
to `s3://mountainbakes-bucket/database-backups/`.

Related: [database-backup-audit.md](database-backup-audit.md) (what existed
before), [database-restore.md](database-restore.md) (how to restore),
[database-disaster-recovery.md](database-disaster-recovery.md) (RPO/RTO,
scenarios), [../DEPLOY.md](../DEPLOY.md) (Heroku steps).

## Architecture

```
Heroku Scheduler (one-off dyno, 22:00 / 22:45 / 23:30 UTC)
        │  pnpm backup:daily | weekly | monthly          Admin → Database Backup → "Create backup"
        ▼                                                        │ POST /api/admin/backups/run (super_admin)
  src/scripts/backup.ts ──────────────────────────────────────────┘
        │
        ▼
  runBackup()  src/services/backup/backupService.ts
        │
        ├─ isDue?  (Karachi calendar gate for weekly/monthly)
        ├─ claim_backup_job()  ── Postgres row lock, one 'running' per type across all dynos
        ├─ duplicate check     ── manifest + HeadObject: same-day re-run uploads nothing
        ├─ pg_dump --version, connection probe (tiny schema-only dump)
        ├─ pg_dump -Fc -Z 6  --schema=public --schema=app --schema=supabase_migrations   → main .dump
        ├─ pg_dump -Fc -Z 6  --table=auth.users --table=auth.identities                   → -auth.dump
        ├─ SHA-256 (streamed)
        ├─ multipart upload ×2   SSE-S3, metadata {sha256, backup-id, backup-type, retention-until}, 3 attempts 1s/4s/16s
        ├─ HeadObject ×2         size == local size, sha256 metadata == local sha256
        ├─ manifest JSON         database-backups/manifests/<type>/YYYY/MM/<backup_id>.json (+ HeadObject)
        ├─ backup_jobs → VERIFIED   (never before this point)
        └─ finally: temp dir deleted; on any error → FAILED + alert (ticket, notification, optional SMS)
        ▼
  s3://mountainbakes-bucket/database-backups/
        ├── daily/    YYYY/MM/mountainbakes-daily-YYYY-MM-DD.dump        (+ -auth.dump)   expires 7 days
        ├── weekly/   YYYY/MM/mountainbakes-weekly-YYYY-Www.dump         (+ -auth.dump)   expires 35 days
        ├── monthly/  YYYY/MM/mountainbakes-monthly-YYYY-MM.dump         (+ -auth.dump)   → STANDARD_IA @30d, expires 366 days
        ├── manual/   YYYY/MM/mountainbakes-manual-<UTC ts>.dump         (+ -auth.dump)   expires 90 days
        └── manifests/<type>/YYYY/MM/backup-<type>-<label>.json                          expires 400 days
        ▼
  S3 Lifecycle rules (retention authority) · backup_jobs ledger · Admin → Database Backup · pnpm backup:status
        ▼
  pnpm backup:restore:test  → isolated database → backup_restore_tests
```

### Modules (`src/services/backup/`)

| File | Responsibility |
| --- | --- |
| `backupConfig.ts` | Env → validated config (all errors at once, never at import); production/dev bucket gate; `redactSecrets()`; S3 client |
| `backupNaming.ts` | Deterministic backup IDs, S3 keys, Karachi-calendar `isDue()`, ISO week / month labels, key parser |
| `postgresBackup.ts` | `pg_dump` as a child process (connection via libpq env vars, never argv), version, probe, timeout/abort, stderr redaction |
| `backupIntegrity.ts` | Streamed SHA-256, file size, HeadObject comparison |
| `s3BackupStorage.ts` | Upload (multipart, SSE-S3), head, get/put JSON, list, single delete, presign, download, `withRetry` |
| `backupManifest.ts` | Manifest build + Zod validation |
| `backupRepository.ts` / `backupLock.ts` | `backup_jobs` access through `supabaseAdmin`; the claim/release handle |
| `backupService.ts` | `runBackup()` orchestration, `verifyBackup()` |
| `backupHealth.ts` | Stale-backup rules (daily 30h, weekly 8d, monthly 33d) |
| `backupRetention.ts` | Expiry plan from objects + ledger; guarded application-side deletion |
| `backupAlerts.ts` | Ticket + notification + optional SMS/WhatsApp on failure |
| `awsAdmin.ts` | Bucket audit; lifecycle/encryption/public-access configuration |
| `deps.ts` | Wires the real S3/Supabase/spawn collaborators (tests inject doubles) |

## Backup policy

| Class | Frequency (Asia/Karachi) | Heroku Scheduler (UTC) | Retention | S3 location |
| --- | --- | --- | --- | --- |
| Daily | every day 03:00 | 22:00 | **7 days** | `database-backups/daily/` |
| Weekly | Sunday 03:45 | 22:45 (Saturday UTC) | **35 days ≈ 1 month** (4–5 weeklies) | `database-backups/weekly/` |
| Monthly | 1st of the month 04:30 | 23:30 (last UTC day of the previous month) | **366 days = 1 year** (12–13 monthlies) | `database-backups/monthly/` |
| Manual | on demand (CLI or admin screen) | — | 90 days | `database-backups/manual/` |

Retention is **time from creation**, not "keep exactly N files": a daily
backup is deleted 7 days after it was written, whichever files sit beside it.
Because every class has its own prefix and its own lifecycle rule, a daily rule
can never touch a monthly backup, and manual backups never enter the scheduled
pools. S3 evaluates lifecycle once a day and expires at the next UTC midnight
after the threshold, so an object can outlive its `retention_until` by up to
about 24 hours.

Why these times: the bakery runs 08:00 → 02:00 PKT; the closing and event
jobs fire at 02:00/02:30 PKT; 03:00–08:00 PKT is the only quiet window. The
three jobs are 45 minutes apart and each holds a per-type lock, so they never
run simultaneously. Heroku Scheduler only offers "daily", so `backup:weekly`
and `backup:monthly` run every day and exit 0 "not due" on other days.

Names are computed on the **Karachi** calendar: the 22:00 UTC run is
`backup-daily-2026-09-21` (03:00 PKT on the 21st), the Sunday run is labelled
with that ISO week (Sunday is its last day, so W38 contains all of week 38),
and the run on the 1st is labelled for the month that just ended
(`monthly-2026-09` is taken on 1 October). The same type on the same Karachi
date always maps to the same backup ID and S3 key — that is what makes re-runs
idempotent.

## What is in a backup

Two `pg_dump` custom-format archives (`-Fc`, zlib level 6 built in, so no
second gzip pass) per run:

| Archive | pg_dump scope | Contains |
| --- | --- | --- |
| `mountainbakes-<type>-<label>.dump` | `--schema=public --schema=app --schema=supabase_migrations` | every table + data, sequences, indexes, constraints, functions, triggers, views, types/enums, RLS policies, grants, comments; the `app` helpers; the migration history so `supabase db push` still knows what is applied |
| `mountainbakes-<type>-<label>-auth.dump` | `--table=auth.users --table=auth.identities` | the accounts (with their `app_metadata` role/branch) and identities — without these nobody can log in |

Flags: `--no-publications --no-subscriptions` (Supabase owns the
`supabase_realtime` publication on any target), `--no-sync` (the file is
checksummed and uploaded, not kept). Owners and privileges are **kept** in the
archive; `pg_restore --no-owner --no-privileges` decides at restore time.

Deliberately **not** included (recorded in every manifest's `scope.excluded`):

- `auth.*` other than users/identities: sessions, refresh tokens, MFA
  factors, audit log, flow state — ephemeral, and users simply sign in again.
- Supabase Storage **files** (attachments, branding) and the `storage`
  metadata schema. Files live in Supabase Storage, not Postgres; see
  [database-disaster-recovery.md](database-disaster-recovery.md).
- `extensions`, `vault`, `pgsodium`, `net`, `realtime`, `graphql*`,
  `supabase_functions` schemas — Supabase-managed.
- Project settings, Auth providers/SMTP/templates, Edge Functions, Realtime
  configuration, database roles and passwords.

## S3 layout and object metadata

```
database-backups/daily/2026/09/mountainbakes-daily-2026-09-21.dump
database-backups/daily/2026/09/mountainbakes-daily-2026-09-21-auth.dump
database-backups/weekly/2026/09/mountainbakes-weekly-2026-W38.dump
database-backups/monthly/2026/09/mountainbakes-monthly-2026-09.dump
database-backups/manual/2026/09/mountainbakes-manual-2026-09-21T10-15-00Z.dump
database-backups/manifests/daily/2026/09/backup-daily-2026-09-21.json
```

Every archive is uploaded with `ServerSideEncryption: AES256`, `StorageClass:
STANDARD` and object metadata `sha256`, `backup-id`, `backup-type`,
`retention-until`. The manifest is immutable (one per run, never rewritten;
there is no mutable index file) and holds: `backupId`, `backupType`,
`databaseName`, `databaseRef` (project ref only), `startedAt`, `completedAt`,
`environment`, `appVersion`, `databaseVersion`, `pgDumpVersion`, `format`,
`compression`, `files[] {role, fileName, s3Key, fileSize, checksumSha256,
etag}`, `retentionUntil`, `retentionDays`, `scope`, `status`,
`checksumAlgorithm`. Never a password, key or host.

## Integrity and success criteria

A run is recorded `verified` only when **all** of the following held:

1. `pg_dump` exited 0 for both archives and both files exist and are non-empty
2. SHA-256 computed locally for both (streamed, never in memory)
3. both uploads completed (multipart, 16 MiB parts, 3 attempts with 1s/4s/16s backoff)
4. `HeadObject` on both: `ContentLength` equals the local size, `sha256`
   metadata equals the local hash, size > 0
5. manifest written and read back with `HeadObject`
6. `backup_jobs` row updated with sizes, checksums, keys, versions, retention

Anything else is `failed` with an `error_category` from: `CONFIG_INVALID`,
`DB_CONNECTION_FAILED`, `PG_DUMP_FAILED`, `DUMP_EMPTY`, `DISK_ERROR`,
`CHECKSUM_FAILED`, `S3_UPLOAD_FAILED`, `S3_VERIFY_FAILED`, `MANIFEST_FAILED`,
`INTERRUPTED`, `STALE`, `UNKNOWN`. `pnpm backup:verify` and the screen's
Verify button repeat checks 4–5 against S3 at any later time (without
downloading or touching the database).

## Locking, duplicates, interruption

- **Lock**: `claim_backup_job()` (migration 117) inserts the `running` row
  under a per-type advisory lock; a partial unique index allows at most one
  `running` row per type. A second run of the same type gets `in_progress`
  (exit 3) and does not dump. A `running` row older than
  `BACKUP_STALE_LOCK_MS` (default 90 min) is marked `stale` and superseded.
- **Duplicates**: if the day's manifest already exists and both objects match
  it (size + sha256), the run finishes as `already_completed` without
  uploading. If an object exists without a matching manifest (a partial
  earlier attempt) it is overwritten by the new verified upload.
- **SIGTERM/SIGINT** (dyno shutdown, Ctrl-C): `pg_dump` is killed, the
  multipart upload aborted, the row marked `failed/INTERRUPTED`, the temp
  directory removed, an alert raised. A second signal hard-exits.
- **Temp files**: `<os tmpdir>/mountainbakes-backups/<backup_id>-XXXX/`,
  removed in `finally` on every path; a cleanup failure is logged.

## Retry strategy

| Step | Retried? | Policy |
| --- | --- | --- |
| Connection probe / `pg_dump` | once, only for connection-class errors (stderr matches "could not connect", "server closed the connection", auth failure, timeouts) | 5 s wait |
| S3 upload, HeadObject, manifest put/get, list | 3 attempts | 1 s, 4 s, 16 s; 4xx (except 408/429) never retried |
| Whole run | no | Heroku Scheduler runs the command again the next day; an admin can re-run `pnpm backup:<type> -- --force` |

## Alerting

On any failure, in this order, none of which can throw:

1. `[backup] <type> failed reason=<CATEGORY> attempt=n/3 — <redacted message>` and exit code 1 (visible in the Heroku Scheduler run log)
2. `backup_jobs` row `failed` with category and redacted message
3. a Support Center ticket `BACKUP-<TYPE>-<label>` (`reference_type: system`) plus an in-app notification (`support_query`) to every super admin
4. with `BACKUP_ALERT_MESSAGING=true`, an SMS/WhatsApp to `notification_recipients` rows with `department = 'admin'` through the configured provider (log provider when Twilio is not configured)

The alert carries type, backup ID, environment, start/failure time, attempts,
category and the redacted reason — never a connection string, key or raw stderr.

## Monitoring and stale detection

`pnpm backup:status`, `GET /api/admin/backups/health` and the admin screen
compute per type:

| Type | Expected within | Status |
| --- | --- | --- |
| daily | 24 h + 6 h grace = **30 h** | `healthy` / `overdue` / `failed` (newest run failed) / `never` |
| weekly | 7 d + 1 d = **192 h** | |
| monthly | 31 d + 2 d = **792 h** | |

Only a `verified` backup counts as success. Also reported: running jobs,
failures in the last 7 days, S3 reachability (`HeadBucket`), database
reachability (`backup_database_info` RPC), last restore drill. `backup:status`
exits 1 when anything is not healthy, so it can itself be scheduled as a check.

Per-run observability in `backup_jobs`: started/completed, `duration_ms`,
`dump_ms`, `upload_ms`, sizes, checksums, keys, `pg_dump_version`,
`database_version`, `app_version`, `attempts`, `trigger`, `triggered_by`.

## AWS configuration

- **Bucket** `mountainbakes-bucket`, region `ap-southeast-1` (`AWS_REGION`).
- **Encryption**: SSE-S3 (AES256). Set explicitly on every `PutObject`, and
  `backup:aws:configure` sets it as the bucket default. KMS was not introduced:
  no customer-managed-key requirement exists in this architecture.
- **Block Public Access**: all four flags on (configured/verified by the scripts).
  The audit also flags any bucket policy that grants `Principal: "*"` on
  anything mentioning the backup prefix.
- **Versioning**: reported by the audit. Every lifecycle rule carries
  `NoncurrentVersionExpiration: 1 day`, so on a versioned bucket an expired
  or deleted backup does not survive as an old version. Object Lock is
  **not** enabled: it needs versioning at bucket creation and would block the
  retention deletes; a separate write-once bucket is the documented option if
  immutability is ever required.
- **Storage class**: STANDARD for daily/weekly/manual (short-lived, may be
  restored at any time); monthly transitions to STANDARD_IA after 30 days
  (instant retrieval, ~45% cheaper, 30-day minimum charge already satisfied)
  and never to Glacier — a year-old monthly must still restore in minutes.

### Lifecycle rules (retention authority)

Written by `pnpm backup:aws:configure -- --confirm`, merged by rule ID so any
other rules on the bucket are preserved. `pnpm backup:aws:audit` diffs them.

```json
{ "Rules": [
  { "ID": "mountainbakes-db-backups-daily",    "Status": "Enabled", "Filter": { "Prefix": "database-backups/daily/" },    "Expiration": { "Days": 7 },   "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
  { "ID": "mountainbakes-db-backups-weekly",   "Status": "Enabled", "Filter": { "Prefix": "database-backups/weekly/" },   "Expiration": { "Days": 35 },  "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
  { "ID": "mountainbakes-db-backups-monthly",  "Status": "Enabled", "Filter": { "Prefix": "database-backups/monthly/" },  "Transitions": [ { "Days": 30, "StorageClass": "STANDARD_IA" } ], "Expiration": { "Days": 366 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
  { "ID": "mountainbakes-db-backups-manual",   "Status": "Enabled", "Filter": { "Prefix": "database-backups/manual/" },   "Expiration": { "Days": 90 },  "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
  { "ID": "mountainbakes-db-backups-manifests","Status": "Enabled", "Filter": { "Prefix": "database-backups/manifests/" },"Expiration": { "Days": 400 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } },
  { "ID": "mountainbakes-db-backups-abort-incomplete-multipart", "Status": "Enabled", "Filter": { "Prefix": "database-backups/" }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 } }
] }
```

`pnpm backup:retention` computes the same expiry from the ledger and the
objects and prints "would delete" — it deletes nothing unless
`BACKUP_RETENTION_AUTHORITY=application` **and** `--confirm` are both present,
and even then only keys under `<prefix>/<type>/`, only with a `verified`
ledger row, only past `retention_until`, never the newest verified backup of a
type, and only after re-reading each object's `retention-until` metadata. There
is no bulk or wildcard delete anywhere in the code.

### IAM — least privilege

Runtime user for the dyno (`mountainbakes-backup-heroku`), lifecycle-managed
retention — **no delete**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBackupPrefixOnly",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::mountainbakes-bucket",
      "Condition": { "StringLike": { "s3:prefix": ["database-backups/*", "database-backups-test/*"] } }
    },
    {
      "Sid": "ReadWriteBackupObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": [
        "arn:aws:s3:::mountainbakes-bucket/database-backups/*",
        "arn:aws:s3:::mountainbakes-bucket/database-backups-test/*"
      ]
    },
    {
      "Sid": "ReadBucketConfigForAudit",
      "Effect": "Allow",
      "Action": ["s3:GetLifecycleConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketVersioning", "s3:GetBucketPolicy"],
      "Resource": "arn:aws:s3:::mountainbakes-bucket"
    },
    {
      "Sid": "RequireTLS",
      "Effect": "Deny",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::mountainbakes-bucket", "arn:aws:s3:::mountainbakes-bucket/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Application-managed retention variant: add `"s3:DeleteObject"` (and
`"s3:DeleteObjectVersion"` on a versioned bucket) to `ReadWriteBackupObjects`.
A developer/test user needs `s3:DeleteObject` on `database-backups-test/*`
only, so `pnpm backup:integration` can clean up after itself.

One-off administrator (a person's credentials, used for
`backup:aws:configure` only): `s3:PutLifecycleConfiguration`,
`s3:PutEncryptionConfiguration`, `s3:PutBucketPublicAccessBlock` plus the
`Get*` above.

Credentials: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` as Heroku config vars
(Heroku offers no IAM-role equivalent; the SDK default provider chain is used
automatically wherever one exists). **Rotation**: create a second access key
for the same IAM user in the AWS console → `heroku config:set` both vars →
`heroku run "pnpm backup:verify"` → deactivate, then delete the old key. Same
for the database password: reset it in Supabase → update `SUPABASE_DB_URL`
locally and on Heroku in one change → `heroku run "pnpm backup:manual"`.

## Environment variables (names only)

| Variable | Required | Purpose |
| --- | --- | --- |
| `BACKUP_ENABLED` | yes (writes) | must be `true`; off by default |
| `SUPABASE_DB_URL` | yes (dump/restore) | session pooler, port 5432; port 6543 rejected; never logged |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | yes (or IAM role / profile) | backup IAM user |
| `AWS_REGION` | yes | `ap-southeast-1` |
| `BACKUP_S3_BUCKET` | yes | `mountainbakes-bucket` in production; must NOT be it outside production unless `BACKUP_ALLOW_PRODUCTION_BUCKET=true` (falls back to legacy `AWS_S3_BUCKET_NAME` with a warning) |
| `BACKUP_PRODUCTION_BUCKET` | no | default `mountainbakes-bucket` |
| `BACKUP_S3_PREFIX` | no | default `database-backups` |
| `BACKUP_TIMEZONE` | no | `Asia/Karachi` only |
| `BACKUP_DAILY_RETENTION_DAYS` / `WEEKLY` / `MONTHLY` / `MANUAL` | no | 7 / 35 / 366 / 90 |
| `BACKUP_RETENTION_AUTHORITY` | no | `lifecycle` (default) or `application` |
| `BACKUP_ALERT_MESSAGING` | no | `true` → also SMS/WhatsApp admin recipients |
| `BACKUP_STALE_LOCK_MS`, `BACKUP_PG_DUMP_TIMEOUT_MS` | no | 90 min, 30 min |
| `PG_BIN_DIR` | no | directory of `pg_dump`/`pg_restore`/`psql`; Heroku: `/app/.apt/usr/lib/postgresql/17/bin` |
| `BACKUP_TMP_DIR`, `APP_VERSION` | no | temp location; version stamp |
| `BACKUP_RESTORE_TEST_DB_URL` | restore drill only | isolated target; production refused |
| `NODE_ENV` | — | `production` switches the bucket gate |

Configuration is validated in one pass and every problem is listed together;
an invalid configuration exits 2 and nothing runs. The API keeps booting with
none of these set; backup endpoints then answer `503 BACKUP_NOT_CONFIGURED`.

## Commands

| Command | Does | Exit |
| --- | --- | --- |
| `pnpm backup:daily` / `backup:weekly` / `backup:monthly` | scheduled runs (weekly/monthly self-gate on the Karachi calendar; `-- --force` overrides) | 0 ok/not-due/already · 1 failed · 2 config · 3 lock held |
| `pnpm backup:manual` | one-off backup under `manual/` | same |
| `pnpm backup:status` | health report (last success per type, S3 + DB connectivity, failures, last restore drill) | 1 if anything unhealthy |
| `pnpm backup:verify [-- --backup-id ID]` | re-check latest verified per type (or one) against S3 | 1 on any failed check |
| `pnpm backup:list [-- --type daily --limit 20]` | ledger listing | 0 |
| `pnpm backup:retention [-- --confirm] [--verbose]` | dry-run expiry report; deletes only with `--confirm` + application authority | 0 |
| `pnpm backup:aws:audit` | read-only bucket audit | 1 on findings |
| `pnpm backup:aws:configure [-- --confirm]` | lifecycle + encryption + public access block (elevated creds) | |
| `pnpm backup:restore:test [-- --backup-id ID] [--keep]` | restore drill into `BACKUP_RESTORE_TEST_DB_URL` | 1 on any failed check · 2 refused |
| `pnpm backup:integration` | real end-to-end run on `database-backups-test/`, then cleanup | |
| `pnpm backup:test` | unit tests (`node:test`, mocked S3 / pg_dump / ledger) | |

None of the scheduled or manual commands can delete a production backup. The
only deleting paths are `backup:retention -- --confirm` under application
authority and `backup:integration`'s cleanup of its own test prefix.

## Admin screen and API

`/api/admin/backups` (super_admin, JWT re-checked on every call):
`GET /health`, `GET /status`, `GET /history?page&pageSize&type&status`,
`GET /restore-tests/latest`, `GET /:id`, `POST /:id/verify`, `POST /run`
(`{type, force?}` → 202 + backup ID; 409 when that type is running; runs on
the web dyno — scheduled runs are the primary path), `GET /:id/download-url?file=main|auth`
(5-minute presigned URL, logged with the requesting admin, never stored).

Frontend (separate repo): Admin → **Database Backup** — three health cards
(last verified, last run + status, size, S3 file, retention until, SHA-256),
running/failures/last-drill tiles, full history table (View / Verify /
Download), "Create backup" (manual only). Nothing on the screen can delete a
backup or trigger retention. Backup archives are never served through the app
and never through a permanent URL.

## Security review

- [x] No credentials in git: `.env` is ignored; `.env.example` holds names only; the connection string is passed to `pg_dump` through environment variables, not argv
- [x] No credentials in the frontend or mobile app; the admin screen sees only metadata
- [x] No anon key or service-role key is used for dumping; `pg_dump` uses a dedicated Postgres connection string
- [x] Bucket private (Block Public Access verified/enforced by script; bucket policy audited)
- [x] IAM least privilege: prefix-scoped, no delete for the runtime user, TLS required
- [x] Encryption at rest (SSE-S3 on every object + bucket default) and in transit (HTTPS; `PGSSLMODE=require`)
- [x] Logs and stored errors pass through `redactSecrets()` (URL passwords, every known secret value)
- [x] Backup information is super_admin-only; download links expire in 5 minutes and are logged
- [x] Restore drill refuses the production host/database, the project ref and `PRODUCTION=true`
- [x] Retention cannot touch unrelated objects (key parser, prefix + type check, verified-row requirement, newest-backup protection, per-object re-check)
- [x] Development cannot write to or delete from the production bucket unless `BACKUP_ALLOW_PRODUCTION_BUCKET=true` is set on purpose

## Deployment checklist

- [ ] `Aptfile` committed and `heroku-community/apt` buildpack added → `heroku run "$PG_BIN_DIR/pg_dump --version"` prints 17.x
- [ ] `SUPABASE_DB_URL` (session pooler, 5432) set as a Heroku config var — and in local `.env` for the drill
- [ ] IAM user created with the policy above; `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION=ap-southeast-1` set (the key currently in the local `.env` is 41 characters and fails `SignatureDoesNotMatch` — it must be replaced)
- [ ] `BACKUP_ENABLED=true`, `BACKUP_S3_BUCKET=mountainbakes-bucket`, `BACKUP_S3_PREFIX=database-backups`, `BACKUP_TIMEZONE=Asia/Karachi`, `PG_BIN_DIR` set
- [ ] Migration 117 applied (`npx supabase db push --linked`)
- [ ] `pnpm backup:aws:configure -- --confirm` run once with elevated credentials; `pnpm backup:aws:audit` clean (encryption, public access block, 6 lifecycle rules)
- [ ] `heroku run "pnpm backup:manual"` then `heroku run "pnpm backup:verify"` succeed
- [ ] Heroku Scheduler add-on with the three daily jobs at 22:00 / 22:45 / 23:30 UTC
- [ ] Next morning: `heroku run "pnpm backup:status"` shows daily `HEALTHY`; Admin → Database Backup shows the run
- [ ] Restore drill run locally against PostgreSQL 18 (`pnpm backup:restore:test`) and logged in docs/database-restore.md
- [ ] Monthly restore drill scheduled in the ops calendar

## Known limitations

- Scheduled logical dumps: recovery point is the last verified backup (≈24 h
  worst case). This is **not** point-in-time recovery; Supabase's own PITR /
  daily snapshots are a separate, complementary capability — see
  [database-disaster-recovery.md](database-disaster-recovery.md).
- Supabase Storage files, Realtime, Edge Functions, Auth provider settings,
  project configuration and roles are outside the dump.
- `pg_dump` holds one session-pooler connection for the whole dump; on a very
  large database a pooler idle timeout could interrupt it (the probe and the
  single connection retry mitigate; watch `dump_ms`).
- Lifecycle expiry has midnight-UTC granularity; `retention_until` is
  advisory to within a day.
- The dyno is in the US and the database in Tokyo; dump throughput is
  network-bound. Record `dump_ms` after the first production runs and raise
  `BACKUP_PG_DUMP_TIMEOUT_MS` if the database grows toward it.
- `POST /run` executes on the 512 MB web dyno; use it for manual backups, not
  as the scheduled path.
