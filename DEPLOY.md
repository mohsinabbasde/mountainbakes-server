# Deploying the Mountain Bakes API

This folder deploys as its **own** Heroku app, independent of `../frontend/`.

```
Browser ──HTTPS──▶ Next.js web app ──┐
                                     ├──HTTPS──▶ this API ──▶ Supabase (Postgres)
Web app SSR ─────────────────────────┘
```

The browser calls this API directly and cross-origin, so **`CORS_ORIGINS` is
required** — it is what permits the web app's requests.

## Prerequisites

- Heroku CLI installed, `heroku login` done.
- A Supabase project, with its URL and **secret** service-role key to hand
  (Supabase dashboard → Project Settings → API). Never commit the key.
- `pnpm-lock.yaml` committed — builds install from it.

## Deploy

This folder is its own git repository, so pushes come from here:

```bash
cd server
heroku create <api-app> --remote heroku
heroku config:set -a <api-app> \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<secret-service-role-key> \
  NODE_ENV=production \
  CORS_ORIGINS=https://<web-host>

git push heroku HEAD:main
curl https://<api-host>/health          # → {"status":"ok","service":"mountain-bakes-api"}
```

Heroku's Node buildpack reads `package.json`; the `Procfile` runs `pnpm start`.
Heroku injects `PORT`, which `server.ts` reads before falling back to `API_PORT`,
and binds `0.0.0.0`.

| Variable | When | Value |
| --- | --- | --- |
| `SUPABASE_URL` | **Required** | `https://<project-ref>.supabase.co` — auth verification fails without it and every request 401s |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | The **secret** service-role key, not the anon/publishable one. Grants full admin access — keep it server-side only |
| `CORS_ORIGINS` | **Required** | The web app's exact origin: scheme + host, no path, no trailing slash. Comma-separate multiple |
| `NODE_ENV` | Recommended | `production` |

## Runtime pinning

`package.json` pins `"engines": { "node": "24.x" }` and
`"packageManager": "pnpm@11.12.0"`. **Do not loosen the engine to an open range
like `>=20`.** Heroku resolves a range to the *highest* available Node, and
Corepack — which puts `pnpm` on `PATH` for the `Procfile` — was unbundled from
Node at v25. An open range can resolve to a Node with no Corepack and break both
the build and the dyno boot.

## Order of operations

Deploy this API **before** the web app, because the web app needs this API's URL
baked into its build:

1. Set `CORS_ORIGINS` here to the web app's origin.
2. Push this app; confirm `/health`.
3. Set `NEXT_PUBLIC_API_URL` on the web app to this API's URL.
4. Push the web app.

## Database backups (pg_dump → S3, Heroku Scheduler)

The database is backed up by `pnpm backup:daily|weekly|monthly`
(`src/scripts/backup.ts`): a real `pg_dump` of the Supabase database, uploaded
to `s3://mountainbakes-bucket/database-backups/` with SSE-S3, a SHA-256
checksum and a manifest, then read back and verified before it is recorded as
a backup. Full account, IAM policy, lifecycle rules and restore procedure:
[docs/database-backup.md](docs/database-backup.md).

It deliberately does **not** run via the in-process `node-cron` schedulers —
those only fire while the web dyno is awake. Heroku Scheduler runs each job on
its own one-off dyno.

### 1. `pg_dump` on the dyno (apt buildpack)

Heroku's Node buildpack ships no PostgreSQL client, and Ubuntu noble's own
`postgresql-client` is 16, which refuses to dump the 17.x server. `Aptfile`
(repo root) pulls `postgresql-client-17` from the PGDG repository:

```bash
heroku buildpacks:add --index 1 heroku-community/apt -a mountainproject
git push heroku HEAD:main
heroku run "/app/.apt/usr/lib/postgresql/17/bin/pg_dump --version" -a mountainproject   # → pg_dump (PostgreSQL) 17.x
```

Debian installs `/app/.apt/usr/bin/pg_dump` as a perl wrapper that may not
resolve on a dyno, so the real binary directory is passed explicitly via
`PG_BIN_DIR` below. If the `[trusted=yes]` PGDG line in `Aptfile` is ever
refused by the buildpack, the fallback is documented in
docs/database-backup.md ("pg_dump on Heroku").

### 2. Config vars

```bash
heroku config:set -a mountainproject \
  BACKUP_ENABLED=true \
  SUPABASE_DB_URL='postgresql://postgres.<ref>:<db-password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres' \
  AWS_ACCESS_KEY_ID=<backup-user-key> \
  AWS_SECRET_ACCESS_KEY=<backup-user-secret> \
  AWS_REGION=ap-southeast-1 \
  BACKUP_S3_BUCKET=mountainbakes-bucket \
  BACKUP_S3_PREFIX=database-backups \
  BACKUP_TIMEZONE=Asia/Karachi \
  PG_BIN_DIR=/app/.apt/usr/lib/postgresql/17/bin
```

| Variable | When | Value |
| --- | --- | --- |
| `BACKUP_ENABLED` | **Required** | `true` — off by default everywhere |
| `SUPABASE_DB_URL` | **Required** | Session-pooler connection string, port **5432** (6543 is rejected). Supabase → Settings → Database |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **Required** | IAM user with the least-privilege policy in docs/database-backup.md (no `s3:DeleteObject`) |
| `AWS_REGION` | **Required** | `ap-southeast-1` (where `mountainbakes-bucket` lives) |
| `BACKUP_S3_BUCKET` | **Required** | `mountainbakes-bucket` — with `NODE_ENV=production` nothing else is accepted |
| `BACKUP_S3_PREFIX` | Optional | `database-backups` (default) |
| `PG_BIN_DIR` | Recommended | `/app/.apt/usr/lib/postgresql/17/bin` |
| `BACKUP_ALERT_MESSAGING` | Optional | `true` to also SMS/WhatsApp admin recipients on failure |

Then apply migration 117 (`backup_jobs`, `backup_restore_tests`,
`claim_backup_job`, `backup_database_info`) — see the migrations note below —
and confirm from a one-off dyno before scheduling anything:

```bash
heroku run "pnpm backup:manual" -a mountainproject     # a real backup under manual/
heroku run "pnpm backup:verify" -a mountainproject     # reads it back from S3
heroku run "pnpm backup:status" -a mountainproject
```

### 3. Heroku Scheduler

```bash
heroku addons:create scheduler:standard -a mountainproject
heroku addons:open scheduler -a mountainproject
```

Scheduler times are **UTC**; the business runs 08:00–02:00 Asia/Karachi
(UTC+5, no DST) and the 02:00/02:30 PKT closing jobs are done by 22:00 UTC, so
all three land in the dead window (03:00–08:00 PKT). Scheduler only offers
"daily", so the weekly and monthly commands run every day and exit 0 "not due"
except on their Karachi day:

| Job (Daily, Standard-1X) | UTC | Asia/Karachi | Runs when |
| --- | --- | --- | --- |
| `pnpm backup:daily` | 22:00 | 03:00 | every day |
| `pnpm backup:weekly` | 22:45 | 03:45 Sunday | Karachi date is a Sunday |
| `pnpm backup:monthly` | 23:30 | 04:30 on the 1st | Karachi date is the 1st |

They never overlap: each holds a per-type lock (`backup_jobs`) and the three
start 45 minutes apart. A run that fails exits 1 (visible in the Scheduler
log), records a FAILED row, opens a Support Center ticket and notifies every
super admin; Admin → Database Backup shows daily/weekly/monthly health.

Retention is **S3 Lifecycle**, configured once with elevated credentials —
`pnpm backup:aws:configure -- --confirm` — and checked any time with
`pnpm backup:aws:audit`. The dyno's IAM user needs no delete permission.

## Verify

```bash
heroku run "node --version" -a <api-app>    # => v24.x.x
heroku run "pnpm --version" -a <api-app>    # => 11.12.0
heroku ps -a <api-app>                      # web.1 up, no crash loop
heroku logs --tail -a <api-app>
```

At boot the API logs `[cors] Allowed origins: …`. If the web app reports
`Could not reach the API`, compare that line against the exact `Origin` header in
the browser's Network tab — **a CORS mismatch produces no API-side error at all**,
because `src/app.ts` deliberately omits the headers rather than throwing.

## Notes

- **Database migrations** live in `supabase/migrations/*.sql` and are applied with
  the Supabase CLI, not by the dyno at boot. Apply pending migrations before or
  alongside a deploy that depends on them. The CLI is a devDependency and is **not
  on `PATH`**, so the bare `supabase db push` written here for a long time does not
  run — reach it through `npx`, and read the list before pushing, because a push
  applies every pending migration and not just yours:

  ```bash
  npx supabase migration list --linked   # local vs remote — read this FIRST
  npx supabase db push --linked          # applies EVERY pending migration
  ```

- **`db push` wraps ALL PENDING MIGRATIONS in ONE transaction**, not one per file.
  This is worth knowing before you write an `alter type … add value`: Postgres
  refuses to USE a new enum value in the transaction that declared it (55P04), and
  moving the usage into its own migration file does **not** escape that — pushed
  together, both files are still one transaction, and the error names the first
  file alongside the second file's statement. The value and its first use have to
  go out in two separate pushes. Migrations 55 (enum) and 56 (its usage) look like
  a counterexample and are not; they shipped on different days.

  Holding a migration back means moving it out of `migrations/` for the push and
  restoring it after, which then needs `--include-all` to apply out of order. Often
  the cheaper answer is to drop the statement that needed the new value, which is
  what happened to the partial index that was going to accompany migration 86.
- **Migration 117 (`backup_jobs`) must be applied before the backup commands run**
  or before this code is deployed with the Database Backup screen: every backup
  run claims its lock through `claim_backup_job()` and every status read hits
  `backup_jobs`. It is additive (two new tables, two functions) and safe to apply
  ahead of the deploy.
- **Migration 84 (`idempotency_keys`) must be applied before this code is
  deployed.** Every guarded write claims a key through it, so the five
  offline-capable endpoints would 503 on any request carrying an
  `Idempotency-Key` header until the table exists. It is additive and reads
  nothing, so applying it ahead of the deploy is safe and is the right order.
- **Scheduled jobs** (2 AM Karachi closing + price activation) run in this dyno via
  `node-cron`. They only fire while the dyno is awake — avoid a sleeping tier if you
  rely on the exact 2 AM run. This dyno sees less traffic than the web app, so it is
  likelier to idle. The database backups (above) deliberately avoid this problem by
  running on Heroku Scheduler's own one-off dynos instead of in-process `node-cron`.
- **Keep it at one dyno** (`heroku ps:scale web=1`). The jobs are idempotent, but
  their locks assume a single instance — running them on multiple dynos concurrently
  is untested.
