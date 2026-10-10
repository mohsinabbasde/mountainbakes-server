-- 35: commit_production_sale — the Production dashboard's counter sale.
--
-- The branch-agnostic sibling of commit_sale (migration 12). A production user
-- sells straight out of the central pool: the order row is attributed to a branch
-- the user picks (orders.branch_id is NOT NULL, and branch attribution is what
-- makes the sale show up in that branch's revenue reports), but the units come
-- out of `production_stock` — branch `stock` is deliberately NOT touched.
--
-- p_order / p_items have exactly the same shape as commit_sale, and the return
-- shape is identical too, so the API and the client share one code path:
--   {"status":"ok","orderId":uuid,"balances":{<productId>:{productName,before,after}}}
--   {"status":"insufficient","shortfalls":[{productId,productName,requested,available}]}
--
-- Duplicate product lines are preserved verbatim in order_items but AGGREGATED
-- for stock purposes — one balance write and one ledger row per product, which is
-- what the (ref_id, product_id, type) idempotency key requires.
--
-- ── Why this one BLOCKS on shortfall ────────────────────────────────────────
-- apply_production_stock_movement (migration 15) lets the pool go negative on
-- purpose: a prepare/transfer/return is a record of something that already
-- physically happened, so refusing it would just lose the record. A sale is the
-- opposite — it is a decision made at the counter, and the counter can be told
-- "there are only 3 left". So this function follows commit_sale instead: Pass 1
-- takes `for update` locks in product_id order (the deadlock guard from migration
-- 04, invariant 2) and returns the shortfalls before ANY write, leaving nothing
-- persisted.
-- ---------------------------------------------------------------------------
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
  -- production_stock is keyed by product_id alone (no branch_id), so the lock is
  -- a single-column lookup on the primary key.
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

      v_balances := v_balances || jsonb_build_object(
        r.product_id::text,
        jsonb_build_object(
          'productName', r.product_name,
          'before',      (v_befores->>r.product_id::text)::numeric,
          'after',       v_after
        )
      );
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'orderId', v_order_id, 'balances', v_balances);
end;
$$;

-- Lock down, for the same reason as migration 12: Postgres grants EXECUTE to
-- PUBLIC by default and anon/authenticated inherit it — without this,
-- commit_production_sale would be a callable Data API endpoint able to write
-- orders and move the pool.
revoke all on function public.commit_production_sale(jsonb, jsonb, uuid, date) from public, anon, authenticated;
grant execute on function public.commit_production_sale(jsonb, jsonb, uuid, date) to service_role;
