-- 128: Finance Dashboard (monthly) — production income and ledger expense per
-- branch per business date, plus the source records behind every figure.
--
-- Why SQL: PostgREST aggregates are disabled on this project, and a month of
-- production is thousands of order lines. Summing them in Node would mean
-- downloading every line on every dashboard load. Everything here is a
-- server-side GROUP BY; the API receives at most one row per (date, branch)
-- (and per ledger head for expenses).
--
-- Every rule below is lifted from existing code, not invented — see
-- docs/finance-dashboard-audit.md for the trace:
--
--   Demand Amount   Σ approved_qty × products.price over Production-reviewed
--                   orders — the `deliveredValue` of previous-balance.service.ts,
--                   which is what every production slip bills on.
--   Company Share   Demand Amount × the branch's company share %, resolved as
--                   resolveShareSplit does (branch override when present and
--                   0–100, else finance_settings, else 75), rounded per order.
--   Return          accepted production_returns, qty × products.price.
--   Discount        approved branch_discounts, amount as-is.
--   Received        live ledger income, debit − credit, on Company Share and
--                   Fuel heads, plus any Cash Deposit posting (pre-127 deposits
--                   sit on INC-BRANCH-CASH).
--   Ledger expense  live ledger expense rows, credit − debit, per head. Branch
--                   shop expenses (`expenses`) never reach the ledger, so they
--                   cannot appear here.
--
-- Net sums (debit − credit) are used rather than filtering status: a reversal
-- keeps the original row and posts a mirror, and only the arithmetic cancels.
--
-- Existing indexes already cover every predicate (production_orders
-- (branch_id, business_date), production_order_items (production_order_id),
-- production_returns / branch_discounts (branch_id, business_date),
-- ledger_entries (entry_date) and (branch_id, entry_date)); none are added.
-- ---------------------------------------------------------------------------

-- One row per Production-reviewed order in the window, with its value and
-- share. The single definition both public functions below read, so the
-- dashboard total and the drill-down rows cannot disagree.
create or replace function app.finance_order_values(p_from date, p_to date, p_branch_id uuid)
  returns table (
    order_id uuid, demand_number text, business_date date, branch_id uuid,
    branch_name text, status text, demand numeric, share_pct numeric,
    company_share numeric, line_count int, unpriced_lines int,
    created_by_name text, approved_by_name text, verified_by_name text
  )
  language sql
  stable
  as $$
    with def as (
      select case when fs.company_share_pct between 0 and 100 then fs.company_share_pct else 75 end as pct
      from (select (select company_share_pct from finance_settings limit 1) as company_share_pct) fs
    )
    select
      o.id, o.demand_number, o.business_date, o.branch_id,
      coalesce(b.name, o.branch_name), o.status::text,
      round(v.demand, 2),
      p.pct,
      round(v.demand * p.pct / 100, 2),
      v.lines, v.unpriced,
      o.created_by_name, o.approved_by_name, o.verified_by_name
    from production_orders o
    left join branches b on b.id = o.branch_id
    cross join def
    cross join lateral (
      select round(case when b.company_share_pct between 0 and 100 then b.company_share_pct else def.pct end, 2) as pct
    ) p
    cross join lateral (
      select
        coalesce(sum(coalesce(i.approved_qty, 0) * coalesce(pr.price, 0)), 0) as demand,
        count(*)::int as lines,
        count(*) filter (where coalesce(i.approved_qty, 0) > 0 and coalesce(pr.price, 0) = 0)::int as unpriced
      from production_order_items i
      left join products pr on pr.id = i.product_id
      where i.production_order_id = o.id
    ) v
    -- Reviewed and dispatched by Production. `pending` has shipped nothing,
    -- `rejected` / `cancelled` never will.
    where o.status::text in ('awaiting_verification', 'verified', 'approved')
      and o.business_date between p_from and p_to
      and (p_branch_id is null or o.branch_id = p_branch_id);
  $$;

revoke all on function app.finance_order_values(date, date, uuid) from public, anon, authenticated;
grant execute on function app.finance_order_values(date, date, uuid) to service_role;

-- The ledger heads whose income counts as "Received". One place to change it.
create or replace function app.finance_received_head_ids()
  returns uuid[]
  language sql
  stable
  as $$
    select coalesce(array_agg(id), '{}') from ledger_heads where code in ('INC-COMPANY-SHARE', 'INC-FUEL');
  $$;

revoke all on function app.finance_received_head_ids() from public, anon, authenticated;
grant execute on function app.finance_received_head_ids() to service_role;

-- ---------------------------------------------------------------------------
-- finance_monthly_dashboard — the aggregates.
--
--   days   one row per (business date, branch) with any activity:
--          demand, share, received, returns, discount + record counts
--   heads  one row per (date, branch, ledger head) of ledger expense
--          (omitted when p_include_heads is false — the 6-month trend call)
--
-- `branchId` null = the row is not attributed to a branch (company expenses,
-- an unassigned receipt). With p_branch_id set, only that branch's rows.
-- ---------------------------------------------------------------------------
create or replace function public.finance_monthly_dashboard(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_include_heads boolean default true
)
  returns jsonb
  language plpgsql
  stable
  set search_path = public, app
  as $$
  declare
    v_heads uuid[] := app.finance_received_head_ids();
    v_days jsonb;
    v_ledger jsonb := '[]'::jsonb;
  begin
    if p_from is null or p_to is null or p_to < p_from then
      raise exception 'invalid date range' using errcode = '22023';
    end if;
    if p_to - p_from > 400 then
      raise exception 'date range too long' using errcode = '22023';
    end if;

    with prod as (
      select business_date as d, branch_id as b, sum(demand) as demand, sum(company_share) as share,
             count(*) as orders, sum(unpriced_lines) as unpriced
      from app.finance_order_values(p_from, p_to, p_branch_id)
      group by 1, 2
    ),
    ret as (
      select r.business_date as d, r.branch_id as b,
             sum(round(r.qty * coalesce(pr.price, 0), 2)) as amt, count(*) as n
      from production_returns r
      left join products pr on pr.id = r.product_id
      where r.status::text = 'accepted'
        and r.business_date between p_from and p_to
        and (p_branch_id is null or r.branch_id = p_branch_id)
      group by 1, 2
    ),
    disc as (
      select business_date as d, branch_id as b, sum(amount) as amt, count(*) as n
      from branch_discounts
      where status::text = 'approved'
        and business_date between p_from and p_to
        and (p_branch_id is null or branch_id = p_branch_id)
      group by 1, 2
    ),
    rec as (
      select entry_date as d, branch_id as b, sum(debit - credit) as amt, count(*) as n
      from ledger_entries
      where deleted_at is null
        and ledger_head_type::text = 'income'
        and (ledger_head_id = any (v_heads) or source_type::text = 'cash_transfer')
        and entry_date between p_from and p_to
        and (p_branch_id is null or branch_id = p_branch_id)
      group by 1, 2
    ),
    keys as (
      select d, b from prod union select d, b from ret
      union select d, b from disc union select d, b from rec
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', k.d, 'branchId', k.b,
             'demand', coalesce(prod.demand, 0), 'companyShare', coalesce(prod.share, 0),
             'received', coalesce(rec.amt, 0), 'returns', coalesce(ret.amt, 0),
             'discount', coalesce(disc.amt, 0),
             'orders', coalesce(prod.orders, 0), 'unpricedLines', coalesce(prod.unpriced, 0),
             'receipts', coalesce(rec.n, 0), 'returnCount', coalesce(ret.n, 0),
             'discountCount', coalesce(disc.n, 0)
           ) order by k.d, k.b), '[]'::jsonb)
      into v_days
    from keys k
    left join prod on prod.d = k.d and prod.b is not distinct from k.b
    left join ret  on ret.d  = k.d and ret.b  is not distinct from k.b
    left join disc on disc.d = k.d and disc.b is not distinct from k.b
    left join rec  on rec.d  = k.d and rec.b  is not distinct from k.b;

    if p_include_heads then
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', x.d, 'branchId', x.b, 'ledgerHeadId', x.h,
               'ledgerHeadName', x.name, 'amount', x.amt, 'entries', x.n
             ) order by x.d, x.b, x.name), '[]'::jsonb)
        into v_ledger
      from (
        select e.entry_date as d, e.branch_id as b, e.ledger_head_id as h,
               coalesce(max(lh.name), max(e.ledger_head_name)) as name,
               sum(e.credit - e.debit) as amt, count(*) as n
        from ledger_entries e
        left join ledger_heads lh on lh.id = e.ledger_head_id
        where e.deleted_at is null
          and e.ledger_head_type::text = 'expense'
          and e.entry_date between p_from and p_to
          and (p_branch_id is null or e.branch_id = p_branch_id)
        group by 1, 2, 3
      ) x;
    end if;

    return jsonb_build_object('days', v_days, 'ledger', v_ledger);
  end;
  $$;

revoke all on function public.finance_monthly_dashboard(date, date, uuid, boolean) from public, anon, authenticated;
grant execute on function public.finance_monthly_dashboard(date, date, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- finance_dashboard_records — the source rows behind one figure, paged.
--
--   p_metric      demand | share | received | ledger | return | discount
--   p_branch_id   a branch, or null for all branches
--   p_no_branch   true = only rows with no branch (overrides p_branch_id)
--   p_head_id     ledger only: one ledger head
--   p_search      matched against the reference / id / branch / detail text
--
-- Returns { total, amount, rows[] } where `amount` is the sum of EVERY matching
-- row (not just the page), so the drawer's total always equals the figure the
-- user clicked.
-- ---------------------------------------------------------------------------
create or replace function public.finance_dashboard_records(
  p_metric text,
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_no_branch boolean default false,
  p_head_id uuid default null,
  p_search text default null,
  p_limit int default 25,
  p_offset int default 0
)
  returns jsonb
  language plpgsql
  stable
  set search_path = public, app
  as $$
  declare
    v_heads uuid[] := app.finance_received_head_ids();
    v_q text := nullif(lower(trim(coalesce(p_search, ''))), '');
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 200);
    v_offset int := greatest(coalesce(p_offset, 0), 0);
    v_out jsonb;
  begin
    if p_from is null or p_to is null or p_to < p_from then
      raise exception 'invalid date range' using errcode = '22023';
    end if;
    if p_metric not in ('demand', 'share', 'received', 'ledger', 'return', 'discount') then
      raise exception 'unknown metric %', p_metric using errcode = '22023';
    end if;

    with src as (
      select o.order_id as id, o.demand_number as ref, o.business_date as d, o.branch_id as b,
             o.branch_name as bname, 'Production order'::text as source,
             case when p_metric = 'share'
                  then trim_scale(o.share_pct)::text || '% of ' || to_char(o.demand, 'FM999,999,999,990.00')
                  else o.line_count::text || ' lines'
                       || case when o.unpriced_lines > 0 then ', ' || o.unpriced_lines::text || ' unpriced' else '' end
             end as detail,
             o.status as status,
             case when p_metric = 'share' then o.company_share else o.demand end as amount,
             o.created_by_name as created_by,
             coalesce(o.approved_by_name, o.verified_by_name) as approved_by
      from app.finance_order_values(p_from, p_to, null) o
      where p_metric in ('demand', 'share')

      union all
      select e.id, e.voucher_no, e.entry_date, e.branch_id, coalesce(b.name, e.branch_name),
             'Ledger · ' || coalesce(lh.name, e.ledger_head_name) || ' · ' || e.source_type::text,
             e.description, e.status::text,
             case when p_metric = 'received' then e.debit - e.credit else e.credit - e.debit end,
             e.created_by_name, e.approved_by_name
      from ledger_entries e
      left join branches b on b.id = e.branch_id
      left join ledger_heads lh on lh.id = e.ledger_head_id
      where p_metric in ('received', 'ledger')
        and e.deleted_at is null
        and e.entry_date between p_from and p_to
        and (
          (p_metric = 'received' and e.ledger_head_type::text = 'income'
             and (e.ledger_head_id = any (v_heads) or e.source_type::text = 'cash_transfer'))
          or (p_metric = 'ledger' and e.ledger_head_type::text = 'expense'
             and (p_head_id is null or e.ledger_head_id = p_head_id))
        )

      union all
      select r.id, null, r.business_date, r.branch_id, coalesce(b.name, r.branch_name),
             'Production return',
             r.product_name || ' × ' || trim_scale(r.qty)::text || ' @ ' || to_char(coalesce(pr.price, 0), 'FM999,999,990.00')
               || coalesce(' · ' || r.disposition::text, ''),
             r.status::text, round(r.qty * coalesce(pr.price, 0), 2),
             r.created_by_name, r.reviewed_by_name
      from production_returns r
      left join branches b on b.id = r.branch_id
      left join products pr on pr.id = r.product_id
      where p_metric = 'return'
        and r.status::text = 'accepted'
        and r.business_date between p_from and p_to

      union all
      select x.id, x.demand_number, x.business_date, x.branch_id, coalesce(b.name, x.branch_name),
             'Production discount', x.reason, x.status::text, x.amount,
             x.created_by_name, x.reviewed_by_name
      from branch_discounts x
      left join branches b on b.id = x.branch_id
      where p_metric = 'discount'
        and x.status::text = 'approved'
        and x.business_date between p_from and p_to
    ),
    filtered as (
      select * from src
      where (case when p_no_branch then b is null
                  else p_branch_id is null or b = p_branch_id end)
        and (v_q is null
             or lower(coalesce(ref, '')) like '%' || v_q || '%'
             or lower(id::text) like '%' || v_q || '%'
             or lower(coalesce(bname, '')) like '%' || v_q || '%'
             or lower(coalesce(detail, '')) like '%' || v_q || '%'
             or lower(coalesce(source, '')) like '%' || v_q || '%')
    )
    select jsonb_build_object(
             'total', (select count(*) from filtered),
             'amount', coalesce((select sum(amount) from filtered), 0),
             'rows', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', id, 'reference', ref, 'date', d, 'branchId', b, 'branchName', bname,
                        'source', source, 'detail', detail, 'status', status, 'amount', amount,
                        'createdBy', created_by, 'approvedBy', approved_by
                      ) order by d, bname nulls last, ref nulls last, id)
               from (select * from filtered order by d, bname nulls last, ref nulls last, id
                     limit v_limit offset v_offset) pg
             ), '[]'::jsonb)
           )
      into v_out;

    return v_out;
  end;
  $$;

revoke all on function public.finance_dashboard_records(text, date, date, uuid, boolean, uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.finance_dashboard_records(text, date, date, uuid, boolean, uuid, text, int, int) to service_role;
