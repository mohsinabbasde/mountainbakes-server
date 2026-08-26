-- 89: make the production ledger a full audit trail, and give production order
-- lines a rate snapshot.
--
-- Three additive changes. Nothing is dropped, no data is moved, and every
-- existing call site keeps working untouched.
--
--   1. production_stock_history becomes a full audit trail. It was already the
--      movement ledger — unique id, typed movement, signed delta, business_date,
--      idempotency key — but it could not answer "who did this, for which branch,
--      against which order, and why", which is exactly what a stock audit trail is
--      for. It also gains a HUMAN-READABLE transaction number.
--
--   2. apply_production_stock_movement takes those four as DEFAULTED parameters,
--      so the 6-argument call from any older deploy still resolves while the
--      current server passes the audit fields.
--
--   3. production_order_items gains unit_price — the rate SNAPSHOT taken when the
--      branch submits. Production orders had no price column at all, so an order's
--      value could only ever be recomputed from today's price list, which silently
--      rewrites what a branch was billed every time Admin changes a rate. The
--      snapshot is what makes a historical order stay worth what it was worth.
--
-- Backfill uses product_price_history to recover the rate that was ACTIVE on each
-- order's own business_date — not today's price. Where no history row covers the
-- date (a product whose price never changed) it falls back to products.price,
-- which for those products IS the rate that was in force.
-- ---------------------------------------------------------------------------

-- ═══ 1. Ledger audit columns ══════════════════════════════════════════════════
alter table production_stock_history
  add column if not exists branch_id           uuid references branches (id) on delete set null,
  add column if not exists production_order_id uuid references production_orders (id) on delete set null,
  add column if not exists created_by          uuid references users (id) on delete set null,
  add column if not exists created_by_name     text,
  add column if not exists reason              text,
  add column if not exists remarks             text,
  add column if not exists transaction_no      text,
  add column if not exists metadata            jsonb;

comment on column production_stock_history.branch_id is
  'Which branch the movement was FOR: the receiving branch on a transfer_out, the returning branch on a return_in. NULL on prepare/sale/adjustment, which are pool-level and belong to no branch.';
comment on column production_stock_history.reason is
  'Required on adjustment (enforced in apply_production_stock_adjustment). Free text on everything else.';
comment on column production_stock_history.transaction_no is
  'Human-readable ledger reference, STK-YYYYMMDD-NNNNNN. What someone quotes on a query. The uuid id stays the key.';


-- ── Transaction numbers ─────────────────────────────────────────────────────
-- One global sequence rather than per-day: a per-day counter needs a lock or an
-- upsert on a counters table on EVERY movement, and the sequence gives the same
-- readable shape with no contention. The date in the string comes from the
-- movement's own business_date, so the number still sorts and reads by day; only
-- the suffix is global, which nobody reads as "the Nth movement of the day".
--
-- Sequences are exempt from transaction rollback BY DESIGN, so a rolled-back
-- movement burns a number. That is correct for an audit trail: a gap is evidence
-- that something was attempted, and reusing numbers would let two different
-- movements share one reference.
create sequence if not exists production_stock_txn_seq;

create or replace function app.next_production_stock_txn_no(p_business_date date)
returns text
language sql
volatile
as $fn$
  select 'STK-' || to_char(coalesce(p_business_date, current_date), 'YYYYMMDD')
      || '-' || lpad(nextval('production_stock_txn_seq')::text, 6, '0');
$fn$;

-- Stamped by trigger rather than by each caller: there are six write paths into
-- this table (prepare, transfer_out, return_in, sale, adjustment, correction) and
-- one of them forgetting would leave an un-quotable row in an audit trail.
create or replace function app.stamp_production_stock_txn_no()
returns trigger
language plpgsql
as $fn$
begin
  if new.transaction_no is null then
    new.transaction_no := app.next_production_stock_txn_no(new.business_date);
  end if;
  return new;
end;
$fn$;

drop trigger if exists production_stock_history_txn_no on production_stock_history;
create trigger production_stock_history_txn_no
  before insert on production_stock_history
  for each row execute function app.stamp_production_stock_txn_no();

-- Backfill in ledger order so the existing history reads chronologically.
-- Idempotent: only NULL rows are touched.
update production_stock_history h
   set transaction_no = app.next_production_stock_txn_no(h.business_date)
  from (
    select id from production_stock_history
     where transaction_no is null
     order by business_date, created_at, id
  ) ordered
 where h.id = ordered.id;

create unique index if not exists production_stock_history_txn_no_key
  on production_stock_history (transaction_no);

-- The ledger view filters by branch and pages by recency; without this the
-- Stock Movement History screen table-scans the whole ledger on every filter.
create index if not exists production_stock_history_branch_idx
  on production_stock_history (branch_id, business_date desc);
create index if not exists production_stock_history_recent_idx
  on production_stock_history (business_date desc, created_at desc);
create index if not exists production_stock_history_order_idx
  on production_stock_history (production_order_id);
create index if not exists production_stock_history_type_idx
  on production_stock_history (type, business_date desc);
-- `opening` is Σ delta strictly BEFORE a date, per product — the single hottest
-- read on the stock page, and a plain (business_date, product_id) index cannot
-- serve it as an index-only scan without delta on the leaf.
create index if not exists production_stock_history_opening_idx
  on production_stock_history (product_id, business_date) include (delta);


-- ═══ 2. apply_production_stock_movement — carry the audit fields ══════════════
--
-- Dropped and recreated rather than `create or replace`d: adding parameters
-- changes the signature, and replace cannot. The new ones are DEFAULTED, so the
-- old 6-argument call still binds to this same function.
--
-- Body is otherwise byte-identical to migration 15 — same idempotency reservation,
-- same relative balance write, same balance_after backfill.
drop function if exists public.apply_production_stock_movement(uuid, text, numeric, production_stock_movement_type, text, date);

create or replace function public.apply_production_stock_movement(
  p_product_id      uuid,
  p_product_name    text,
  p_delta           numeric,
  p_type            production_stock_movement_type,
  p_ref_id          text,
  p_business_date   date,
  p_branch_id           uuid default null,
  p_created_by          uuid default null,
  p_created_by_name     text default null,
  p_reason              text default null,
  p_production_order_id uuid default null,
  p_remarks             text default null
)
returns numeric
language plpgsql
as $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first; balance_after is backfilled below.
  insert into production_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    branch_id, created_by, created_by_name, reason, production_order_id, remarks
  )
  values (
    p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date,
    p_branch_id, p_created_by, p_created_by_name, p_reason, p_production_order_id, p_remarks
  )
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from production_stock where product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  insert into production_stock (product_id, product_name, balance)
  values (p_product_id, p_product_name, p_delta)
  on conflict (product_id) do update
     set balance = production_stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, production_stock.product_name)
  returning balance into v_balance;

  update production_stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;

revoke all on function public.apply_production_stock_movement(uuid, text, numeric, production_stock_movement_type, text, date, uuid, uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_production_stock_movement(uuid, text, numeric, production_stock_movement_type, text, date, uuid, uuid, text, text, uuid, text) to service_role;


-- ═══ 3. apply_production_stock_adjustment — the audited manual correction ══════
--
-- The pool already had an 'adjustment' movement type, but the ONLY way to book one
-- was through a Help Desk ticket. Production needs to record damage, expiry and
-- count corrections directly, and every one of them must carry a reason.
--
-- This is NOT "edit the balance". The caller states a signed QUANTITY and a
-- reason; the function appends one movement and moves the running balance by it.
-- There is no path here that assigns a balance.
--
-- Returns the pre- and post-movement balance so the caller can report the change
-- honestly rather than echoing back what was typed.
create or replace function public.apply_production_stock_adjustment(
  p_product_id      uuid,
  p_product_name    text,
  p_delta           numeric,      -- SIGNED. Positive = ADJUSTMENT_IN, negative = ADJUSTMENT_OUT.
  p_reason          text,         -- required
  p_ref_id          text,
  p_business_date   date,
  p_created_by      uuid    default null,
  p_created_by_name text    default null,
  p_remarks         text    default null,
  p_metadata        jsonb   default null
)
returns jsonb
language plpgsql
as $$
declare
  v_before   numeric;
  v_after    numeric;
  v_inserted integer;
begin
  if p_delta is null or p_delta = 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'Adjustment quantity must not be zero.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'invalid', 'error', 'A reason is required for every stock adjustment.');
  end if;

  -- Lock the pool row so the before/after pair reported to the audit trail is the
  -- one this movement actually spanned, not a figure a concurrent sale moved
  -- underneath us.
  select balance into v_before from production_stock
   where product_id = p_product_id
   for update;
  if not found then v_before := 0; end if;

  insert into production_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    created_by, created_by_name, reason, remarks, metadata
  )
  values (
    p_product_id, p_product_name, 'adjustment', p_delta, 0, p_ref_id, p_business_date,
    p_created_by, p_created_by_name, btrim(p_reason), p_remarks, p_metadata
  )
  on conflict (ref_id, product_id, type) do nothing;

  -- Same rule as every other movement: no ledger row inserted means no balance
  -- change. GET DIAGNOSTICS rather than FOUND, matching migration 15 — a retry
  -- reusing the ref_id must be a true no-op, not a second adjustment.
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('status', 'duplicate', 'before', v_before, 'after', v_before);
  end if;

  insert into production_stock (product_id, product_name, balance)
  values (p_product_id, p_product_name, p_delta)
  on conflict (product_id) do update
     set balance = production_stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, production_stock.product_name)
  returning balance into v_after;

  update production_stock_history
     set balance_after = v_after
   where ref_id = p_ref_id and product_id = p_product_id and type = 'adjustment';

  return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_after, 'delta', p_delta);
end;
$$;

revoke all on function public.apply_production_stock_adjustment(uuid, text, numeric, text, text, date, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_production_stock_adjustment(uuid, text, numeric, text, text, date, uuid, text, text, jsonb) to service_role;


-- ═══ 4. production_order_items.unit_price — the rate snapshot ═════════════════
alter table production_order_items
  add column if not exists unit_price numeric(14,2);

comment on column production_order_items.unit_price is
  'The Admin product price AS AT submission. Snapshotted server-side; never accepted from a client. A later price change must not move this figure — the order stays worth what it was worth.';

-- Backfill: the price that was ACTIVE on the order''s own business_date, falling
-- back to the current price only where no history row covers that date (a product
-- whose rate has never changed, for which today''s price IS the historical one).
--
-- Idempotent: only NULL rows are touched, so re-running changes nothing.
update production_order_items i
   set unit_price = coalesce(
         (select h.new_price
            from product_price_history h
           where h.product_id = i.product_id
             and h.status in ('active', 'superseded')
             and h.effective_date <= o.business_date
           order by h.effective_date desc, h.version_number desc
           limit 1),
         (select p.price from products p where p.id = i.product_id),
         0)
  from production_orders o
 where o.id = i.production_order_id
   and i.unit_price is null;
