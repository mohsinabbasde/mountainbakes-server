-- 109: Data Engine — indexes for the filter/search/sort surface the generic
-- list endpoint exposes (`src/data-engine/registry.ts`).
--
-- Each index below answers a query shape the engine now issues that no
-- existing index covers. The shape is always the same: the caller's SCOPE
-- (branch_id / user_id) plus the resource's DEFAULT SORT (a timestamp,
-- descending), optionally narrowed by one enum. Where a table already has
-- that pair — orders (branch_id, created_at desc), expenses (branch_id,
-- business_date desc), login_sessions (user_id, login_at desc) — nothing is
-- added.
--
-- Free-text search is ILIKE '%term%' across a few columns. A B-tree cannot
-- serve a leading-wildcard pattern, so the columns people actually search
-- get a trigram GIN index (pg_trgm). Only the tables that grow with trade are
-- covered; a 60-row products table scans faster than it looks anything up.
--
-- Nothing here changes a row. Every statement is IF NOT EXISTS, so the file
-- can be re-applied.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- production_stock_history — the Production Stock ledger. Filtered by branch,
-- type and product; sorted by created_at desc. Previously indexed only on
-- (business_date, product_id) and ref_id.
-- ---------------------------------------------------------------------------
create index if not exists production_stock_history_created_idx
  on public.production_stock_history (created_at desc);
create index if not exists production_stock_history_branch_created_idx
  on public.production_stock_history (branch_id, created_at desc)
  where branch_id is not null;
create index if not exists production_stock_history_type_created_idx
  on public.production_stock_history (type, created_at desc);
create index if not exists production_stock_history_product_created_idx
  on public.production_stock_history (product_id, created_at desc);

-- ---------------------------------------------------------------------------
-- stock_history — the Branch Stock ledger. Scoped by branch, sorted by
-- created_at desc; the existing (branch_id, business_date, product_id) index
-- does not serve that sort.
-- ---------------------------------------------------------------------------
create index if not exists stock_history_branch_created_idx
  on public.stock_history (branch_id, created_at desc);
create index if not exists stock_history_type_created_idx
  on public.stock_history (type, created_at desc);

-- ---------------------------------------------------------------------------
-- login_sessions — the Security board filters on four columns that had no
-- index: branch, role, device and city.
-- ---------------------------------------------------------------------------
create index if not exists login_sessions_branch_login_idx
  on public.login_sessions (branch_id, login_at desc)
  where branch_id is not null;
create index if not exists login_sessions_role_login_idx
  on public.login_sessions (user_role, login_at desc);
create index if not exists login_sessions_device_login_idx
  on public.login_sessions (device_type, login_at desc)
  where device_type is not null;
create index if not exists login_sessions_city_login_idx
  on public.login_sessions (city, login_at desc)
  where city is not null;

-- ---------------------------------------------------------------------------
-- orders — payment-method filter (the Daily Sale views group by it) and the
-- business-date sort within a branch.
-- ---------------------------------------------------------------------------
create index if not exists orders_payment_created_idx
  on public.orders (payment_method, created_at desc);

-- ---------------------------------------------------------------------------
-- finance_transactions / ledger_entries — branch filter with the default sort.
-- ---------------------------------------------------------------------------
create index if not exists finance_txn_branch_date_idx
  on public.finance_transactions (branch_id, business_date desc, created_at desc)
  where branch_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Trigram indexes for the search boxes. GIN + gin_trgm_ops serves
-- `col ILIKE '%term%'` for terms of three characters or more.
-- ---------------------------------------------------------------------------
create index if not exists orders_customer_name_trgm_idx
  on public.orders using gin (customer_name extensions.gin_trgm_ops);
create index if not exists orders_customer_phone_trgm_idx
  on public.orders using gin (customer_phone extensions.gin_trgm_ops);
create index if not exists orders_order_number_trgm_idx
  on public.orders using gin (order_number extensions.gin_trgm_ops);

create index if not exists production_stock_history_product_name_trgm_idx
  on public.production_stock_history using gin (product_name extensions.gin_trgm_ops);
create index if not exists production_stock_history_txn_no_trgm_idx
  on public.production_stock_history using gin (transaction_no extensions.gin_trgm_ops);

create index if not exists stock_history_product_name_trgm_idx
  on public.stock_history using gin (product_name extensions.gin_trgm_ops);

create index if not exists login_sessions_user_name_trgm_idx
  on public.login_sessions using gin (user_name extensions.gin_trgm_ops);

create index if not exists expenses_description_trgm_idx
  on public.expenses using gin (description extensions.gin_trgm_ops);

create index if not exists ledger_entries_description_trgm_idx
  on public.ledger_entries using gin (description extensions.gin_trgm_ops);
