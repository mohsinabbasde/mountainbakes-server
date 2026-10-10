-- 143: Special Orders become their own workflow, separate from Demand.
--
-- Requires migration 142 ('special_order_verification') already committed.
--
-- ─── What changes ─────────────────────────────────────────────────────────────
-- Migration 69 modelled a special item as an ORDINARY `production_order_items`
-- line on a normal demand, against a hidden `is_special` product. That made a
-- special item a demand line in every sense: it reserved pool stock, it was
-- blocked by the shortage check until somebody separately booked "prepared"
-- stock for it, it was transferred out to the branch at verification, and it
-- was counted by every demand report.
--
-- The rule now is the opposite: a Special Order is NOT demand. It goes
--
--   branch raises it → Production prepares it → branch verifies it WITH A PHOTO
--   → Production/Admin approves it → the ordered quantity is added to
--   Production Stock, ONCE, by that approval.
--
-- ─── Why new tables rather than `order_type` on production_orders ─────────────
-- `production_orders` / `production_order_items` are read by 13 server modules
-- and 27 migrations' worth of SQL (outstanding-demand reservation, the shortage
-- guard, the counter-sale availability check, previous-balance billing, the
-- finance and production dashboards, closing reports, the restriction rules…).
-- Every one of them means "normal demand" by those tables. A special order
-- stored there is normal demand to all of them unless each is taught to filter
-- it out — and the first one missed is a special order silently reserving stock
-- or appearing in a demand total.
--
-- Stored in its own tables, a special order cannot be normal demand: nothing
-- that reads demand can see it, and nothing about demand had to change. What IS
-- reused is everything that is genuinely shared: the status enum, the hidden
-- `is_special` product (so Production Stock can carry it), the attachments
-- table, the counters allocator, and the one ledger write path
-- (`apply_production_stock_movement`).
--
-- ─── Status: the existing enum, not a second one ──────────────────────────────
--   pending               sent to Production — waiting for preparation
--   awaiting_verification Production prepared it — waiting for the branch
--   verified              branch verified it and attached its photo
--   approved              approved — AND the quantity is in Production Stock
--
-- 'approved' and "stock added" are one state on purpose. They are written by the
-- same statement in the same transaction, so there is no moment where an order
-- is approved with no stock or has stock without being approved.
-- ---------------------------------------------------------------------------

-- ═══ 1. SO-###### numbers — the existing counters allocator (migration 24) ════
insert into counters (id, count) values ('special_order', 0)
  on conflict (id) do nothing;

create or replace function next_special_order_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'special_order' returning count into next_count;
    if not found then raise exception 'counters row "special_order" is missing'; end if;
    return 'SO-' || lpad(next_count::text, 6, '0');
  end;
  $$;


-- ═══ 2. Tables ════════════════════════════════════════════════════════════════
create table if not exists special_orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique default next_special_order_number(),
  branch_id         uuid not null references branches (id) on delete restrict,
  branch_name       text,
  business_date     date not null,
  -- The day the branch needs it by. Optional: the mobile form does not ask.
  required_date     date,
  status            branch_production_order_status not null default 'pending',
  -- The audit trail. Each step stamps who and when, and is never rewritten.
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  submitted_at      timestamptz not null default now(),
  prepared_by       uuid references users (id) on delete set null,
  prepared_by_name  text,
  prepared_at       timestamptz,
  verified_by       uuid references users (id) on delete set null,
  verified_by_name  text,
  verified_at       timestamptz,
  approved_by       uuid references users (id) on delete set null,
  approved_by_name  text,
  approved_at       timestamptz,
  -- Set by approve_special_order in the same statement as status = 'approved'.
  stock_added_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists special_orders_branch_date_idx on special_orders (branch_id, business_date desc);
create index if not exists special_orders_status_idx      on special_orders (status, business_date desc);

drop trigger if exists special_orders_touch on special_orders;
create trigger special_orders_touch before update on special_orders
  for each row execute function app.touch_updated_at();

create table if not exists special_order_items (
  id                   uuid primary key default gen_random_uuid(),
  special_order_id     uuid not null references special_orders (id) on delete cascade,
  -- The hidden `is_special` product that carries this item in Production Stock.
  product_id           uuid not null references products (id) on delete restrict,
  item_name            text not null,
  qty                  numeric(14,3) not null check (qty > 0),
  -- THE AGREED AMOUNT FOR THIS ROW — the whole row, not a unit rate. It is what
  -- the branch typed, stored as typed, and nothing multiplies it by qty. It is
  -- never read from or written to products.price / the price list, and it plays
  -- no part in any stock figure.
  amount               numeric(14,2) not null check (amount >= 0),
  description          text not null default '',
  line_no              integer not null,
  -- The ONE stock movement this item produced, stamped at approval. NULL until
  -- then; NOT NULL after, which is the traceability link in both directions.
  stock_movement_id    uuid references production_stock_history (id) on delete set null,
  stock_transaction_no text,
  constraint special_order_items_line_key unique (special_order_id, line_no)
);

comment on column special_order_items.amount is
  'Agreed amount for the whole row as entered by the branch. Not a unit price, not from the price list, never used in stock arithmetic.';

alter table special_orders      enable row level security;
alter table special_order_items enable row level security;

drop policy if exists special_orders_select_branch on special_orders;
create policy special_orders_select_branch on special_orders
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

drop policy if exists special_order_items_select_branch on special_order_items;
create policy special_order_items_select_branch on special_order_items
  for select to authenticated
  using (
    exists (
      select 1 from special_orders o
      where o.id = special_order_items.special_order_id
        and (app.is_super_admin() or o.branch_id = app.jwt_branch_id())
    )
  );


-- ═══ 3. The server-side safeguard: a special item is never a demand line ══════
--
-- Enforced in the database, not only in the route. Rows that already exist are
-- untouched (and keep flowing through the demand workflow they were raised in);
-- what is refused is a NEW demand line flagged special, from any caller.
create or replace function app.refuse_special_demand_line()
returns trigger
language plpgsql
as $fn$
begin
  if new.is_special then
    raise exception 'A Special Order is not a demand line. Create it through special_orders.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists production_order_items_no_special on production_order_items;
create trigger production_order_items_no_special
  before insert on production_order_items
  for each row execute function app.refuse_special_demand_line();


-- ═══ 4. create_special_order ══════════════════════════════════════════════════
--
-- One transaction: the order, its items, and any hidden product an item needs.
-- Validation is repeated here (the route's schema runs first) so a caller that
-- bypasses the schema still cannot store a row with no name, no quantity or no
-- amount.
--
-- p_items: [{"name": text, "qty": numeric, "amount": numeric, "description": text}]
create or replace function public.create_special_order(
  p_branch_id       uuid,
  p_branch_name     text,
  p_business_date   date,
  p_created_by      uuid,
  p_created_by_name text,
  p_items           jsonb,
  p_required_date   date default null
)
returns jsonb
language plpgsql
as $$
declare
  v_id      uuid;
  v_number  text;
  v_name    text;
  v_qty     numeric;
  v_amount  numeric;
  v_product uuid;
  v_item_id uuid;
  v_items   jsonb := '[]'::jsonb;
  r         record;
begin
  if p_branch_id is null then
    return jsonb_build_object('status', 'invalid', 'error', 'No branch assigned to this account');
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'A Special Order needs at least one item.');
  end if;

  -- Validate every row before writing any.
  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) loop
    if btrim(coalesce(r.o->>'name', '')) = '' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the item name.');
    end if;
    if jsonb_typeof(r.o->'qty') is distinct from 'number' or (r.o->>'qty')::numeric <= 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter quantity.');
    end if;
    if jsonb_typeof(r.o->'amount') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the Special Order amount.');
    end if;
    if (r.o->>'amount')::numeric < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'The Special Order amount cannot be negative.');
    end if;
  end loop;

  insert into special_orders (branch_id, branch_name, business_date, required_date, status, created_by, created_by_name)
  values (p_branch_id, p_branch_name, p_business_date, p_required_date, 'pending', p_created_by, p_created_by_name)
  returning id, order_number into v_id, v_number;

  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) order by ord loop
    v_name   := btrim(r.o->>'name');
    v_qty    := (r.o->>'qty')::numeric;
    v_amount := (r.o->>'amount')::numeric;

    -- Find-or-create the hidden product (migration 69's partial unique index on
    -- the normalised name decides a concurrent race). Price 0 and it stays 0:
    -- the amount lives on the special order item, never on the product.
    insert into products (name, price, is_active, is_special)
    values (v_name, 0, true, true)
    on conflict (lower(trim(name))) where is_special do nothing;

    select id into v_product from products
     where is_special and lower(trim(name)) = lower(v_name);

    insert into special_order_items (special_order_id, product_id, item_name, qty, amount, description, line_no)
    values (v_id, v_product, v_name, v_qty, v_amount, btrim(coalesce(r.o->>'description', '')), r.ord::integer)
    returning id into v_item_id;

    v_items := v_items || jsonb_build_object('id', v_item_id, 'lineNo', r.ord::integer);
  end loop;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'orderNumber', v_number, 'items', v_items);
end;
$$;


-- ═══ 5. prepare_special_order — Production marks it prepared ══════════════════
-- Check-and-set, like every other step. Moves NO stock.
create or replace function public.prepare_special_order(
  p_order_id uuid,
  p_by       uuid,
  p_by_name  text
)
returns jsonb
language plpgsql
as $$
declare
  v_branch uuid;
  v_number text;
  v_status branch_production_order_status;
begin
  update special_orders
     set status = 'awaiting_verification', prepared_by = p_by, prepared_by_name = p_by_name, prepared_at = now()
   where id = p_order_id and status = 'pending'
  returning branch_id, order_number into v_branch, v_number;

  if not found then
    select status into v_status from special_orders where id = p_order_id;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  return jsonb_build_object('status', 'ok', 'branchId', v_branch, 'orderNumber', v_number);
end;
$$;


-- ═══ 6. verify_special_order — the branch confirms, with its photo ════════════
-- The branch is checked HERE as well as in the route, and so is the photo: an
-- order cannot reach 'verified' — and therefore cannot be approved — without a
-- verification photo bound to it. Moves NO stock.
create or replace function public.verify_special_order(
  p_order_id  uuid,
  p_branch_id uuid,
  p_by        uuid,
  p_by_name   text
)
returns jsonb
language plpgsql
as $$
declare
  v_branch uuid;
  v_number text;
  v_status branch_production_order_status;
begin
  select branch_id, status, order_number into v_branch, v_status, v_number
    from special_orders where id = p_order_id
     for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_branch_id is null or v_branch <> p_branch_id then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_status <> 'awaiting_verification' then
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;
  if not exists (
    select 1 from attachments
     where entity = 'special_order_verification' and entity_id = p_order_id
  ) then
    return jsonb_build_object('status', 'photo_required');
  end if;

  update special_orders
     set status = 'verified', verified_by = p_by, verified_by_name = p_by_name, verified_at = now()
   where id = p_order_id;

  return jsonb_build_object('status', 'ok', 'branchId', v_branch, 'orderNumber', v_number);
end;
$$;


-- ═══ 7. approve_special_order — THE stock addition ════════════════════════════
--
-- The only place a Special Order touches stock, and it does it exactly once.
--
--   · Check-and-set on status = 'verified'. A second call (a retry, a double
--     click, two approvers) matches no row and returns 'invalid_status' without
--     reaching the ledger.
--   · The status change and every ledger write are ONE transaction (a plpgsql
--     body). Either the order is approved and its stock is in the pool, or
--     neither happened.
--   · Each item writes through apply_production_stock_movement — the same path
--     as every other pool movement — as a 'prepare' of exactly `qty`, keyed
--     `<SO number>/<line>`. The ledger's UNIQUE (ref_id, product_id, type) makes
--     that key a second, independent guard: even a caller that somehow got past
--     the status check could not book the same line twice.
--
-- 'prepare' rather than a new movement type, deliberately. The stock page, the
-- availability figure, the correction RPC and the dashboards all fold the ledger
-- by type; a type they do not know would be in tomorrow's opening balance but in
-- none of today's columns. A special order approved IS product prepared, and as
-- a 'prepare' it lands in "Prepared today" with no reader needing to change. The
-- SOURCE is carried where the ledger already carries sources: ref_id, reason,
-- remarks, branch_id and metadata.
--
-- `amount` is not read here at all.
create or replace function public.approve_special_order(
  p_order_id      uuid,
  p_by            uuid,
  p_by_name       text,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_ref         text;
  v_move_id     uuid;
  v_txn         text;
  v_moves       jsonb := '[]'::jsonb;
  r             record;
begin
  update special_orders
     set status = 'approved', approved_by = p_by, approved_by_name = p_by_name,
         approved_at = now(), stock_added_at = now()
   where id = p_order_id and status = 'verified'
  returning branch_id, branch_name, order_number into v_branch, v_branch_name, v_number;

  if not found then
    select status into v_status from special_orders where id = p_order_id;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  -- product_id order: migration 04's lock-ordering invariant for pool rows.
  for r in
    select id, product_id, item_name, qty, line_no
      from special_order_items
     where special_order_id = p_order_id
     order by product_id, line_no
  loop
    v_ref := v_number || '/' || r.line_no;

    perform public.apply_production_stock_movement(
      p_product_id      => r.product_id,
      p_product_name    => r.item_name,
      p_delta           => r.qty,
      p_type            => 'prepare',
      p_ref_id          => v_ref,
      p_business_date   => p_business_date,
      p_branch_id       => v_branch,
      p_created_by      => p_by,
      p_created_by_name => p_by_name,
      p_reason          => 'Special Order ' || v_number,
      p_remarks         => 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '')
    );

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'source',             'special_order',
             'specialOrderId',     p_order_id,
             'specialOrderNumber', v_number,
             'specialOrderItemId', r.id)
     where ref_id = v_ref and product_id = r.product_id and type = 'prepare'
    returning id, transaction_no into v_move_id, v_txn;

    update special_order_items
       set stock_movement_id = v_move_id, stock_transaction_no = v_txn
     where id = r.id;

    v_moves := v_moves || jsonb_build_object(
      'itemId', r.id, 'productId', r.product_id, 'itemName', r.item_name,
      'qty', r.qty, 'stockMovementId', v_move_id, 'stockTransactionNo', v_txn);
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch, 'orderNumber', v_number, 'movements', v_moves);
end;
$$;


revoke all on function public.create_special_order(uuid, text, date, uuid, text, jsonb, date)  from public, anon, authenticated;
revoke all on function public.prepare_special_order(uuid, uuid, text)                    from public, anon, authenticated;
revoke all on function public.verify_special_order(uuid, uuid, uuid, text)               from public, anon, authenticated;
revoke all on function public.approve_special_order(uuid, uuid, text, date)              from public, anon, authenticated;
grant execute on function public.create_special_order(uuid, text, date, uuid, text, jsonb, date) to service_role;
grant execute on function public.prepare_special_order(uuid, uuid, text)                   to service_role;
grant execute on function public.verify_special_order(uuid, uuid, uuid, text)              to service_role;
grant execute on function public.approve_special_order(uuid, uuid, text, date)             to service_role;
