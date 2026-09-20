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

## Daily Supabase → S3 backup (Heroku Scheduler)

`pnpm backup:s3` (`src/scripts/backup-to-s3.ts`) exports every public-schema
table to S3 as gzipped NDJSON. It deliberately does **not** run via the
in-process `node-cron` schedulers below — those only fire while the web dyno
is awake, and this job should run daily regardless. Heroku Scheduler runs it
on its own one-off dyno instead:

```bash
heroku addons:create scheduler:standard -a <api-app>
heroku addons:open scheduler -a <api-app>
```

In the Scheduler UI, add a job: `pnpm backup:s3`, frequency **Daily**. Times
are **UTC** — pick something comfortably after the 2 AM Asia/Karachi closing
job (= 21:00 UTC the previous day) and during low write traffic, e.g. `23:00
UTC`.

Add the backup's own config vars alongside the ones above:

| Variable | When | Value |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | **Required for backup:s3** | IAM user/role scoped to write to the backup bucket only |
| `AWS_SECRET_ACCESS_KEY` | **Required for backup:s3** | Same IAM credential's secret |
| `AWS_REGION` | **Required for backup:s3** | No default — a wrong region is a confusing SDK error, not a clean failure |
| `BACKUP_S3_BUCKET` | **Required for backup:s3** | The destination bucket |
| `BACKUP_S3_PREFIX` | Optional | Key prefix inside the bucket; defaults to `backups` |

```bash
heroku config:set -a <api-app> \
  AWS_ACCESS_KEY_ID=<access-key-id> \
  AWS_SECRET_ACCESS_KEY=<secret-access-key> \
  AWS_REGION=<region> \
  BACKUP_S3_BUCKET=<bucket-name>
```

Checking results: `heroku addons:open scheduler -a <api-app>` shows each run's
stdout/stderr and exit code. A non-zero exit, or a `partial_failure` status,
means one or more tables failed — check `_manifest.json` at
`s3://<bucket>/<prefix>/<date>/_manifest.json` for which ones and why; the
tables that did succeed are still there and are not re-run.

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
- **Migration 84 (`idempotency_keys`) must be applied before this code is
  deployed.** Every guarded write claims a key through it, so the five
  offline-capable endpoints would 503 on any request carrying an
  `Idempotency-Key` header until the table exists. It is additive and reads
  nothing, so applying it ahead of the deploy is safe and is the right order.
- **Scheduled jobs** (2 AM Karachi closing + price activation) run in this dyno via
  `node-cron`. They only fire while the dyno is awake — avoid a sleeping tier if you
  rely on the exact 2 AM run. This dyno sees less traffic than the web app, so it is
  likelier to idle. The daily S3 backup (above) deliberately avoids this problem by
  running on Heroku Scheduler's own one-off dyno instead of in-process `node-cron`.
- **Keep it at one dyno** (`heroku ps:scale web=1`). The jobs are idempotent, but
  their locks assume a single instance — running them on multiple dynos concurrently
  is untested.
