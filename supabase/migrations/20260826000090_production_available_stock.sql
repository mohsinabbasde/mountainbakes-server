-- 90: one definition of AVAILABLE production stock, in SQL — and the two places
-- that hand stock out both block against it.
--
-- ─── The figure ───────────────────────────────────────────────────────────────
--   balance(product)   = production_stock.balance          (Σ delta over the ledger)
--   outstanding        = demand submitted or approved, NOT yet verified
--   available          = balance − outstanding
--
-- `balance` is what the pool holds. It is NOT reduced by a branch merely asking:
-- stock leaves when the branch VERIFIES the delivery, which is when transfer_out
-- is written (migration 58). Between submission and verification the units are
-- promised but still physically on the shelf, and `outstanding` is that promise.
--
-- OUTSTANDING IS pending + awaiting_verification. The lifecycle runs
-- pending → awaiting_verification → verified → approved, and `verified` is where
-- transfer_out lands — so `verified` and `approved` claim nothing, their units
-- having already left the ledger. Counting `approved` here would double-count
-- every completed demand and permanently suppress the pool.
--
-- `available` is therefore what can still be given away — the figure the
-- Production Stock page compares against demand for its status chip, the figure
-- the counter sells against, and the figure a demand is approved against.
--
-- ─── Why both hand-out paths must block ───────────────────────────────────────
-- Without it the same units get promised twice. The pool holds 100, DHA is waiting
-- on 70, and either the counter sells 100 or Production approves another branch
-- for 80 — in both cases somebody's delivery comes up short and nothing said so at
-- the moment the decision was made, which is the only moment it could have been
-- acted on.
--
-- The check is INSIDE the transaction that does the write (see the *_checked
-- wrappers below), not a separate round trip before it. A validate-then-write pair
-- across two PostgREST calls is two transactions with a gap, and four branches
-- submitting at once is exactly the case that finds the gap.
--
-- ─── The override ─────────────────────────────────────────────────────────────
-- `p_enforce_stock => false` is the authorised override. It is a deliberate,
-- explicit act by a super_admin, and it still writes the same ledger movements —
-- it declines the guard, it does not bypass the audit trail.
-- ---------------------------------------------------------------------------

-- ═══ 1. The shared definitions ═══════════════════════════════════════════════
--
-- Functions rather than views so they can be called for one product under a lock
-- inside a write transaction, and for the whole catalogue by the stock page,
-- without two copies of the arithmetic.

/**
 * Outstanding demand for one product, optionally EXCLUDING one order.
 *
 * The exclusion is what makes the guard correct when approving. Order X's own
 * reservation is already inside `outstanding`, so checking X against a plain
 * `balance − outstanding` would make X compete with itself and refuse a demand the
 * pool can perfectly well meet.
 */
create or replace function public.production_outstanding_demand(
  p_product_id uuid,
  p_exclude_order_id uuid default null
)
returns numeric
language sql
stable
as $$
  select coalesce(sum(
           case when o.status = 'pending'
                then i.qty
                else coalesce(i.approved_qty, i.qty)
           end), 0)
    from production_order_items i
    join production_orders o on o.id = i.production_order_id
   where i.product_id = p_product_id
     and o.status in ('pending', 'awaiting_verification')
     and (p_exclude_order_id is null or o.id <> p_exclude_order_id);
$$;

revoke all on function public.production_outstanding_demand(uuid, uuid) from public, anon, authenticated;
grant execute on function public.production_outstanding_demand(uuid, uuid) to service_role;

-- Whole-catalogue form, for the stock page and the branch shortage preview.
create or replace function public.production_stock_availability()
returns table (product_id uuid, balance numeric, reserved numeric, available numeric)
language sql
stable
as $$
  with reserved as (
    select i.product_id,
           sum(case when o.status = 'pending'
                    then i.qty
                    else coalesce(i.approved_qty, i.qty) end) as qty
      from production_order_items i
      join production_orders o on o.id = i.production_order_id
     where o.status in ('pending', 'awaiting_verification')
       and i.product_id is not null
     group by i.product_id
  )
  select p.id,
         coalesce(s.balance, 0),
         coalesce(r.qty, 0),
         coalesce(s.balance, 0) - coalesce(r.qty, 0)
    from products p
    left join production_stock s on s.product_id = p.id
    left join reserved r         on r.product_id = p.id;
$$;

revoke all on function public.production_stock_availability() from public, anon, authenticated;
grant execute on function public.production_stock_availability() to service_role;


-- ═══ 2. The shortfall check ══════════════════════════════════════════════════
--
-- Returns a jsonb array of shortfalls, empty when everything fits. LOCKS every
-- pool row it inspects, in product_id order — migration 04's invariant 2, the
-- deadlock guard — so a caller that goes on to write is holding the locks already
-- and no concurrent transaction can move the figure underneath it.
--
-- p_quantities: [{"productId": uuid, "qty": numeric}]
create or replace function public.production_demand_shortfalls(
  p_quantities       jsonb,
  p_exclude_order_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_shortfalls jsonb := '[]'::jsonb;
  v_balance    numeric;
  v_available  numeric;
  r            record;
begin
  for r in
    select (i->>'productId')::uuid   as product_id,
           sum((i->>'qty')::numeric) as qty
      from jsonb_array_elements(coalesce(p_quantities, '[]'::jsonb)) as i
     where nullif(i->>'productId', '') is not null
     group by 1
     order by 1
  loop
    if r.qty is null or r.qty <= 0 then continue; end if;

    select balance into v_balance from production_stock
     where product_id = r.product_id
     for update;
    if not found then v_balance := 0; end if;

    v_available := v_balance - public.production_outstanding_demand(r.product_id, p_exclude_order_id);

    if r.qty > v_available then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', coalesce((select name from products where id = r.product_id), 'Unknown product'),
        'requested',   r.qty,
        'available',   greatest(v_available, 0),
        'shortage',    r.qty - v_available
      );
    end if;
  end loop;

  return v_shortfalls;
end;
$$;

revoke all on function public.production_demand_shortfalls(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.production_demand_shortfalls(jsonb, uuid) to service_role;


-- ═══ 3. Guarded wrappers around the existing review / verify RPCs ════════════
--
-- These CALL the existing functions rather than reimplementing them. A plpgsql
-- body is one transaction, so check-then-review is atomic, and the review logic
-- stays in exactly one place — copying those bodies here to insert a guard is how
-- the two drift apart on the next change to either.

create or replace function public.review_production_order_checked(
  p_order_id          uuid,
  p_status            branch_production_order_status,
  p_overrides         jsonb,
  p_reason            text,
  p_reviewed_by       uuid,
  p_reviewed_by_name  text,
  p_packing_overrides jsonb   default '[]'::jsonb,
  p_enforce_stock     boolean default true
)
returns jsonb
language plpgsql
as $$
declare
  v_shortfalls jsonb;
  v_wanted     jsonb;
begin
  -- Only committing to SEND hands stock out. In this workflow that is
  -- 'awaiting_verification' — review does not move stock, but it is the decision
  -- that promises it, and the decision is the moment a shortage can still be
  -- acted on. ('approved' is accepted too: it is the legacy alias the route
  -- normalises, and guarding both costs nothing.)
  --
  -- Rejecting moves nothing and must never be blocked by a shortage — refusing a
  -- demand you cannot meet is precisely what rejection is for.
  if p_enforce_stock and p_status in ('awaiting_verification', 'approved') then
    -- What this approval will commit to: the override where Production set one,
    -- the branch's own request where they did not.
    select coalesce(jsonb_agg(jsonb_build_object('productId', x.product_id, 'qty', x.qty)), '[]'::jsonb)
      into v_wanted
      from (
        select i.product_id,
               coalesce(
                 (select (o->>'approvedQty')::numeric
                    from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
                   where (o->>'productId')::uuid = i.product_id
                   limit 1),
                 i.qty) as qty
          from production_order_items i
         where i.production_order_id = p_order_id
           and i.product_id is not null
      ) x;

    v_shortfalls := public.production_demand_shortfalls(v_wanted, p_order_id);
    if jsonb_array_length(v_shortfalls) > 0 then
      return jsonb_build_object('status', 'insufficient_stock', 'shortfalls', v_shortfalls);
    end if;
  end if;

  return public.review_production_order(
    p_order_id, p_status, p_overrides, p_reason,
    p_reviewed_by, p_reviewed_by_name, p_packing_overrides
  );
end;
$$;

revoke all on function public.review_production_order_checked(uuid, branch_production_order_status, jsonb, text, uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.review_production_order_checked(uuid, branch_production_order_status, jsonb, text, uuid, text, jsonb, boolean) to service_role;


-- Verification is the moment stock actually LEAVES the pool (migration 58), so it
-- is guarded too. The branch's counted quantity is what will be booked out, and
-- p_new_items are lines that arrived undemanded — both draw on the pool.
create or replace function public.verify_production_order_checked(
  p_order_id         uuid,
  p_verified_items   jsonb,
  p_new_items        jsonb,
  p_verified_by      uuid,
  p_verified_by_name text,
  p_enforce_stock    boolean default true
)
returns jsonb
language plpgsql
as $$
declare
  v_shortfalls jsonb;
  v_wanted     jsonb;
begin
  if p_enforce_stock then
    select coalesce(jsonb_agg(jsonb_build_object('productId', product_id, 'qty', qty)), '[]'::jsonb)
      into v_wanted
      from (
        select (o->>'productId')::uuid as product_id, (o->>'verifiedQty')::numeric as qty
          from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
        union all
        select (o->>'productId')::uuid, (o->>'qty')::numeric
          from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) as o
      ) x
     where product_id is not null;

    v_shortfalls := public.production_demand_shortfalls(v_wanted, p_order_id);
    if jsonb_array_length(v_shortfalls) > 0 then
      return jsonb_build_object('status', 'insufficient_stock', 'shortfalls', v_shortfalls);
    end if;
  end if;

  return public.verify_production_order(
    p_order_id, p_verified_items, p_new_items, p_verified_by, p_verified_by_name
  );
end;
$$;

revoke all on function public.verify_production_order_checked(uuid, jsonb, jsonb, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.verify_production_order_checked(uuid, jsonb, jsonb, uuid, text, boolean) to service_role;


-- ═══ 2. commit_production_sale — block on AVAILABLE ══════════════════════════
--
-- Supersedes migration 88's day-scoped check. Identical to it apart from the
-- figure Pass 1 validates against and the balances reported back; Pass 2's ledger
-- write is unchanged from migration 35.
create or replace function public.commit_production_sale(
  p_order         jsonb,
  p_items         jsonb,
  p_branch_id     uuid,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_order_id    uuid;
  v_before      numeric;
  v_after       numeric;
  v_befores     jsonb := '{}'::jsonb;
  v_shortfalls  jsonb := '[]'::jsonb;
  v_balances    jsonb := '{}'::jsonb;
  v_inserted    integer;
  r             record;
begin
  -- ── Pass 1: lock every pool row in product_id order, then validate ─────────
  -- The lock is taken on production_stock (product_id is its primary key, and
  -- migration 04's invariant 2 orders it to avoid deadlock). Taking it BEFORE
  -- reading is what makes the check safe: a concurrent sale cannot move the
  -- balance between this read and Pass 2's write.
  --
  -- Outstanding demand is read under the same lock. It can still move — a branch
  -- can submit a demand while this transaction runs — but that direction is safe:
  -- a new reservation appearing after the check does not un-sell goods that have
  -- already left the counter, and the branch sees the shortfall on its own screen.
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    select balance into v_before from production_stock
     where product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    v_before := v_before - public.production_outstanding_demand(r.product_id, null);

    v_befores := v_befores || jsonb_build_object(r.product_id::text, v_before);

    if r.qty > v_before then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.qty,
        'available',   v_before
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Writes ────────────────────────────────────────────────────────────────
  insert into orders (
    order_number, branch_id, branch_name, customer_id, customer_name,
    customer_phone, customer_address, subtotal, discount_total, delivery_charges,
    tax_rate, tax_amount, grand_total, payment_method, status, notes,
    received_cash, cash_returned, created_by, created_by_name, business_date
  )
  select
    p_order->>'orderNumber',
    p_branch_id,
    p_order->>'branchName',
    nullif(p_order->>'customerId', '')::uuid,
    p_order->>'customerName',
    p_order->>'customerPhone',
    p_order->>'customerAddress',
    (p_order->>'subtotal')::numeric,
    coalesce((p_order->>'discountTotal')::numeric, 0),
    coalesce((p_order->>'deliveryCharges')::numeric, 0),
    coalesce((p_order->>'taxRate')::numeric, 0),
    coalesce((p_order->>'taxAmount')::numeric, 0),
    (p_order->>'grandTotal')::numeric,
    (p_order->>'paymentMethod')::payment_method,
    coalesce((p_order->>'status')::order_status, 'pending'),
    p_order->>'notes',
    nullif(p_order->>'receivedCash', '')::numeric,
    nullif(p_order->>'cashReturned', '')::numeric,
    nullif(p_order->>'createdBy', '')::uuid,
    p_order->>'createdByName',
    p_business_date
  returning id into v_order_id;

  -- Line items keep their original rows (duplicates included) and ordering.
  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    v_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'lineTotal')::numeric,
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Pass 2: apply the aggregated pool movements ────────────────────────────
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (r.product_id, r.product_name, 'sale', -r.qty, 0, v_order_id::text, p_business_date)
    on conflict (ref_id, product_id, type) do nothing;

    get diagnostics v_inserted = row_count;

    -- v_order_id is freshly generated, so a conflict here is not reachable in
    -- practice. The guard is kept so this path obeys the same rule as every
    -- other movement: no ledger row inserted means no balance change.
    if v_inserted > 0 then
      insert into production_stock (product_id, product_name, balance)
      values (r.product_id, r.product_name, -r.qty)
      on conflict (product_id) do update
         set balance = production_stock.balance - r.qty,
             product_name = coalesce(excluded.product_name, production_stock.product_name)
      returning balance into v_after;

      update production_stock_history
         set balance_after = v_after
       where ref_id = v_order_id::text and product_id = r.product_id and type = 'sale';

      -- before/after are AVAILABLE, matching what the till was shown. v_after
      -- above is the raw ledger balance and is used only for balance_after.
      v_balances := v_balances || jsonb_build_object(
        r.product_id::text,
        jsonb_build_object(
          'productName', r.product_name,
          'before',      (v_befores->>r.product_id::text)::numeric,
          'after',       (v_befores->>r.product_id::text)::numeric - r.qty
        )
      );
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'orderId', v_order_id, 'balances', v_balances);
end;
$$;

revoke all on function public.commit_production_sale(jsonb, jsonb, uuid, date) from public, anon, authenticated;
grant execute on function public.commit_production_sale(jsonb, jsonb, uuid, date) to service_role;
