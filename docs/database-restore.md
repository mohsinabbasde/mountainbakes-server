# Database Restore Procedure

How to get a Mountain Bakes database back from a backup in
`s3://mountainbakes-bucket/database-backups/`. Read the whole page before
running anything in the **Production recovery** section — those commands
overwrite data.

Convention: **⚠ DESTRUCTIVE** marks a command that drops or overwrites objects
in the database it is pointed at. Every one of them must be run by a person,
against a database whose name they have just typed and read back, never from
a script and never on a schedule.

## 0. Prerequisites

- PostgreSQL client tools whose major version ≥ the server that took the
  backup (17): locally `sudo apt install postgresql-client-18` (Ubuntu 26.04)
  or `postgresql-client-17`; on the dyno they are at
  `/app/.apt/usr/lib/postgresql/17/bin`.
- AWS credentials that can read `database-backups/*` (the backup IAM user, or
  a person's).
- For a **test** restore: an isolated PostgreSQL database — a local server
  (`sudo apt install postgresql-18`, `createdb mountainbakes_restore_test`) or
  a throwaway Supabase project. For **production** recovery: the target
  Supabase project's session-pooler connection string.

## 1. Identify the backup

```bash
pnpm backup:list -- --type daily --limit 14        # or weekly / monthly / manual
pnpm backup:status                                 # last verified per type
```

Or in Admin → Database Backup. Note the **backup ID** (e.g.
`backup-daily-2026-09-21`) and its manifest key
(`database-backups/manifests/daily/2026/09/backup-daily-2026-09-21.json`).
If the ledger itself is gone (the database is what you are restoring), list
the manifests directly: `aws s3 ls s3://mountainbakes-bucket/database-backups/manifests/daily/2026/09/`
— every manifest is self-describing.

## 2. Verify the checksum before trusting it

```bash
pnpm backup:verify -- --backup-id backup-daily-2026-09-21
```

This compares the manifest, the ledger row and `HeadObject` (size + sha256
metadata) for both archives. Do not proceed on a failed check; pick the
previous backup instead.

## 3. Download

```bash
mkdir -p /tmp/mb-restore && cd /tmp/mb-restore
aws s3 cp s3://mountainbakes-bucket/database-backups/manifests/daily/2026/09/backup-daily-2026-09-21.json .
aws s3 cp s3://mountainbakes-bucket/database-backups/daily/2026/09/mountainbakes-daily-2026-09-21.dump .
aws s3 cp s3://mountainbakes-bucket/database-backups/daily/2026/09/mountainbakes-daily-2026-09-21-auth.dump .
sha256sum *.dump                                   # must equal files[].checksumSha256 in the manifest
pg_restore --list mountainbakes-daily-2026-09-21.dump | head -40    # archive readable, TOC lists TABLE public …
```

(`pnpm backup:restore:test` does steps 3–7 automatically for a test target.)

## 4. Prepare the target database

**Plain PostgreSQL (local drill):**

```sql
-- as a superuser on the target server
create database mountainbakes_restore_test;
\c mountainbakes_restore_test
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth; create schema if not exists extensions; create schema if not exists app;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema public;   -- production keeps pg_trgm in public; the trigram indexes reference public.gin_trgm_ops
create extension if not exists citext with schema extensions;
-- stand-ins for Supabase's auth helpers referenced by RLS policies/defaults
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
```

**Supabase project (new or existing):** roles, `auth`, `extensions` and
`auth.uid()` already exist. Nothing to prepare except making sure it is the
project you mean.

## 5. Restore

**Order matters: auth archive first, then main.** The main archive ends by
adding `public.users_id_fkey → auth.users`; if `auth.users` is missing or empty
at that point the constraint fails, and the rest of the restore carries on
without it. The auth archive is self-contained (`auth.users` +
`auth.identities`, no references into `public`), so it can always go first.

Auth archive — `auth.users` + `auth.identities`:

```bash
# Plain PostgreSQL target (tables do not exist yet): full restore
pg_restore --no-owner --no-privileges --dbname "<target>" mountainbakes-daily-2026-09-21-auth.dump

# ⚠ DESTRUCTIVE on a Supabase target (tables exist, owned by supabase_auth_admin): data only
psql "<target>" -c "set session_replication_role = replica; truncate auth.identities, auth.users cascade;"
pg_restore --data-only --no-owner --no-privileges --dbname "<target>" mountainbakes-daily-2026-09-21-auth.dump
```

Main archive — schema + data for `public`, `app`, `supabase_migrations`, into
an **empty** target (a fresh database or a new Supabase project):

```bash
export PGSSLMODE=require          # Supabase targets; omit for a local socket
# Skip CREATE SCHEMA public/app — they already exist (public holds pg_trgm, see step 4)
pg_restore --list --file main.toc mountainbakes-daily-2026-09-21.dump
grep -vE '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - (public|app) ' main.toc > main.filtered.toc
pg_restore --no-owner --no-privileges --no-comments --use-list main.filtered.toc \
  --dbname "postgresql://<user>:<password>@<host>:5432/<database>" \
  mountainbakes-daily-2026-09-21.dump
```

Restoring over a database that already has these objects? Don't use
`--clean`: it cannot drop `public` (pg_trgm depends on it) or `auth.users`
(the cross-schema FK), so it fails halfway. Use a fresh target instead, or
**⚠ DESTRUCTIVE**: `drop schema if exists public, app, auth, supabase_migrations cascade; create schema public;`
first, then redo step 4.

`--no-owner --no-privileges` because the archive records Supabase's owners and
grants, which a plain server does not have; on a Supabase target the
schema-level grants to `anon`/`authenticated`/`service_role` are re-applied by
the migration files' `grant` statements if needed, and `supabase db push`
sees `supabase_migrations.schema_migrations` restored and reports nothing
pending. A clean restore in this order exits 0 (proven 2026-09-25); any error
message means something is missing, so read it before verifying.

`session_replication_role = replica` is Supabase's own guidance for loading
auth data: it silences the auth triggers during the load. Restored users keep
their password hashes and `app_metadata` (role, branch), so they sign in as
before; their sessions/refresh tokens are not restored, so everyone signs in
again once.

## 6. Verify the schema

```sql
select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';   -- ≈ the count in backup_database_info() / the manifest era (80+)
select count(*) from supabase_migrations.schema_migrations;                                                -- ≥ 117
select to_regprocedure('claim_business_day_closure(date, closure_trigger, text, boolean, integer)');       -- not null
select to_regprocedure('app.jwt_role()');                                                                   -- not null
select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal;
select count(*) from pg_indexes where schemaname='public';
select count(*) from pg_policies where schemaname='public';
```

## 7. Verify the data

```sql
select 'users', count(*) from users union all select 'branches', count(*) from branches
union all select 'products', count(*) from products union all select 'product_price_history', count(*) from product_price_history
union all select 'orders', count(*) from orders union all select 'order_items', count(*) from order_items
union all select 'expenses', count(*) from expenses union all select 'stock', count(*) from stock
union all select 'production_orders', count(*) from production_orders union all select 'daily_closing_reports', count(*) from daily_closing_reports
union all select 'ledger_entries', count(*) from ledger_entries union all select 'auth.users', count(*) from auth.users;
select max(created_at) from orders;          -- the recovery point: nothing after this exists
select count(*) from auth.users u join users p on p.id = u.id;   -- every app user has an auth row
```

Compare with the figures the business expects (yesterday's closing report,
the last known order number). `max(created_at)` is your **recovery point**.

## 8. Verify functions, triggers, policies

Run one read-only business function to prove the code inside the database
works, e.g. `select * from finance_ledger_totals(...)` or the data engine
`select public.data_engine_aggregate(...)` with a harmless argument. Confirm
`settings` has its singleton row and `business_day_closures` shows the last
closed day.

## 9. Test the application

Point a **local** API at the restored database's Supabase project
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` of that project), start `pnpm
dev`, sign in as a super admin, open Dashboard, Orders, Reports, Finance Ledger,
Stock. Check `/health` and that Realtime updates arrive. Do this before anyone
is told the system is back.

## 10. Production recovery — human confirmation required

Only after 1–9 have passed on a test target:

1. Announce downtime; stop the Heroku web dyno (`heroku ps:scale web=0`) so
   nothing writes during the restore.
2. Decide the target: the **same** Supabase project (data loss / corruption) or
   a **new** project (project lost). Supabase's own PITR/snapshot restore may be
   the faster path for the same project — check the dashboard first (see
   [database-disaster-recovery.md](database-disaster-recovery.md)).
3. Take a manual backup of whatever is there now, if anything: `pnpm backup:manual`.
4. Type the production connection string into a shell variable and **read it
   back aloud**. Then, in step 5's order:
   - auth: the Supabase data-only load (⚠ DESTRUCTIVE truncate of `auth.users`/`auth.identities`).
     Never drop the `auth` schema on Supabase — it belongs to Supabase Auth.
   - main, same project only (⚠ DESTRUCTIVE): `drop schema if exists public, app, supabase_migrations cascade;`
     then `create schema public; grant usage on schema public to anon, authenticated, service_role;`
     and `create extension if not exists pg_trgm with schema public;`, then the filtered-TOC
     `pg_restore` from step 5. A new project skips the drop.
   - This production path has **not** been rehearsed yet (the 2026-09-25 drill was a local
     target); rehearse it on a throwaway Supabase project before relying on it.
5. Re-run steps 6–8 against production. Reset sequences are already in the
   archive; no manual `setval` is needed.
6. If a new project: update `SUPABASE_URL`/keys on Heroku and the frontend
   build (`NEXT_PUBLIC_*` requires a rebuild), re-upload Supabase Storage files
   from wherever they were kept, reconfigure Auth providers, re-link the CLI.
7. `heroku ps:scale web=1`, smoke-test, then `heroku run "pnpm backup:manual"`
   so the first post-recovery backup exists before business resumes.
8. Record the incident and the recovery point in the log below.

## Restore drill log

Run `pnpm backup:restore:test` at least **monthly** (see the disaster-recovery
doc); every run is also written to `backup_restore_tests` and shown on the
admin screen.

| Date | Backup used | Target | Result | Duration | Issues |
| --- | --- | --- | --- | --- | --- |
| 2026-09-25 | `backup-daily-2026-09-25` (3.0 MB + 18.2 KB auth) | local PostgreSQL 18.6 (`mountainbakes_restore_test`) | **PASSED** — 0 pg_restore errors; identical to production: 73 tables, 45 triggers, 349 indexes, 50 policies, 94 functions, orders 2534 / order_items 3867 / stock_history 7401 / ledger_entries 650, auth.users 15 = public.users 15 | 5.9 s restore (+ ~15 s download) | First attempts found three script bugs, all fixed: pg_trgm made in `extensions` (production has it in `public`); main restored before auth, silently losing `users_id_fkey`; `--clean` failing on rerun. Checks also pointed at `product_prices`/`stock_movements`, which don't exist (now `product_price_history`, `stock`, `stock_history`) |
