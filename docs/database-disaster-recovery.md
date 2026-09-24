# Database Disaster Recovery

What can go wrong with the Mountain Bakes database, what we can recover, how
long it takes, and what we cannot promise. Companion to
[database-backup.md](database-backup.md) and
[database-restore.md](database-restore.md).

## Backup storage

| What | Where | Retention |
| --- | --- | --- |
| Daily `pg_dump` (main + auth archives + manifest) | `s3://mountainbakes-bucket/database-backups/daily/` | 7 days |
| Weekly | `…/weekly/` | 35 days |
| Monthly | `…/monthly/` (STANDARD_IA after 30 days) | 366 days |
| Manual | `…/manual/` | 90 days |
| Manifests | `…/manifests/` | 400 days |
| Ledger (`backup_jobs`, `backup_restore_tests`) | the production database itself | (inside every backup) |

S3 is in `ap-southeast-1` (Singapore); the database is in `ap-northeast-1`
(Tokyo); the API dyno is in the US. A single-region outage of any one of them
does not take the backups with it.

## Recovery objectives

| | Scheduled `pg_dump` backups (this system) | Supabase platform features |
| --- | --- | --- |
| **RPO** (data you can lose) | up to **24 h** in the worst case (the moment before the next 03:00 PKT daily); typically the business day in progress | Daily snapshots on paid plans (RPO ≤ 24 h) or **PITR** (RPO ≈ 2 min) if the add-on is enabled |
| **RTO** (time to be back) | **~1–3 hours**: identify + verify + download (minutes), restore into a Supabase project (minutes to ~1 h depending on size), verification and app smoke test (30–60 min), DNS/config unchanged if the same project | Same-project PITR restore: ~10–30 min |
| Granularity | one full logical copy per day/week/month | continuous (PITR) or daily (snapshots) |
| Independent of Supabase | **yes** — restorable into any PostgreSQL 17+ | no — lives inside the Supabase project |

**These dumps do not provide point-in-time recovery.** They are a daily
logical copy stored outside Supabase. Do not tell anyone data loss is zero:
orders placed after 03:00 PKT on the day of a failure exist only in the live
database (or in Supabase PITR, if enabled).

### Supabase-native backups — check and record

Open Supabase → Project → Database → Backups and record here which of these
applies to project `wzjabtuoxrvyareptddq`:

- [ ] Free plan: no platform backups → the S3 dumps are the **only** backup. Consider upgrading.
- [ ] Pro plan: daily snapshots, 7-day retention → restore-in-place from the dashboard is the fastest same-project recovery; the S3 dumps cover retention beyond 7 days and a lost/compromised project.
- [ ] PITR add-on enabled → RPO ≈ 2 minutes for same-project recovery; S3 dumps remain the off-platform copy.

Both mechanisms are complementary; enabling one never replaces the other.

## What is and is not covered

Covered by the S3 dumps: every business table and row in `public`; the `app`
helper schema; functions, triggers, views, sequences, indexes, constraints,
enums, RLS policies; migration history; **user accounts and identities**
(`auth.users`, `auth.identities`) with roles and branch assignments.

Not covered (must be recreated or recovered elsewhere):

| Item | Where it lives | Recovery |
| --- | --- | --- |
| Attachment / branding **files** | Supabase Storage buckets `attachments`, `branding` | Supabase platform backups include Storage on Pro; otherwise re-upload. Consider a periodic `supabase storage` sync to S3 as a follow-up |
| Auth sessions, refresh tokens, MFA | `auth.*` (excluded) | users sign in again |
| Auth providers, SMTP, email templates, JWT secret | Supabase project settings | reconfigure in the dashboard of the target project |
| Realtime config, Edge Functions | Supabase project | none exist today beyond defaults |
| Database roles / passwords, extensions | server-level | created by Supabase on a new project; the drill script creates stand-ins on a plain server |
| Heroku config vars, Firebase hosting config | Heroku / Firebase | kept in the respective dashboards; document changes in DEPLOY.md |

## Failure scenarios

| Scenario | Detection | Response | Expected loss |
| --- | --- | --- | --- |
| Accidental data deletion / bad migration | staff report; Support Center | If Supabase PITR: restore to the minute before. Else: restore last daily into a **new** project, extract the affected rows, and merge — do not overwrite the live database wholesale for a partial loss | rows changed since the backup, for the affected tables only |
| Database corruption / project unusable | API 5xx, Supabase status | Same-project snapshot/PITR if available; otherwise full restore per database-restore.md §10 into the same or a new project | ≤ 24 h |
| Supabase project deleted or account compromised | login failures, dashboard | New project (possibly new org); full restore; rotate every Supabase and AWS credential; re-point Heroku + rebuild the frontend | ≤ 24 h + Storage files |
| S3 bucket compromised / objects deleted | `pnpm backup:verify` / `backup:status` failing; AWS alerts | Backups older than the deletion are gone unless versioning + noncurrent retention applied. Rotate the AWS key immediately; take `pnpm backup:manual` to a fresh prefix; review IAM (runtime user has no delete) | none to the live database |
| Backup job failing silently | impossible by design: exit 1, FAILED row, ticket + notification, `overdue`/`failed` health, `backup:status` exit 1 | Fix the cause (credentials, pg_dump, disk), `pnpm backup:<type> -- --force` | grows by one day per missed run |
| Heroku Scheduler skipped a run (best effort) | `overdue` health | run manually with `--force`; the next scheduled run self-heals | one day of RPO |
| pg_dump too slow / pooler timeout | `PG_DUMP_FAILED` after `BACKUP_PG_DUMP_TIMEOUT_MS`, `dump_ms` trend | raise the timeout; consider the Supabase direct (IPv6) connection from a host that has it, or Supabase PITR for large databases | none |
| Lost AWS credentials / key rotation | `S3_UPLOAD_FAILED` 403 | new key on the same IAM user, `heroku config:set`, `backup:verify` | none |
| Laptop / dev misconfiguration | config gate refuses the production bucket outside production | none | none |

## Emergency process

1. **Declare**: whoever notices posts in the admin channel and opens a
   Support Center ticket (`reference_type: system`) so there is a record.
2. **Stop the bleeding**: `heroku ps:scale web=0` if writes would make things
   worse; do not run anything destructive yet.
3. **Assess**: `pnpm backup:status`, Supabase dashboard status/backups page,
   `pnpm backup:verify`. Decide platform restore vs. S3 restore vs. targeted
   fix.
4. **Rehearse on a test target** (database-restore.md §1–9) before touching
   production, unless the outage cost clearly outweighs the hour.
5. **Recover** (§10), verify, take a manual backup, bring the dyno back.
6. **Write it down**: date, cause, backup used, recovery point, duration,
   what to change. Add a row to the restore drill log.

Contacts (fill in): primary on-call developer · business owner · Supabase
support (dashboard → Support, Pro plan) · AWS account owner.

## Verification schedule

| Cadence | Check | Evidence |
| --- | --- | --- |
| Every run | object read back from S3 (size + sha256), manifest written | `backup_jobs.status = verified` |
| Daily (automatic) | health: daily ≤ 30 h, weekly ≤ 8 d, monthly ≤ 33 d | Admin → Database Backup; `pnpm backup:status` exit 0 |
| Weekly | `pnpm backup:verify` on the latest of each type; `pnpm backup:aws:audit` | command output |
| **Monthly** | full restore drill: `pnpm backup:restore:test` into an isolated database (local PostgreSQL 18 or a throwaway Supabase project) | `backup_restore_tests` row; restore drill log in database-restore.md |
| Quarterly | rotate the AWS access key and the database password; re-check the IAM policy and lifecycle rules | DEPLOY.md / this file |
| After any schema migration touching auth or a new schema | confirm the dump scope still covers it (`pg_restore --list`) | note in the migration header |

## Database load and expected duration

The dump runs at 03:00 PKT against a database whose last writes were the
02:00 closing job. `pg_dump` takes one pooler connection and reads every table
once in a single transaction; CPU cost is the zlib compression on the dyno,
not on the database. Record the first production figures here after the
initial runs:

| Date | Database size (`backup_database_info`) | Main archive size | `dump_ms` | `upload_ms` | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-25 | 49.1 MB | 3.0 MB (+ 18.2 KB auth) | 75.1 s main + 14.5 s auth (via session pooler from Pakistan; plus ~13 s connectivity probe) | 1.6 s | first real daily/weekly/monthly runs, run from a dev machine, not Heroku; total 1m 40s–1m 50s per run |

If `dump_ms` approaches 20 minutes, raise `BACKUP_PG_DUMP_TIMEOUT_MS`, move the
weekly/monthly windows apart further, and evaluate Supabase PITR as the primary
mechanism with the S3 dumps as the off-platform copy.
