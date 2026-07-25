# Mountain Bakes Control Engine (MBCE) — Summary

> **This document is a condensed reference for the `mountainbakes-engine` service.**
> ⚠️ **The engine source no longer exists.** It was archived to
> `mountainbakes-engine.tar.gz` and that archive has since been **deleted**. There is
> no git history or other backup, so **this summary is the only surviving record of
> the engine** — it cannot be restored, only rebuilt from this document.
> An identical copy of this summary lives in both `mountainbakes-server/` and
> `mountainbakes-frontend/`.

---

## What it is

A centralized **FastAPI orchestration layer** for the Mountain Bakes ERP. Every
coordinated write flows through one place: the engine **authorizes** it, **validates**
business rules, runs it as an **atomic DB transaction** (a Postgres RPC), emits a
**domain event**, records an **audit** entry, and **broadcasts** a real-time update.

- **Language/stack:** Python 3.12, FastAPI, httpx, PyJWT, Redis (optional), Pydantic 2.
- **Status:** *Runnable foundation, not the finished ERP.* Engine core, infra,
  security, and the flagship **production-order review** flow are real and tested.
  Several services are deliberate stubs with command + permission wiring in place.

## How it fits the system

| Repo | Role |
|------|------|
| `mountainbakes-frontend` | Next.js 16 UI |
| `mountainbakes-server` | **Express + TypeScript + Supabase** — the live backend |
| `mountainbakes-engine` | FastAPI control engine (this summary) |

The real business logic already lives in **Postgres functions** in
`mountainbakes-server/supabase/migrations` (`review_production_order`, `commit_sale`,
`apply_stock_movement`, …). The engine **does not re-implement them** — it calls the
same RPCs, so atomicity lives in the database where it's strongest.

### ⚠️ Open strategic decision (unchanged by this archival)

The engine and the Express backend **overlap** — both can own orders/stock/auth
against the same Supabase project. Pick one before running both long-term:
1. **Migrate** endpoints off Express onto the engine module-by-module, then retire Express.
2. **Strangler**: front both with the frontend, shift traffic gradually.

Until then it's a parallel service on non-overlapping routes.

---

## Architecture

```
app/
  main.py                 FastAPI app: lifespan, middleware, routers
  engine/                 cross-cutting core (the "control engine")
    config.py             env-based settings, degrades gracefully
    logger.py             structured JSON logs + request-id correlation
    metrics.py            counters / latency / cache-hit ratio → /admin/metrics
    security.py           verify Supabase JWT → Principal (authN)
    permissions.py        RBAC + branch ownership (authZ) — RLS is bypassed, so this is the gate
    validator.py          business-rule validation
    event_bus.py          async pub/sub (+ optional Redis fan-out across instances)
    events.py             EventType catalog
    dispatcher.py         command → (handler, required action) registry
    control_engine.py     the pipeline: authorize → handle → metrics/errors
    cache_manager.py      Redis cache, in-memory fallback, get_or_set/invalidate
    task_queue.py         async background workers (reports/exports/email)
    scheduler.py          periodic jobs (daily summaries, cleanup)
    websocket.py          connection manager, targeted broadcast (user/branch/role)
    health.py             liveness + per-subsystem readiness
    supabase_client.py    async PostgREST + RPC over httpx
  services/               domain logic, one command handler per capability
    order_service.py      ⭐ flagship: review_production_order (atomic RPC) + event + audit
    stock_service.py      cached reads + apply_stock_movement (real RPC, unverified vs live DB)
    sales_service.py      commit_sale (real RPC, unverified vs live DB)
    production_service.py  STUB (production.prepare)
    notification_service.py  event consumer → WS + notifications row
    audit_service.py      audit_logs writes
    user_service.py       STUB (user.manage)
    report_service.py     enqueues onto the task queue (body is a scaffold)
  api/routes/             thin HTTP adapters → engine.execute(command, …)
```

Every module talks to the **engine**, never to another module directly: services
register command handlers on the dispatcher, publish events on the bus, and the
notification/real-time layer *consumes* those events.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | service info |
| GET | `/health` | liveness |
| GET | `/ready` | per-subsystem readiness (reports `degraded` w/o Supabase/Redis) |
| GET | `/docs` | interactive OpenAPI |
| POST | `/orders/{order_id}/review` | ⭐ flagship production-order review (atomic) |
| GET | `/stock/{branch_id}` | cached branch stock read |
| POST | `/stock/adjust` | apply a stock movement |
| WS | `/ws` | targeted real-time broadcast (user/branch/role) |
| GET | `/admin/metrics` | Prometheus-style text exposition |
| GET | `/admin/metrics/json` | metrics as JSON |
| GET | `/admin/commands` | list registered commands |

## Registered commands & events

- **Commands** (dispatcher): `order.review`, `stock.adjust`, `sale.create`,
  `production.prepare` (stub), `user.manage` (stub), `report.generate` (scaffold).
  Each is guarded by a matching permission `action`.
- **EventType catalog:** `NEW_ORDER`, `UPDATE_ORDER`, `APPROVE_ORDER`,
  `REJECT_ORDER`, `SALE_COMPLETED`, `STOCK_RECEIVED`, `STOCK_RETURNED`,
  `PRICE_CHANGED`, `USER_CREATED`, `USER_UPDATED`, `NOTIFICATION_CREATED`.

## Request lifecycle (production-order approval)

```
POST /orders/{id}/review  (Bearer <supabase jwt>)
  → security.verify_token           who is this? (authN)
  → engine.execute("order.review")
       → permissions.require_action  may this role review? (authZ)
       → validator.validate_review   are the overrides sane?
       → supabase.rpc(review_production_order)   ← ATOMIC in Postgres
       → cache.invalidate_prefix("production")
       → bus.publish(APPROVE_ORDER)  → notifications + WebSocket broadcast
       → audit_service.record(...)
  → 200 { ok, order }
```

---

## Run it (for reference — source no longer present)

These are the original run steps, kept for reference only. The engine source has
been deleted, so it would first have to be rebuilt from this document. Verified on
Python 3.12 when the source existed.

```bash
cd mountainbakes-engine
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env         # fill SUPABASE_* + SUPABASE_JWT_SECRET
uvicorn app.main:app --reload --port 8000
# with Redis (matches production):  docker compose up --build
pytest -q                    # 8 tests: boot/health, RBAC + branch ownership, event bus
```

It **boots without Supabase or Redis** — `/ready` reports `degraded` and write
commands return 503 until the DB is configured (intentional: an orchestrator should
surface a red signal, not crash-loop).

## Performance & security

- **Cache hot reads** (`get_or_set`, short TTL, single-flight to prevent stampedes).
- **One RPC per write** — multi-table effects collapse into a single atomic call.
- **Async everywhere** (httpx + async workers); background queue keeps reports/exports/email off the request path.
- **JWT verified locally** (HS256, Supabase secret) — no network hop per request.
- Service-role DB access **bypasses RLS**, so `permissions.py` is the real gate
  (mirrors `*_rls.sql`: super_admin / branch_manager / production_user + branch ownership).
- Rate limiting, security headers, CORS allow-list, request-ids, global exception
  handler, structured audit logging all present.

## Scope — real vs stub

- **Real & tested:** engine core (config, logging, metrics, security, permissions,
  validator, event bus, dispatcher, control engine, cache, task queue, scheduler,
  websocket, health), the Supabase client, and `OrderService.review` end-to-end.
- **Real but unverified vs live DB:** `StockService`, `SalesService` (correct RPCs, no creds here).
- **Stubs (wiring present, logic TODO):** `production_service`, `user_service`,
  `report_service` body; the broader module surface (vendors, categories,
  settings, …) is not built. Column names in `audit_service` / `notification_service`
  are **assumptions — verify against `mountainbakes-server/supabase/migrations`**.
- **Not included:** Celery/RQ durable queue (in-process queue is a drop-in shape),
  Prometheus client (text exposition provided), migration of existing Express endpoints.

## Suggested next steps

1. Fill `.env` with a real Supabase project and exercise `POST /orders/{id}/review`
   against a test order — validates the whole pipeline on live data.
2. Reconcile `audit_logs` / `notifications` column names with the SQL migrations.
3. Port one Express endpoint fully (e.g. sales) as the migration pilot.
4. Swap the in-process task queue for RQ+Redis once report generation is real.
