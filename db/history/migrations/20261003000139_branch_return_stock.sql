-- 139: Branch Return Stock is its own inventory, separate from Production Stock.
--
-- ─── The bug ─────────────────────────────────────────────────────────────────
-- Accepting a branch return wrote a `return_in` movement of +qty into
-- production_stock (production-returns.routes.ts → returnIntoPool →
-- apply_production_stock_movement). Returned units therefore became Production
-- Stock: sellable at the counter and counted against branch demand, although
-- Production never made, received or approved them as stock.
--
-- ─── The fix ─────────────────────────────────────────────────────────────────
-- Two pools that are never combined automatically:
--
--   production_stock (+ production_stock_history)   — unchanged
--   return_stock     (+ return_stock_history)       — new, this migration
--
-- An accepted return credits return_stock ONLY. The single path from Return
-- Stock into Production Stock is transfer_return_stock_to_production: one
-- explicit, authorised transaction that debits one pool and credits the other
-- (as `return_transfer`, migration 138) atomically.
--
-- There is no write-off movement: Return Stock goes down by transfer only, and a
-- damaged or expired return lands here like any other. `disposition` stays on
-- the return row as the record of its condition.
--
-- ─── History ─────────────────────────────────────────────────────────────────
-- Returns accepted before this migration are already inside the production
-- balance. app.split_return_stock() moves the SALEABLE ones out with compensating
-- movements — nothing is edited or deleted, the old `return_in` rows stay as the
-- record of what happened. Damaged/expired ones were written off by their own
-- adjustment at the time (migration 91) and contribute nothing to the pool, so
-- they are left alone.
-- ---------------------------------------------------------------------------

-- ═══ 1. Tables ════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_type where typname = 'return_stock_movement_type') then
    create type return_stock_movement_type as enum ('return_in', 'transfer_out');
  end if;
end
$$;

-- One row per product, like production_stock. Unlike the production pool this
-- one may NOT go negative: nothing can be transferred that did not come back.
create table if not exists return_stock (
  product_id   uuid primary key references products (id) on delete restrict,
  product_name text,
  balance      numeric(14,3) not null default 0,
  updated_at   timestamptz not null default now(),
  constraint return_stock_balance_non_negative check (balance >= 0)
);

drop trigger if exists return_stock_touch on return_stock;
create trigger return_stock_touch before update on return_stock
  for each row execute function app.touch_updated_at();

-- Same idempotency contract as production_stock_history: the unique constraint
-- IS the retry-safety mechanism.
create table if not exists return_stock_history (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null references products (id) on delete restrict,
  product_name         text not null,
  type                 return_stock_movement_type not null,
  delta                numeric(14,3) not null,
  balance_after        numeric(14,3) not null,
  ref_id               text not null,
  business_date        date not null,
  -- The returning branch on a return_in; NULL on a transfer_out, which is
  -- pool-level and belongs to no branch.
  branch_id            uuid references branches (id) on delete set null,
  production_return_id uuid references production_returns (id) on delete set null,
  created_by           uuid references users (id) on delete set null,
  created_by_name      text,
  reason               text,
  remarks              text,
  created_at           timestamptz not null default now(),
  constraint return_stock_history_idempotency_key unique (ref_id, product_id, type)
);

create index if not exists return_stock_history_opening_idx
  on return_stock_history (product_id, business_date) include (delta);
create index if not exists return_stock_history_branch_idx
  on return_stock_history (branch_id, business_date desc);
create index if not exists return_stock_history_recent_idx
  on return_stock_history (business_date desc, created_at desc);

-- Written by the service role only, like the production pool (migration 09).
alter table return_stock         enable row level security;
alter table return_stock_history enable row level security;


-- ═══ 2. apply_return_stock_movement ═══════════════════════════════════════════
--
-- The Return Stock twin of apply_production_stock_movement (migration 89): same
-- idempotency reservation, same relative balance write, same balance_after
-- backfill. It touches return_stock and nothing else.
create or replace function public.apply_return_stock_movement(
  p_product_id           uuid,
  p_product_name         text,
  p_delta                numeric,
  p_type                 return_stock_movement_type,
  p_ref_id               text,
  p_business_date        date,
  p_branch_id            uuid default null,
  p_production_return_id uuid default null,
  p_created_by           uuid default null,
  p_created_by_name      text default null,
  p_reason               text default null,
  p_remarks              text default null
)
returns numeric
language plpgsql
as $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first; balance_after is backfilled below.
  insert into return_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    branch_id, production_return_id, created_by, created_by_name, reason, remarks
  )
  values (
    p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date,
    p_branch_id, p_production_return_id, p_created_by, p_created_by_name, p_reason, p_remarks
  )
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from return_stock where product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  -- UPDATE first, INSERT only for a product's first movement. The production
  -- function upserts in one statement, but that cannot be copied here: the
  -- non-negative CHECK is evaluated on the row proposed for INSERT before the
  -- conflict is resolved, so a transfer_out (negative delta) would be refused
  -- even when the existing balance covers it.
  update return_stock
     set balance = balance + p_delta,
         product_name = coalesce(p_product_name, product_name)
   where product_id = p_product_id
  returning balance into v_balance;

  if not found then
    insert into return_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, p_delta)
    on conflict (product_id) do update
       set balance = return_stock.balance + excluded.balance
    returning balance into v_balance;
  end if;

  update return_stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;

revoke all on function public.apply_return_stock_movement(uuid, text, numeric, return_stock_movement_type, text, date, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_return_stock_movement(uuid, text, numeric, return_stock_movement_type, text, date, uuid, uuid, uuid, text, text, text) to service_role;


-- ═══ 3. accept_production_return — accept and credit Return Stock, atomically ══
--
-- The review used to commit in one transaction and move stock in another
-- (migration 05's "pre-existing weakness"): a failure between the two left a
-- return 'accepted' with no stock behind it, and the retry got "already
-- reviewed". Here the check-and-set and the Return Stock credit are one
-- transaction, so either both happen or neither does.
--
-- It writes NOTHING to production_stock. That is the point of this migration.
create or replace function public.accept_production_return(
  p_return_id        uuid,
  p_disposition      production_return_disposition,
  p_disposition_note text,
  p_reviewed_by      uuid,
  p_reviewed_by_name text,
  p_business_date    date
)
returns jsonb
language plpgsql
as $$
declare
  v_ret     production_returns%rowtype;
  v_balance numeric;
begin
  -- The `status = 'pending'` predicate is what makes a double review a no-op.
  update production_returns
     set status           = 'accepted',
         disposition      = coalesce(p_disposition, 'saleable'),
         disposition_note = coalesce(nullif(btrim(p_disposition_note), ''), disposition_note),
         reviewed_by      = p_reviewed_by,
         reviewed_by_name = p_reviewed_by_name,
         reviewed_at      = now()
   where id = p_return_id and status = 'pending'
  returning * into v_ret;

  if not found then
    return jsonb_build_object('status', 'conflict');
  end if;

  v_balance := public.apply_return_stock_movement(
    v_ret.product_id, v_ret.product_name, abs(v_ret.qty), 'return_in',
    v_ret.id::text, p_business_date,
    v_ret.branch_id, v_ret.id, p_reviewed_by, p_reviewed_by_name, v_ret.reason, null
  );

  return jsonb_build_object(
    'status', 'ok',
    'branchId', v_ret.branch_id,
    'productId', v_ret.product_id,
    'productName', v_ret.product_name,
    'qty', v_ret.qty,
    'reason', v_ret.reason,
    'source', v_ret.source,
    'returnStockBalance', v_balance
  );
end;
$$;

revoke all on function public.accept_production_return(uuid, production_return_disposition, text, uuid, text, date) from public, anon, authenticated;
grant execute on function public.accept_production_return(uuid, production_return_disposition, text, uuid, text, date) to service_role;


-- ═══ 4. transfer_return_stock_to_production — the ONLY bridge ═════════════════
--
-- Debits Return Stock and credits Production Stock by the same quantity in one
-- transaction, both rows under the same ref_id. A repeat with the same ref_id
-- moves nothing. It refuses to transfer more than Return Stock holds.
create or replace function public.transfer_return_stock_to_production(
  p_product_id      uuid,
  p_product_name    text,
  p_qty             numeric,
  p_ref_id          text,
  p_business_date   date,
  p_reason          text,
  p_created_by      uuid default null,
  p_created_by_name text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_available  numeric;
  v_return     numeric;
  v_production numeric;
begin
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'Transfer quantity must be greater than zero.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'invalid', 'error', 'A reason is required to transfer return stock.');
  end if;

  -- Lock the return row so two transfers cannot both spend the same units.
  select balance into v_available from return_stock
   where product_id = p_product_id
   for update;
  if not found then v_available := 0; end if;

  if exists (
    select 1 from return_stock_history
     where ref_id = p_ref_id and product_id = p_product_id and type = 'transfer_out'
  ) then
    select balance into v_production from production_stock where product_id = p_product_id;
    return jsonb_build_object(
      'status', 'duplicate',
      'returnStock', v_available, 'productionStock', coalesce(v_production, 0));
  end if;

  if v_available < p_qty then
    return jsonb_build_object('status', 'insufficient', 'requested', p_qty, 'available', v_available);
  end if;

  v_return := public.apply_return_stock_movement(
    p_product_id, p_product_name, -p_qty, 'transfer_out', p_ref_id, p_business_date,
    null, null, p_created_by, p_created_by_name, btrim(p_reason), null
  );

  v_production := public.apply_production_stock_movement(
    p_product_id, p_product_name, p_qty, 'return_transfer', p_ref_id, p_business_date,
    null, p_created_by, p_created_by_name, btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'ok', 'qty', p_qty,
    'returnStock', v_return, 'productionStock', v_production);
end;
$$;

revoke all on function public.transfer_return_stock_to_production(uuid, text, numeric, text, date, text, uuid, text) from public, anon, authenticated;
grant execute on function public.transfer_return_stock_to_production(uuid, text, numeric, text, date, text, uuid, text) to service_role;


-- ═══ 5. app.split_return_stock — move pre-139 returns out of the pool ═════════
--
-- For every accepted, saleable return whose `return_in` is in the production
-- ledger:
--
--   production pool:  adjustment −qty, ref 'return_split_<id>', dated p_business_date
--   return stock:     return_in  +qty, ref '<id>', on the return's own date
--
-- The production side is dated the day of the split, not the day of the return:
-- back-dating it would rewrite the closing balance of every day since, and those
-- days are closed.
--
-- IDEMPOTENT per return — both movements ride the ledgers' idempotency keys — so
-- it is safe to run again after the backend deploy to pick up any return an old
-- server accepted into the pool in between. Returns the number of returns moved
-- by THIS run.
create or replace function app.split_return_stock(p_business_date date default (now() at time zone 'Asia/Karachi')::date)
returns integer
language plpgsql
as $$
declare
  r       record;
  v_moved integer := 0;
begin
  for r in
    select pr.id, pr.product_id, pr.product_name, pr.qty, pr.branch_id, pr.reason, pr.business_date
      from production_returns pr
     where pr.status = 'accepted'
       and pr.disposition = 'saleable'
       and exists (
         select 1 from production_stock_history h
          where h.ref_id = pr.id::text and h.product_id = pr.product_id and h.type = 'return_in')
       and not exists (
         select 1 from return_stock_history rh
          where rh.ref_id = pr.id::text and rh.product_id = pr.product_id and rh.type = 'return_in')
     order by pr.business_date, pr.created_at, pr.id
  loop
    perform public.apply_production_stock_movement(
      r.product_id, r.product_name, -abs(r.qty), 'adjustment',
      'return_split_' || r.id::text, p_business_date,
      r.branch_id, null, 'migration 139',
      'Return stock separated from production stock'
    );
    perform public.apply_return_stock_movement(
      r.product_id, r.product_name, abs(r.qty), 'return_in',
      r.id::text, r.business_date,
      r.branch_id, r.id, null, 'migration 139', r.reason,
      'Moved out of production stock by migration 139'
    );
    v_moved := v_moved + 1;
  end loop;
  return v_moved;
end;
$$;

select app.split_return_stock();
