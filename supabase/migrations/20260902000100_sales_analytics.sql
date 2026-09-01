-- 100: Daily Sales analytics — one round trip, aggregated in Postgres.
--
-- ─── Why this exists ─────────────────────────────────────────────────────────
-- `/api/reports/summary` selects every order in range WITH its line items and
-- group-bys them in Node. That is a faithful port of the legacy behaviour and
-- reports.routes.ts says so, but it is the wrong shape for a dashboard card that
-- redraws on every date-range change: a month of orders across four branches is
-- thousands of rows and their items pulled over the wire to produce ~30 points.
--
-- This function does the grouping where the rows already are and returns only
-- what the graph draws. One call, one plan, one payload.
--
-- ─── The figures, and why each is what it is ─────────────────────────────────
-- Grouped on the STORED `business_date`, never recomputed from `created_at`.
-- The write path stamps the business day at 2 AM-rollover time (migration 03);
-- deriving it again here would disagree with what was stored for a sale rung up
-- either side of the boundary.
--
-- `cancelled` orders are excluded everywhere: they took no money and moved no
-- goods.
--
-- A `staff` sale (migration 36) is exempt from payment — the goods left the
-- counter and nothing came in. It is excluded from every MONEY figure and from
-- the transaction count, and reported separately as `staffTotal` so the parts
-- still sum to the whole. The payment-method breakdown is over PAID orders only
-- for exactly that reason: a breakdown that included staff would not add up to
-- the Total Sales printed above it, and a card whose rows do not sum to its own
-- header is worse than one that omits a row.
--
-- ─── The day series is dense ─────────────────────────────────────────────────
-- `generate_series` fills every date in range, so a day with no sales is a zero
-- and not a gap. A line drawn through absent days silently connects Monday to
-- Thursday and reads as three days of steady trade. The CALLER clamps `p_to` to
-- the current business date — a range that runs to month end would otherwise
-- trail a fortnight of zeros nobody has had the chance to sell in yet, and drag
-- the average down with them.
--
-- ─── Branch scope is decided by the caller, from the JWT ─────────────────────
-- `p_branch_id` null means every branch. The route passes the authenticated
-- user's own branch for a branch role and NEVER the query parameter; see
-- sales-analytics.routes.ts. This function trusts what it is given, exactly as
-- every other service_role function here does.
-- ---------------------------------------------------------------------------

-- ─── Indexes ─────────────────────────────────────────────────────────────────
--
-- One branch over a date range is the common read — every branch dashboard, and
-- an admin who has picked a shop — and INCLUDE makes it an index-only scan: the
-- four payload columns ride in the leaf, so the aggregate never visits the heap.
-- The existing `orders_business_date_idx (business_date, branch_id)` is what the
-- consolidated "all branches" path uses, leading with exactly the column that
-- read ranges over. Both directions are covered without a third index.
create index if not exists orders_branch_business_date_idx
  on orders (branch_id, business_date)
  include (status, payment_method, grand_total, discount_total);

-- The staff/paid split and the payment-method rollup both narrow on
-- `payment_method`, and nothing else in the schema leads with it. It is a
-- five-value enum, so this will not be chosen for a branch-and-date read — the
-- covering index above wins that — but it is what the consolidated rollup uses.
create index if not exists orders_payment_method_idx
  on orders (payment_method, business_date);

/**
 * Everything the Daily Sales card draws, as one jsonb document.
 *
 * p_from / p_to      inclusive business-date window, already clamped by the caller
 * p_branch_id        null = consolidated across every branch
 * p_top_limit        how many products to rank (the UI offers 5 or 10)
 * p_prev_from/_to    the comparison window; pass nulls to skip the comparison
 * p_today            the current business date, so "Today's Sales" does not
 *                    depend on the server's own clock agreeing with the app's
 *                    2 AM rollover — @mb/shared owns that rule and the route
 *                    hands the answer in
 */
create or replace function public.sales_analytics(
  p_from      date,
  p_to        date,
  p_branch_id uuid,
  p_top_limit integer,
  p_prev_from date,
  p_prev_to   date,
  p_today     date
)
returns jsonb
language sql
stable
as $$
with scoped as (
  select o.id, o.business_date, o.grand_total, o.payment_method
    from orders o
   where o.business_date between p_from and p_to
     and o.status <> 'cancelled'
     and (p_branch_id is null or o.branch_id = p_branch_id)
),
-- Every money figure below reads from here, never from `scoped`.
paid as (
  select * from scoped where payment_method <> 'staff'
),
days as (
  select d::date as business_date
    from generate_series(p_from, p_to, interval '1 day') as d
),
daily as (
  select days.business_date,
         coalesce(sum(paid.grand_total), 0) as sales,
         -- count(paid.id) and not count(*): the left join leaves one all-null
         -- row for a day with no sales, which count(*) would report as one sale.
         count(paid.id)                     as transactions
    from days
    left join paid on paid.business_date = days.business_date
   group by days.business_date
),
highest as (
  select business_date, sales, transactions
    from daily
   where sales > 0
   order by sales desc, business_date
   limit 1
),
-- `sales > 0`, exactly as `highest` has it, and the predicate is the whole point
-- rather than symmetry: `days` is a DENSE series, so a Sunday the branch was shut
-- is present with sales 0 and would win "lowest" on every window containing one.
-- The figure a manager wants is the worst day the shop actually traded; a
-- fabricated Rs.0 for a day nobody opened buries it, and reads as a catastrophe
-- rather than a closure. A window with no trading at all yields no row, and the
-- card shows an em dash rather than a zero it cannot justify.
--
-- Ties break on the EARLIER date (`business_date` ascending, as in `highest`), so
-- the answer is stable across refetches instead of flipping between two equal days.
lowest as (
  select business_date, sales, transactions
    from daily
   where sales > 0
   order by sales asc, business_date
   limit 1
),
payment as (
  select payment_method::text as method,
         sum(grand_total)     as total,
         count(*)             as cnt
    from paid
   group by payment_method
),
staff as (
  select coalesce(sum(grand_total), 0) as total, count(*) as cnt
    from scoped
   where payment_method = 'staff'
),
top_products as (
  -- product_id is nullable (ON DELETE SET NULL keeps sales history when a
  -- product is deleted), so a null falls back to the name snapshot rather than
  -- collapsing every deleted product into one bucket.
  -- Aggregated as text: there is no max(uuid) in Postgres, and the value is
  -- only ever emitted as a string. Every row in a group carries the same
  -- product_id (or none at all), so max() picks that one value exactly.
  select coalesce(i.product_id::text, 'name:' || i.product_name) as group_key,
         max(i.product_id::text)                                 as product_id,
         min(i.product_name)                                     as product_name,
         coalesce(min(i.category_name), '')                      as category_name,
         sum(i.qty)                                              as qty,
         sum(i.line_total)                                       as sales
    from order_items i
    join paid p on p.id = i.order_id
   group by 1
   order by sales desc, product_name
   limit greatest(coalesce(p_top_limit, 5), 1)
),
totals as (
  select coalesce(sum(grand_total), 0) as sales, count(*) as transactions from paid
),
previous as (
  select coalesce(sum(o.grand_total), 0) as sales, count(*) as transactions
    from orders o
   where p_prev_from is not null
     and p_prev_to   is not null
     and o.business_date between p_prev_from and p_prev_to
     and o.status <> 'cancelled'
     and o.payment_method <> 'staff'
     and (p_branch_id is null or o.branch_id = p_branch_id)
),
-- Its own scan rather than a lookup into `daily`: "Today's Sales" is today's
-- figure whatever window the user is looking at, and today is frequently
-- outside it (Yesterday, Previous Month, any custom range in the past).
today as (
  select coalesce(sum(o.grand_total), 0) as sales, count(*) as transactions
    from orders o
   where o.business_date = p_today
     and o.status <> 'cancelled'
     and o.payment_method <> 'staff'
     and (p_branch_id is null or o.branch_id = p_branch_id)
)
select jsonb_build_object(
  'totalSales',        (select sales        from totals),
  'totalTransactions', (select transactions from totals),
  'todaySales',        (select sales        from today),
  'todayTransactions', (select transactions from today),
  'staffTotal',        (select total        from staff),
  'staffCount',        (select cnt          from staff),
  -- Denominator is every day in the (clamped) window, including the ones that
  -- sold nothing. Averaging over trading days only would answer a different
  -- question — "how good is a day we open" — and would rise when the shop shuts.
  'dayCount',          (select count(*)     from days),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
           order by business_date)
      from daily), '[]'::jsonb),
  'highestDay', (
    select jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
      from highest),
  'lowestDay', (
    select jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
      from lowest),
  'paymentMethods', coalesce((
    select jsonb_agg(jsonb_build_object('method', method, 'total', total, 'count', cnt)
           order by total desc)
      from payment), '[]'::jsonb),
  'topProducts', coalesce((
    select jsonb_agg(jsonb_build_object(
             'productId',    coalesce(product_id, ''),
             'productName',  product_name,
             'categoryName', category_name,
             'qty',          qty,
             'sales',        sales)
           order by sales desc, product_name)
      from top_products), '[]'::jsonb),
  'previousSales',        (select sales        from previous),
  'previousTransactions', (select transactions from previous)
);
$$;

revoke all on function public.sales_analytics(date, date, uuid, integer, date, date, date)
  from public, anon, authenticated;
grant execute on function public.sales_analytics(date, date, uuid, integer, date, date, date)
  to service_role;
