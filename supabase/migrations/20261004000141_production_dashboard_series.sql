-- 141: Production Dashboard, second design pass.
--
-- 1. production_dashboard_week (migration 140) — two changes to the heatmap, the
--    rest of the body is 140's verbatim:
--      * ten product columns, not eight (the whole top-10 the plan table lists);
--      * every branch is a row even under a branch filter. The design keeps the
--        full grid and dims the branches outside the filter, so the selected
--        branch can still be read against the others. The COLUMNS still follow
--        the filter — they are that scope's top products.
--    The function is window-generic (it takes both date ranges), so the new
--    Today / This week / This month switch needs nothing from it: the route
--    passes a different pair of windows.
--
-- 2. production_dashboard_series — the two series 140 does not carry:
--      * monthly: demand beside output for each month from p_month_from to
--        p_today (the 12-month chart). Demand follows the branch filter;
--        output is the central pool and never does.
--      * hourly: the same pair per clock hour of ONE business day, for the
--        trend chart when the period is Today, where a per-day series would be
--        a single point. Hours are Asia/Karachi wall-clock; a business day runs
--        02:00 to 02:00, so the series is ordered by the real timestamp, not by
--        the hour number. A row booked to the day long after it ended (a
--        back-dated prepare) is left out of the HOURLY series only — it would
--        otherwise stretch the axis across days; the day's totals still count it.

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
  heat_cells as (
    select branch_id, product_id, sum(qty) as qty
      from lines
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
          from top
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
                 ), '[]'::jsonb)
               ) order by b.demand desc, b.branch_id)
          from branch_week b
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


create or replace function public.production_dashboard_series(
  p_month_from date,
  p_today      date,
  p_branch_id  uuid default null
)
returns jsonb
language sql
stable
as $$
  with months as (
    select to_char(m, 'YYYY-MM') as month
      from generate_series(date_trunc('month', p_month_from::timestamp),
                           date_trunc('month', p_today::timestamp),
                           interval '1 month') m
  ),
  month_demand as (
    select to_char(o.business_date, 'YYYY-MM') as month, sum(i.qty) as qty
      from production_orders o
      join production_order_items i on i.production_order_id = o.id
     where o.business_date >= date_trunc('month', p_month_from::timestamp)::date
       and o.business_date <= p_today
       and o.status <> 'cancelled'
       and (p_branch_id is null or o.branch_id = p_branch_id)
     group by 1
  ),
  month_produced as (
    select to_char(business_date, 'YYYY-MM') as month, sum(abs(delta)) as qty
      from production_stock_history
     where type = 'prepare'
       and business_date >= date_trunc('month', p_month_from::timestamp)::date
       and business_date <= p_today
     group by 1
  ),
  hour_demand as (
    select date_trunc('hour', o.submitted_at at time zone 'Asia/Karachi') as h, sum(i.qty) as qty
      from production_orders o
      join production_order_items i on i.production_order_id = o.id
     where o.business_date = p_today
       and o.status <> 'cancelled'
       and (p_branch_id is null or o.branch_id = p_branch_id)
       and (o.submitted_at at time zone 'Asia/Karachi') >= p_today::timestamp
       and (o.submitted_at at time zone 'Asia/Karachi') <  p_today::timestamp + interval '30 hours'
     group by 1
  ),
  hour_produced as (
    select date_trunc('hour', created_at at time zone 'Asia/Karachi') as h, sum(abs(delta)) as qty
      from production_stock_history
     where type = 'prepare' and business_date = p_today
       and (created_at at time zone 'Asia/Karachi') >= p_today::timestamp
       and (created_at at time zone 'Asia/Karachi') <  p_today::timestamp + interval '30 hours'
     group by 1
  ),
  bounds as (
    select min(h) as lo, max(h) as hi
      from (select h from hour_demand union all select h from hour_produced) u
  ),
  hours as (
    select h from bounds, generate_series(bounds.lo, bounds.hi, interval '1 hour') h
     where bounds.lo is not null
  )
  select jsonb_build_object(
    'monthly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.month,
               'demand',   coalesce((select d.qty from month_demand d where d.month = m.month), 0),
               'produced', coalesce((select p.qty from month_produced p where p.month = m.month), 0)
             ) order by m.month)
        from months m
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hour', to_char(hr.h, 'YYYY-MM-DD"T"HH24:00'),
               'demand',   coalesce((select d.qty from hour_demand d where d.h = hr.h), 0),
               'produced', coalesce((select p.qty from hour_produced p where p.h = hr.h), 0)
             ) order by hr.h)
        from hours hr
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.production_dashboard_series(date, date, uuid) from public, anon, authenticated;
grant execute on function public.production_dashboard_series(date, date, uuid) to service_role;
