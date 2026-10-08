# Moving Mountain Bakes from Supabase to Railway

Everything needed to run the application with no Supabase project behind it:
the database, the user accounts, and the two services the code talks to.

## What replaces what

| On Supabase | On Railway | Notes |
|---|---|---|
| Postgres 17 | Railway Postgres 18, database `mountainbakes` | Full copy, verified table by table |
| Auth (GoTrue) | `auth` service, `supabase/gotrue:v2.193.1` | Same software, same version. Accounts and password hashes are copied, so passwords do not change |
| REST API (PostgREST) | `postgrest` service, `postgrest/postgrest:v14.5` | Same software, same version. The API's ~640 queries are unchanged |
| API gateway | `gateway` service (`gateway/`) | Strips `/auth/v1` and `/rest/v1`. The only public service |
| Storage | S3 (`FILE_STORAGE_DRIVER=s3`) | `pnpm files:copy` |
| Realtime | none | The web app polls `GET /api/notifications` |

The Express API stays on Heroku and keeps using `supabase-js`; only the URL and
key it is given change. Nothing in `src/` knows it is no longer Supabase.

```
web / mobile ── sign-in ───────────────┐
     │                                 ▼
     └──► API (Heroku) ───────► gateway (public HTTPS)
                │                ├─ /auth/v1/* → auth      ┐
                │                └─ /rest/v1/* → postgrest ├─ private network
                └─ S3 (files, backups)            Postgres ┘
```

## What was tested, and what was not

Tested, against a local Postgres 18 holding a full copy of production:

- `railway:migrate` copies the database in about 90 seconds. `railway:verify`
  then finds every table, column, constraint, index, sequence, function,
  trigger, policy and enum identical, every numeric column summing to the same
  total, and every table's contents hashing the same (bar a table the live app
  wrote to in between).
- The pinned Auth server and PostgREST both start on Postgres 18 against the
  restored data.
- 291 API requests (every parameterless GET route, as a super admin, a branch
  manager and a finance admin) returned the same status code from the new stack
  as from Supabase, and 281 the same body. The other 10 were two login-history
  responses that changed in between, and eight lists whose rows tie on their
  sort key and came back in a different order with the same contents.
- Sign-in with a restored account, a wrong password refused, role and branch
  claims intact, a banned user refused, a revoked session unable to refresh,
  user create and delete, TOTP enrolment, the idempotency functions.
- A signed-in user's token, and the anon key, get nothing from PostgREST
  directly (HTTP 403 / 401).

NOT tested:

- Anything on Railway itself. The three services have not been deployed there.
- A POS sale, return, production review or ledger posting on the new stack.
  Their SQL functions are byte-identical and are called the same way as the
  functions that were exercised, but none was run end to end.
- Password-reset email (needs an SMTP provider) and Google sign-in (needs the
  redirect URI added in Google Cloud).
- The web and mobile apps pointed at the new stack.
- Speed. Every query now travels Heroku → Railway.

## Two things that will look different afterwards

- **Everyone signs in again**, once. The Auth address changes, and the apps
  keep their session under a key derived from it. Passwords are unchanged.
- **Some lists may be ordered differently** where rows tie on their sort key —
  product categories that all share `sort_order = 0`, events on the same date,
  returns on the same day. The rows are the same; Postgres never promised an
  order among ties and a copied table stores them in a different physical
  order. If one of these matters, give that query a second sort column.

## Before you start

1. **A database that sorts like Supabase's.** Supabase uses the ICU collation
   `en-US`; Railway's default `railway` database does not, and a database's
   collation cannot be changed later. Set `RAILWAY_DB_URL` in `backend/.env` to
   the Railway **public** connection string with the database name changed to
   `mountainbakes`:

       RAILWAY_DB_URL=postgresql://postgres:<password>@<host>.proxy.rlwy.net:<port>/mountainbakes

   `railway:migrate --create-database` creates it correctly. A copy into a
   database that sorts differently is refused.
2. **An SMTP provider** for password-reset email.
3. **Google Cloud Console**: add `https://<gateway-domain>/auth/v1/callback` to
   the OAuth client's redirect URIs.
4. **Old phones.** A mobile build made before the cutover signs in against
   Supabase and the API will reject its token. There is no forced-update check
   in the app; everyone needs the new APK on the day.
5. **Heroku**: when the commit that changes `Aptfile` to `postgresql-client-18`
   is deployed, change the `PG_BIN_DIR` config var to
   `/app/.apt/usr/lib/postgresql/18/bin` in the same release. Left at `17` the
   nightly backup cannot find `pg_dump`. (An 18 client dumps Supabase's
   Postgres 17 too, so this is safe to do before the cutover.)

## Rehearsal — repeat as often as you like, production is not touched

All commands run from `backend/`.

    pnpm railway:migrate --create-database    # first time
    pnpm railway:migrate --reset-target       # every time after
    pnpm railway:secrets                      # once; writes infra/railway/.secrets.env
    pnpm railway:verify

`railway:migrate` only ever reads Supabase. `railway:verify` exits non-zero if
anything differs; during a rehearsal the tables the live app wrote to since the
copy will differ in contents, and it says so.

Then, in the Railway project that holds the Postgres:

1. **postgrest** — new service from image `postgrest/postgrest:v14.5`,
   variables from `postgrest.env.example`. No public domain.
2. **auth** — new service from image `supabase/gotrue:v2.193.1`, variables from
   `gotrue.env.example`. No public domain.
3. **gateway** — new service from this repo, root directory
   `infra/railway/gateway`. Variables:
   `AUTH_UPSTREAM=auth.railway.internal:9999`,
   `REST_UPSTREAM=postgrest.railway.internal:3000`. Generate a public domain.
   `https://<gateway-domain>/health` should answer `ok`, and
   `https://<gateway-domain>/auth/v1/health` should name GoTrue v2.193.1.

Point a local API at it and try the app:

    SUPABASE_URL=https://<gateway-domain> SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> pnpm dev

and a local web build with `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
set the same way. Sign in with a real account. Ring up a sale, a return, a
production review, an expense. This is the step that covers what the list
above says was not tested.

## Files

    pnpm files:copy             # what would be copied
    pnpm files:copy --confirm   # copy

Read the header of `src/scripts/copy-storage-to-s3.ts` and the two warnings
next to `FILES_S3_BUCKET` in `.env.example` (lifecycle rules, IAM policy) first.
This is independent of the database move and can be done days earlier.

## Cutover

Pick a time the shops are closed. Budget an hour; the copy itself is minutes.

1. Build the web app and the APK against the gateway (values are listed at the
   bottom of `.secrets.env`). Do not release them yet.
2. **Stop writes.** Heroku → `heroku maintenance:on`. From here Supabase does
   not change, which is what makes the next two steps exact.
3. `pnpm railway:migrate --reset-target`
4. `pnpm railway:verify` — must end `RESULT: PASS — the target is an exact copy`.
   If it does not, stop: `heroku maintenance:off` and nothing has changed.
5. `pnpm files:copy --confirm --rewrite-logo-url` if files are moving now.
6. Heroku config vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `SUPABASE_DB_URL` (now the Railway public connection string, database
   `mountainbakes` — this is what the backups dump). `FILE_STORAGE_DRIVER=s3`
   and its settings if step 5 ran.
7. `heroku maintenance:off`. `GET /health` should report `database: connected`.
8. Release the web build; hand out the APK.
9. Sign in as an admin, a branch manager and a finance user. Make one real sale
   and find it in the Railway database.
10. `pnpm railway:migrate --mark-live` — from now on the migrate script refuses
    to wipe this database.
11. `pnpm backup:manual` (or wait for the nightly) and confirm it verifies.

### Going back

Before step 9 has produced real work: set the three Heroku config vars back
and re-release the previous web build. Supabase is exactly as it was at step 2.

After real work has been done on Railway, going back loses that work. Decide at
step 9, not the next morning.

## Afterwards

- Leave the Supabase project alone for at least two weeks, then pause it before
  deleting it. It is the only rollback there is.
- New migrations: `supabase db push --db-url "$RAILWAY_DB_URL"`. The history
  table came across, so the CLI knows which have run. A migration that grants
  to `anon` or `authenticated` still applies but no longer opens anything —
  see `post-restore.sql`.
- After any `--reset-target`, the role passwords survive. `pnpm railway:secrets`
  re-applies the ones on file if in doubt.
- `SUPABASE_*` variable names now hold Railway values. Renaming them is a
  change to 80 files for no behaviour; it has not been done.

## The files here

| File | What it is |
|---|---|
| `migrate-data.ts` | `pnpm railway:migrate` — dump Supabase, restore into Railway |
| `bootstrap.sql` | Roles, schemas, extensions, time zone. Run before the restore |
| `post-restore.sql` | Ownership and grants. The whole access model |
| `verify-migration.ts` | `pnpm railway:verify` — source against target |
| `service-secrets.ts` | `pnpm railway:secrets` — JWT secret, keys, role passwords |
| `postgrest.env.example`, `gotrue.env.example` | Variables for the two services |
| `gateway/` | The public gateway (Caddy) |
| `.secrets.env` | Generated. Git-ignored. Never commit |
