# Data Engine — generic list, aggregate and export API

One endpoint family serves every filterable, searchable, sortable, paginated
list in the web app:

```
GET /api/data/:resource             one page            → PaginatedResponse<Row>
GET /api/data/:resource/meta        allowed fields/ops  → ResourceMeta
GET /api/data/:resource/aggregate   count/sum/avg/min/max (+groupBy) over the filtered set
GET /api/data/:resource/export      the filtered set as .xlsx / .csv, built server-side
```

Code: `src/data-engine/` (engine) and `src/routes/data.routes.ts` (HTTP).
Wire types: `src/shared/types/data-engine.types.ts` (mirrored in the frontend).

## Query string

Identical to what the web app keeps in its own address bar:

```
page=2  pageSize=50  search=cake  sort=createdAt:desc  includeDeleted=1
status=completed                       → eq
createdAt.gte=2026-09-01               → operator after a dot
status.in=pending&status.in=ready      → repeated param (or comma list) for in / nin / between
notes.null=1                           → unary operators take any value
```

Operators: `eq neq gt gte lt lte in nin like ilike null notnull between`.
`pageSize` must be 20, 50 or 100. Unknown fields, disallowed operators and bad
values are a 400 that names the field.

Enum values are validated by the DATABASE, not by a second copy of each enum
here (that copy would drift the first time one changed). Postgres answers a
bad member with `22P02`, and `asClientError` turns it into the 400 it is,
naming the field — `?status=bogus` must not be a 500, and it happens for real
when a renamed value leaves old bookmarks and shared links behind.

Dates: a `YYYY-MM-DD` value on a `timestamp` field is widened to the whole day.
Fields marked `businessDay` in the registry use the 2 AM Karachi rollover from
`shared/utils/timezone.ts` (`businessDayBounds`); the rest use the civil day.
There is no second business-day rule.

## Resource registry — `src/data-engine/registry.ts`

The only place a resource is declared. Each entry names the table, the roles
that may read it, a `scope()` computed from the verified JWT (a branch role is
pinned to `req.user.branchId`; a help-desk raiser to `raised_by = uid`; a
non-admin's login history to `user_id = uid`), and the allowlists:

| key | meaning |
|---|---|
| `fields` | every filterable field, with its kind (`text enum uuid number boolean date timestamp`) — kind decides the legal operators |
| `searchableFields` | ILIKE'd by `search` |
| `sortableFields` / `defaultSort` / `tiebreaker` | what `sort=` may name |
| `softDelete` | excludes `deleted_at is not null` unless an allowed role sends `includeDeleted=1` |
| `aggregatableFields` / `groupableFields` | what `/aggregate` may sum or group by |
| `transform` | per-caller redaction / reshaping after snake→camel (help-desk `internalNote`, login-history email mask, `businessDate → date`) |
| `export` | sheet columns, file name, row ceiling (default 10 000) |
| `cache` | `static` (60 s `Cache-Control`) or `live` (`no-store`) |

Published resources: `sales orders productionOrders productionStock branchStock
stockAudit closingStock dailySaleRecords expenses income finance financeHelpDesk
financeAudit transactions products customers users loginHistory loginAttempts
support auditLogs`.

Security, in one line: the URL names a resource, never a table; a caller names
fields, never columns; scope comes from the JWT and is ANDed under every filter,
so a filter can only narrow what the role already allowed.

## How a request runs

```
parseListQuery  →  validated fields/ops/values against the registry
buildCondition  →  AND( scope, soft-delete, filters, OR(search) )   (where.ts)
applyCondition  →  PostgREST filters                                  (list / export)
                →  jsonb tree → data_engine_aggregate()               (aggregate)
```

The list, export and aggregate paths share `buildCondition`, so a dashboard
card and the table under it count the same rows by construction.

## Aggregation — migration 108

PostgREST's aggregate functions are switched off on this database (PGRST123),
so `/aggregate` calls `public.data_engine_aggregate(table, where, metrics,
group_by)` from `supabase/migrations/20260908000108_data_engine_aggregate.sql`.
It allowlists the table (a literal list mirroring the registry — keep it in
step), checks every column against `information_schema`, `quote_literal`s every
value, and has EXECUTE revoked from `anon` / `authenticated`.

Until the migration is applied, a bare `metrics=count` still works (it is a
HEAD request) and anything else answers `501` with a message saying so.

Migration 109 adds the indexes for the new filter/search/sort shapes (btree on
scope + default sort, trigram GIN for the search columns).

## The remote schema can be behind the migration ledger

Checked 2026-09-09: migration 106 is only partially applied on the linked
database — `finance_tickets` has `query_no`, `priority`, `query_type`,
`assigned_to` and `voucher_ref`, but NOT `branch_id`, `branch_name`, `amount`,
`business_date` or `recreated_from_id`. Migrations 105, 106, 107, 108 and 109
all show as pending in `npx supabase migration list --linked`.

The `financeHelpDesk` resource therefore declares only the columns that exist;
the five lines to restore are commented in place and marked `← migration 106`.
This matters beyond the engine: the hand-written Help Desk route filters on
`amount` and `branch_id`, so those filters cannot be working on the deployed
API either.

Before adding a field to any resource, confirm the column exists on the
DATABASE, not just in a migration file. A declared column the table lacks
turns a filter, a sort, or — worst — the plain search box into a 42703.

## Adding a resource

1. Add a `ResourceConfig` to `registry.ts` and register it under a name.
2. If it should aggregate, add its table to `v_allowed` in migration 108 (a new
   migration that redefines the function).
3. Check indexes for `scope + defaultSort` and any trigram search columns.
4. The frontend uses it with `<GenericDataTable resource="name" … />` — see
   `../frontend/DATA-ENGINE.md`.

## Testing without a browser

There is no test runner. The engine can be exercised read-only against the
linked database with a `tsx` script that imports `runListQuery` /
`runAggregate` with a hand-built `AuthUser`, or over HTTP by mounting
`data.routes.ts` on a local Express app after replacing
`supabaseAdmin.auth.getUser` with a stub that maps a fake bearer token to a
role. Migrations can be applied in `@electric-sql/pglite` over stub tables.
