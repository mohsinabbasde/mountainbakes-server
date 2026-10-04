-- 140: production_dashboard_week — the week-to-date figures behind the redesigned
-- Production Dashboard (KPI cards with a change against last week, demand vs
-- production trend, order-status donut, branch comparison, production plan,
-- branch x product heatmap, recent demands).
--
-- A sibling of production_demand_overview (migration 112), not a replacement:
-- that one still feeds the Monthly Demand chart and the pending-order cards.
-- Same reason for living in SQL — GET /api/production/overview is refetched on
-- the dashboard's refresh tick, so reducing two weeks of orders in Node on every
-- call is exactly the shape 112 was written to remove.
--
-- Conventions carried over from 112: status <> 'cancelled' (a demand the branch
-- withdrew was never demand), and `qty` — what was ASKED for — as the demand
-- figure. Rejected demands stay in: they were asked for and not met.
--
-- "Delivered" is approved_qty on orders that reached 'verified' or 'approved'.
-- Stock moves at verification (see production-order.types.ts), so an order still
-- 'awaiting_verification' has been sent but nothing has been confirmed received.
--
-- p_branch_id narrows every ORDER-based figure to one branch. Two things it
-- cannot narrow: `produced` and `stock` describe the central pool, which has no
-- branch, and `branchCompare` is the chart the filter is picked FROM, so it
-- always lists every branch.
--
-- The two windows are passed in rather than derived so the route owns the
-- business-day arithmetic (02:00 Karachi rollover) the way it does for 112.

create or replace function public.production_dashboard_week(
  p_from      date,
  p_to        date,
  p_prev_from date,
  p_prev_to   date,
  p_branch_id uuid default null
)
returns jsonb
language sql
stable
as $$
  with orders as (
    select o.id, o.business_date, o.branch_id, o.branch_name, o.status,
           o.was_changed, o.submitted_at,
           (o.business_date >= p_from) as cur
      from production_orders o
     where (o.business_date between p_from and p_to
            or o.business_date between p_prev_from and p_prev_to)
       and o.status <> 'cancelled'
  ),
  lines as (
    select o.id as order_id, o.business_date, o.branch_id, o.branch_name, o.cur,
           i.product_id, i.product_name, i.qty,
           case when o.status in ('verified', 'approved')
                then coalesce(i.approved_qty, 0) else 0 end as delivered
      from orders o
      join production_order_items i on i.production_order_id = o.id
  ),
  scoped_orders as (
    select * from orders where p_branch_id is null or branch_id = p_branch_id
  ),
  scoped as (
    select * from lines where p_branch_id is null or branch_id = p_branch_id
  ),
  prepared as (
    select product_id, business_date, abs(delta) as qty,
           (business_date >= p_from) as cur
      from production_stock_history
     where type = 'prepare'
       and (business_date between p_from and p_to
            or business_date between p_prev_from and p_prev_to)
  ),
  returned as (
    select qty, (business_date >= p_from) as cur
      from production_returns
     where status = 'accepted'
       and (business_date between p_from and p_to
            or business_date between p_prev_from and p_prev_to)
       and (p_branch_id is null or branch_id = p_branch_id)
  ),
  -- Grouped by product_id alone, as 112 does: a deleted product's lines
  -- (product_id null) collapse into one entry rather than one per name snapshot.
  top as (
    select product_id, product_name, qty,
           row_number() over (order by qty desc, product_id) as rn
      from (
        select product_id, max(product_name) as product_name, sum(qty) as qty
          from scoped
         where cur
         group by product_id
      ) t
     order by qty desc, product_id
     limit 10
  ),
  branch_week as (
    select branch_id, max(branch_name) as branch_name,
           sum(qty) as demand, sum(delivered) as delivered
      from lines
     where cur
     group by branch_id
  ),
  heat_branches as (
    select branch_id, max(branch_name) as branch_name, sum(qty) as demand
      from scoped
     where cur
     group by branch_id
  ),
  heat_cells as (
    select branch_id, product_id, sum(qty) as qty
      from scoped
     where cur
     group by branch_id, product_id
  ),
  days as (
    select d::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  recent as (
    select o.id, o.submitted_at, o.branch_name, o.status, o.was_changed,
           (select count(*) from production_order_items i where i.production_order_id = o.id) as products,
           (select coalesce(sum(i.qty), 0) from production_order_items i where i.production_order_id = o.id) as units
      from scoped_orders o
     order by o.submitted_at desc
     limit 7
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'demand', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from scoped where cur),
        'prev', (select coalesce(sum(qty), 0) from scoped where not cur)),
      'delivered', jsonb_build_object(
        'cur',  (select coalesce(sum(delivered), 0) from scoped where cur),
        'prev', (select coalesce(sum(delivered), 0) from scoped where not cur)),
      'produced', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from prepared where cur),
        'prev', (select coalesce(sum(qty), 0) from prepared where not cur)),
      'openOrders', jsonb_build_object(
        'cur',  (select count(*) from scoped_orders where cur and status = 'pending'),
        'prev', (select count(*) from scoped_orders where not cur and status = 'pending')),
      'deliveredOrders', jsonb_build_object(
        'cur',  (select count(*) from scoped_orders where cur and status in ('verified', 'approved')),
        'prev', (select count(*) from scoped_orders where not cur and status in ('verified', 'approved'))),
      'returns', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from returned where cur),
        'prev', (select coalesce(sum(qty), 0) from returned where not cur))
    ),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', d.day,
               'demand',   (select coalesce(sum(s.qty), 0) from scoped s where s.business_date = d.day),
               'produced', (select coalesce(sum(p.qty), 0) from prepared p where p.business_date = d.day)
             ) order by d.day)
        from days d
    ), '[]'::jsonb),
    -- `changed` overlaps the status counts (a changed order is also verified,
    -- approved, …), so it is reported beside them, never as a share of the total.
    'orderStatus', jsonb_build_object(
      'pending',              (select count(*) from scoped_orders where cur and status = 'pending'),
      'awaitingVerification', (select count(*) from scoped_orders where cur and status = 'awaiting_verification'),
      'verified',             (select count(*) from scoped_orders where cur and status = 'verified'),
      'approved',             (select count(*) from scoped_orders where cur and status = 'approved'),
      'rejected',             (select count(*) from scoped_orders where cur and status = 'rejected'),
      'changed',              (select count(*) from scoped_orders where cur and was_changed)
    ),
    'branchCompare', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branchId', branch_id, 'branchName', branch_name,
               'demand', demand, 'delivered', delivered
             ) order by demand desc, branch_id)
        from branch_week
    ), '[]'::jsonb),
    'plan', coalesce((
      select jsonb_agg(jsonb_build_object(
               'productId', t.product_id, 'productName', t.product_name,
               'demand', t.qty,
               'produced', (select coalesce(sum(p.qty), 0) from prepared p where p.cur and p.product_id = t.product_id),
               'stock',    (select coalesce(sum(s.balance), 0) from production_stock s where s.product_id = t.product_id)
             ) order by t.rn)
        from top t
    ), '[]'::jsonb),
    'heat', jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(jsonb_build_object('productId', product_id, 'productName', product_name) order by rn)
          from top where rn <= 8
      ), '[]'::jsonb),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'branchId', b.branch_id, 'branchName', b.branch_name,
                 'values', coalesce((
                   select jsonb_agg(coalesce(c.qty, 0) order by t.rn)
                     from top t
                     left join heat_cells c
                       on c.branch_id = b.branch_id
                      and c.product_id is not distinct from t.product_id
                    where t.rn <= 8
                 ), '[]'::jsonb)
               ) order by b.demand desc, b.branch_id)
          from heat_branches b
      ), '[]'::jsonb)
    ),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', id, 'submittedAt', submitted_at, 'branchName', branch_name,
               'products', products, 'units', units,
               'status', status, 'wasChanged', was_changed
             ) order by submitted_at desc)
        from recent
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.production_dashboard_week(date, date, date, date, uuid) from public, anon, authenticated;
grant execute on function public.production_dashboard_week(date, date, date, date, uuid) to service_role;
