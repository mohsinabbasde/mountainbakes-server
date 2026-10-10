-- 112: production_demand_overview — SQL aggregate replacing five Node reduction
-- loops in GET /api/production/overview (production.routes.ts). That endpoint
-- pulls every non-cancelled production_orders row (with embedded items) in a
-- 180-day window and reduces it in Node on EVERY call — and the Production
-- Dashboard sits under the same 1-second refresh tick as the Branch Dashboard
-- (useAppRefresh.tsx), so the full scan-and-reduce was re-running roughly once
-- a second while the screen was open. Same shape of problem GET
-- /api/reports/summary had (fixed in commit bc7ce2f) — except every field this
-- endpoint computes IS rendered by ProductionDashboard.tsx, so there is no
-- unused-field shortcut available; the aggregation itself has to move into
-- Postgres instead.
--
-- Mirrors production.routes.ts's Node logic field-for-field, same window
-- (business_date >= p_demand_from), same status <> 'cancelled' exclusion, same
-- `qty` column (not approved_qty — a pending/undecided demand's figure is what
-- was ASKED for). `order_qty` sums each order's items exactly once BEFORE any
-- further grouping, so joining orders to items can never multiply an order's
-- count the way a naive GROUP BY over a raw join would.

create or replace function public.production_demand_overview(
  p_demand_from date,
  p_day_from date,
  p_last7 date
)
returns jsonb
language sql
stable
as $$
  with order_qty as (
    -- One row per order in the window; itemsQty() in production.routes.ts
    -- summed item.qty per order the same way.
    select
      o.id, o.business_date, o.branch_id, o.branch_name, o.status, o.was_changed,
      coalesce((
        select sum(i.qty) from production_order_items i where i.production_order_id = o.id
      ), 0) as qty
    from production_orders o
    where o.business_date >= p_demand_from
      and o.status <> 'cancelled'
  ),
  -- topProducts groups by product_id alone, same as productMap[it.product_id]
  -- in production.routes.ts — a deleted product's items (product_id null) all
  -- collapse into one entry, never one entry per distinct name snapshot.
  product_qty as (
    select i.product_id, max(i.product_name) as product_name, sum(i.qty) as qty
      from production_order_items i
      join order_qty oq on oq.id = i.production_order_id
     group by i.product_id
  ),
  by_day as (
    select business_date, sum(qty) as qty, count(*) as orders
      from order_qty
     where business_date >= p_day_from
     group by business_date
  ),
  by_month as (
    select left(business_date::text, 7) as month, sum(qty) as qty
      from order_qty
     group by left(business_date::text, 7)
     order by month desc
     limit 6
  ),
  -- branch_id is NOT NULL on production_orders, so this always collapses to one
  -- row per branch — matches branchMap[o.branch_id] exactly.
  by_branch as (
    select branch_id, max(branch_name) as branch_name, sum(qty) as qty
      from order_qty
     group by branch_id
  ),
  top_products as (
    select product_id, product_name, qty
      from product_qty
     order by qty desc, product_id
     limit 10
  )
  select jsonb_build_object(
    'waitingOrders',  (select count(*) from order_qty where status = 'pending'),
    'totalDemandQty', (select coalesce(sum(qty), 0) from order_qty where status = 'pending'),
    'approvedOrders', (select count(*) from order_qty where status = 'approved' and business_date >= p_last7),
    'changedOrders',  (select count(*) from order_qty where status = 'approved' and business_date >= p_last7 and was_changed),
    'demandByDay',    coalesce((
                         select jsonb_agg(jsonb_build_object('date', business_date, 'qty', qty, 'orders', orders) order by business_date)
                         from by_day
                       ), '[]'::jsonb),
    'demandByMonth',  coalesce((
                         select jsonb_agg(jsonb_build_object('month', month, 'qty', qty) order by month)
                         from by_month
                       ), '[]'::jsonb),
    'branchDemand',   coalesce((
                         select jsonb_agg(jsonb_build_object('branchId', branch_id, 'branchName', branch_name, 'qty', qty) order by qty desc)
                         from by_branch
                       ), '[]'::jsonb),
    'topProducts',    coalesce((
                         select jsonb_agg(jsonb_build_object('productId', product_id, 'productName', product_name, 'qty', qty) order by qty desc)
                         from top_products
                       ), '[]'::jsonb)
  );
$$;

revoke all on function public.production_demand_overview(date, date, date) from public, anon, authenticated;
grant execute on function public.production_demand_overview(date, date, date) to service_role;
