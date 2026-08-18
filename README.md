# Mountain Bakes API

The Express REST API for Mountain Bakes ERP. Talks to Supabase (Postgres, Auth,
Storage) and owns every privileged database write — the web client never writes to
those tables directly; it goes through this API.

This folder is a **standalone project**. Its sibling `../frontend/` is the Next.js
web client, deployed separately. Neither depends on any file above this directory.

```
server/
├── server.ts             # entry: loads env, listens, starts schedulers
├── src/
│   ├── app.ts            # the configured Express app (helmet, CORS, routes)
│   ├── config/           # supabase.ts — Supabase admin client init
│   ├── routes/           # route modules (wired in routes/index.ts)
│   ├── services/         # business logic (stock, pricing, exports, push…)
│   ├── middleware/       # auth, requireRole, validate, business-day guard
│   ├── scheduler/        # node-cron: 2 AM closing, price activation
│   ├── scripts/          # purge-price-history
│   └── shared/           # schemas/types (mirrored in frontend/src/shared)
├── supabase/             # SQL migrations + local CLI state
└── Procfile              # web: pnpm start
```

## Local development

```bash
pnpm install
cp .env.example .env          # then fill it in
pnpm dev                      # http://localhost:3001
```

Requires Node 24.x and pnpm 11.12.0 (both pinned in `package.json`).

Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the **secret**
service-role key) in `.env`. The service-role key bypasses RLS and can manage auth
users, so it must never reach the browser (see [DEPLOY.md](DEPLOY.md)).

To run the full stack, start the web client in a second terminal:

```bash
cd ../frontend && pnpm dev    # http://localhost:3000
```

There is no longer a single command that starts both — they are independent
projects by design.

## Authentication

Requests carry a **Supabase** access-token JWT as `Authorization: Bearer <jwt>`,
verified in `src/middleware/auth.ts` via `supabaseAdmin.auth.getUser(token)`. Role
and branch come from the user's Supabase `app_metadata`.

There is no session cookie on this side; the `mb_session` cookie belongs to the web
app and stays on its own origin. This is why the two apps can live on different
hosts.

Browser origins allowed to call this API come from `CORS_ORIGINS` (comma-separated).
localhost and 127.0.0.1 are always permitted. A mismatch fails **silently** in the
API logs — the browser blocks it — so compare the request's `Origin` header against
the `[cors] Allowed origins:` line printed at boot.

## Idempotency (offline-capable writes)

The mobile client writes to its own database first and sends afterwards, so any
send can be retried — after a timeout, after a dyno restart, after the app is
killed mid-request. Five endpoints therefore accept an **`Idempotency-Key`**
header and will not apply the same request twice:

```
POST /api/orders          POST /api/orders/pos        POST /api/expenses
POST /api/production-orders                           POST /api/stock/return
```

| Repeat of… | Answer |
|---|---|
| a request that succeeded | the original response, with `Idempotency-Replayed: true`. Nothing runs again. It is stored as `jsonb`, so the fields and values are the original ones and only key order may differ |
| a request still in flight | `503` + `Retry-After: 5` |
| a request whose earlier attempt died mid-flight (>5 min) | `409` — a person has to check whether it went through |
| the same key with a different body | `422` |
| a request that failed without changing anything | the key is released, so a later retry is a real attempt |

**No header, no change.** The web app sends none and is unaffected.

The same five endpoints accept an optional **`businessDate`** (`date` on
expenses) — the day the device captured, for a transaction created offline and
synced later. It is bounded and closure-checked by
`src/utils/clientBusinessDate.ts`, never trusted: no future dates, nothing older
than seven business days, and a closed day is refused exactly as it is for a
back-dated write from the web app.

Storage and the claim decision are migration 84 (`idempotency_keys`); the HTTP
layer is `src/middleware/idempotency.ts`. Both files carry the reasoning.

`pnpm verify:idempotency` exercises the whole claim/replay/release/stale set
against the linked database and prints what it found. It is safe to run against
production — it touches `idempotency_keys` only, under synthetic user ids, and
deletes its own rows even when a check fails.

## Database schema

The Postgres schema lives in `supabase/migrations/*.sql` and is applied with the
Supabase CLI (`supabase db push`). Row Level Security is defined in the migrations;
because this API uses the service-role key it bypasses RLS, so authorization is
enforced in application code (see `middleware/requireRole` and the per-handler
branch/role scoping).

## Scheduled jobs

`src/scheduler/` arms two node-cron jobs at 2:00 AM Asia/Karachi: the daily closing
and future-dated price activation. They only fire while this dyno is awake, so avoid
a sleeping tier if you depend on the exact 2 AM run. Keep the API at one dyno
(`heroku ps:scale web=1`) — the jobs are idempotent but the idempotency locks assume
a single instance.

## Maintenance scripts

```bash
pnpm purge:price-history              # dry run — counts, deletes nothing
pnpm purge:price-history -- --confirm # permanently delete
pnpm purge:idempotency-keys           # dry run — expired replay keys (30d default)
pnpm purge:idempotency-keys -- --confirm
node scripts/seed.js                  # seed baseline data + super admin
node scripts/enable-email-auth.mjs    # toggle email/password sign-in
```
