# Database Backup — Architecture Audit

Audit of the Mountain Bakes backend as found on 2026-09-21, before the pg_dump →
S3 backup system was built. Everything below was verified by reading the code
and configuration in this repository (and its two sibling repos), not assumed.

## 1. Existing backend structure

- Express 4 + TypeScript, CommonJS, `strict`. Node **24.x** and **pnpm 11.12.0**
  pinned (`engines`, `packageManager`). No compile step: `tsx server.ts` runs the
  TypeScript directly; `pnpm build` is `tsc --noEmit`.
- Layout: `server.ts` (boot) → `src/app.ts` (Express, helmet, CORS, rate limit)
  → `src/routes/*.routes.ts` (wired in `src/routes/index.ts`) → `src/services/`
  → Supabase. Middleware in `src/middleware/` (`authenticate`, `requireRole`,
  `validate`, `errorHandler`). Utilities in `src/utils/`.
- Errors are plain `Error` objects with a `status` property; `errorHandler`
  masks 5xx bodies when `NODE_ENV=production`.
- Scripts live in `src/scripts/` and run as `tsx --env-file .env src/scripts/x.ts`
  with `--confirm`/dry-run conventions and explicit exit codes.
- **No automated tests and no test runner** were installed (documented in
  `.claude/CLAUDE.md`). `node:test` (built into Node 24) is available and is
  what the backup system now uses.
- No logger utility: bare `console.*` with `[module]` prefixes.

## 2. Existing Supabase configuration

- One project: ref `wzjabtuoxrvyareptddq`, region **ap-northeast-1**,
  **PostgreSQL 17.6** (`supabase/.temp/postgres-version`).
- The server uses the service-role client `supabaseAdmin`
  (`src/config/supabase.ts`) for every read/write and for `auth.getUser()`. It
  bypasses RLS; authorisation is enforced in application code.
- Supabase Auth holds users; role/branch live in `auth.users.app_metadata`.
  Supabase Storage holds attachments (bucket `attachments`) and branding.
  Supabase Realtime is used by the web app.
- The Supabase CLI is a devDependency used only for migrations (`npx supabase
  db push --linked`). Its `db dump` command shells into Docker and is therefore
  unusable on a Heroku dyno.

## 3. Existing PostgreSQL configuration

- **No direct PostgreSQL connection existed anywhere** — no `DATABASE_URL`,
  `SUPABASE_DB_URL`, `pg` package, `pg_dump` or `psql` reference in code, docs
  or `.env`.
- The only connection string on disk was the gitignored CLI cache
  `supabase/.temp/pooler-url` (session pooler,
  `aws-0-ap-northeast-1.pooler.supabase.com:5432`, no password).
- Schemas in use: `public` (all business tables, functions, triggers, RLS
  policies), `app` (JWT helpers `app.jwt_role()` etc., `app.touch_updated_at()`,
  data-engine helpers), `supabase_migrations` (migration history), plus the
  Supabase-managed `auth`, `storage`, `extensions`, `graphql*`, `realtime`,
  `vault`, `net`, `pgsodium`, `supabase_functions`.
- Transactional invariants live in SQL functions called via RPC; one row-claim
  lock precedent exists (`claim_business_day_closure`, migration 17) and
  `pg_advisory_xact_lock` is used inside finance functions.
- PostgREST aggregates are disabled on this database (only `count: 'exact'`).

## 4. Existing environment variables

`.env` (values not reproduced): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`,
`NOTIFICATION_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_SMS_FROM`, `SMS_DEFAULT_COUNTRY_CODE`, `AWS_S3_BUCKET_NAME`,
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

Findings:

- `AWS_S3_BUCKET_NAME` was **read by nothing**; the existing export script read
  `BACKUP_S3_BUCKET`, so `pnpm backup:s3` could not run from this `.env`.
- `AWS_REGION` is `ap-southeast-1`; a read-only probe confirmed the bucket
  really is in ap-southeast-1 (a `us-east-1` request is redirected there).
- The `AWS_SECRET_ACCESS_KEY` value is **41 characters** long; AWS secret keys
  are 40. Every signed request with it returns `SignatureDoesNotMatch` (403).
  The credential must be corrected before any upload can succeed.
- `NODE_ENV` is unset locally (development).

## 5. Existing AWS configuration

- `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` were already dependencies;
  `@aws-sdk/s3-request-presigner` was added for short-lived download links.
- No IAM policy, lifecycle rule, encryption or public-access setting was
  documented anywhere. The permissions of the existing access key are unknown
  (it could not authenticate — see §4). `pnpm backup:aws:audit` now reports
  the bucket's actual state.

## 6. Existing S3 integration

- `src/config/s3.ts`: lazy `getBackupConfig()`/`getS3Client()` used only by the
  NDJSON export script. Folded into `src/services/backup/backupConfig.ts`.
- `src/scripts/backup-to-s3.ts` (`pnpm backup:s3`, committed 2026-09-20):
  paginates every public table through PostgREST and uploads gzipped NDJSON.
  **Not a database backup**: no DDL, functions, triggers, sequences,
  constraints, policies or auth users; five tables excluded; cannot be
  `pg_restore`d. Retired to `archive/backup-to-s3.ts` per the owner's decision.
  Migration 116 (`list_public_base_tables()`) stays in place.
- Attachments are **not** in S3 — they are in Supabase Storage.

## 7. Existing scheduled jobs

`src/scheduler/`: daily closing (02:00 PKT), price activation (02:00 PKT),
event reminders (09:00) and event maintenance (02:30 PKT). **All are commented
out in `server.ts`** and documented as intentionally off.

## 8. Existing cron implementation

`node-cron` in-process with `timezone: 'Asia/Karachi'`. `DEPLOY.md` states
that backups must **not** use it (a web dyno is not guaranteed awake) and
prescribes Heroku Scheduler one-off dynos. Heroku Scheduler was documented but
**never provisioned**; it supports only every-10-min / hourly / daily UTC jobs.

## 9. Existing logging system

`console.log/warn/error` with prefixes such as `[daily-closing]`, `[cors]`,
`[messaging]`. No log shipping, no redaction helper (only `maskEmail`). The
backup system adds `redactSecrets()` and never logs the connection string.

## 10. Existing error handling

Route handlers `try { … } catch (err) { next(err) }`; `errorHandler` maps
`status`, `ZodError` → 400, `MulterError` → 413/400, else 500. Services throw
raw Supabase errors. Scheduled jobs escalate failures via `support_tickets`
(`reference_type: 'system'`) + `notify({ type: 'support_query', targetRole:
'super_admin' })` — reused verbatim for backup alerts.

## 11. Existing deployment platform

Heroku app **`mountainproject`** (`https://mountainproject-c84e8ec5e300.herokuapp.com`),
stack heroku-24, Node buildpack only, `Procfile: web: pnpm start`, one web
dyno (locks assume a single instance). Deploy = `git push heroku HEAD:main`
from `backend/`. No `Aptfile`, `app.json` or `heroku.yml` existed, hence **no
`pg_dump` on the dyno**. The dyno runs in Heroku's US region; the database is
in Tokyo — every dump crosses the Pacific.

## 12. Existing production environment

- Business hours 08:00 → 02:00 next day, Asia/Karachi (fixed UTC+5, no DST).
  Business day rolls over at 02:00. Dead window: **03:00–08:00 PKT
  (22:00–03:00 UTC)** once the 02:00/02:30 jobs are done.
- Database size and Supabase plan tier were undocumented; migration 117 adds
  `backup_database_info()` (server version, size, table count) so the first
  run records them. PITR/daily-snapshot status on the Supabase plan is unknown
  and must be checked in the dashboard (see docs/database-disaster-recovery.md).
- Frontend: Next.js 16 static export on Firebase Hosting, separate repo,
  `NEXT_PUBLIC_*` inlined at build time. Mobile: React Native, third client.

## 13. Existing database migration structure

`supabase/migrations/YYYYMMDD0000NN_name.sql`, 116 files, `-- NN: purpose`
headers, service-role-only RPC idiom (`revoke all … from public, anon,
authenticated; grant execute … to service_role`). `db push` applies all pending
files in **one transaction**, so a new enum value cannot be used in the same
push (55P04) — the backup tables use `text + check` constraints instead.
Migrations are applied by hand with the CLI, never by the dyno.

## 14. Existing backup-related functionality

Only the NDJSON export (§6). No restore procedure, no verification, no
checksums, no retention, no monitoring, no alerting, no admin visibility.

## 15. Recommended implementation location (as built)

```
backend/
├── supabase/migrations/20260921000117_backup_jobs.sql   ledger + lock + info RPC
├── src/services/backup/                                 the system (see docs/database-backup.md)
├── src/scripts/backup.ts                                CLI (daily/weekly/monthly/manual/status/verify/list/retention)
├── src/scripts/backup-aws.ts                            bucket audit / configure
├── src/scripts/backup-restore-test.ts                   restore drill
├── src/scripts/backup-integration.ts                    end-to-end test on a test prefix
├── src/routes/backups.routes.ts                         /api/admin/backups (super_admin)
├── src/shared/{types,schemas}/backup.*                  mirrored to ../frontend/src/shared
├── Aptfile                                              postgresql-client-17 for the dyno
└── docs/database-backup*.md, database-restore.md, database-disaster-recovery.md
frontend/src/components/database-backup/                 Admin → Database Backup
```

Decisions that followed directly from this audit: Heroku Scheduler (not
node-cron); session pooler on 5432 (IPv4 dyno, pg_dump needs session mode);
`pg_dump -Fc` custom format with built-in compression; row-claim lock in
Postgres (the only state shared across dynos); S3 Lifecycle as the retention
authority (least-privilege IAM without delete); the closing job's escalation
path for alerts; `text + check` statuses so the migration ships in one push.
