-- 46: Restore the deleted `counters` rows, and stop them being removed again.
--
-- WHAT HAPPENED
-- Every branch demand submission started failing with a 500:
--
--     counters row "demand" is missing
--
-- `counters` is the gapless human-number allocator behind MB- / EXP- / DMD- /
-- PRC- / STK- / EVT-. Each next_*_number() runs
--   update counters set count = count + 1 where id = '<key>' returning count
-- and raises if nothing matched. The live table had exactly ONE row left,
-- 'special_events'; every other row had been deleted.
--
-- This was not a missing migration. `supabase migration list --linked` showed
-- all 40 applied, including the three that seed these rows — 000003 ('orders'),
-- 000024 ('expenses','demand','price_history','stock') and 000025 ('support') —
-- and products.stock_code was populated up to STK-000056, which only
-- next_stock_number() could have written. The rows were created and then
-- deleted afterwards, by something outside this repo (nothing here removes
-- them; scripts/seed.js only CREATES the 'orders' row when it is absent).
-- Every transactional table was empty while master data survived, which is what
-- a "clear the test data" purge looks like when it sweeps counters in with it.
--
-- Those seeding migrations are already marked applied, so the rows never come
-- back on their own and every numbered insert stays broken until they do.
--
-- WHY THE VALUES ARE DERIVED, NOT HARDCODED
-- The obvious repair — re-insert everything at 0 — is wrong for 'stock'.
-- stock_code lives on `products`, which is master data and was NOT wiped: it
-- already holds STK-000001 .. STK-000056. A counter at 0 would hand the next
-- product STK-000001 and fail its unique constraint, 56 times running.
--
-- So each row is seeded from the real high-water mark in its owning table. That
-- makes this correct on THIS database, on a fresh one, and on a restored
-- backup, instead of encoding one moment's row counts. greatest() against the
-- original seed means a counter can never move backwards, and
-- `on conflict do nothing` keeps the migration re-runnable and leaves the
-- surviving 'special_events' row (258) untouched.
--
-- Numbers are formatted PREFIX-000056, so the value is the trailing digit run.
-- An aggregate with no GROUP BY yields exactly one row even over an empty
-- table, so the empty cases still insert a 0 rather than inserting nothing.

-- ---------------------------------------------------------------------------
-- Sales. Seeded at 124 by 000003 so the first order is MB-000125, continuing
-- the legacy system's numbering; greatest() preserves that intent even though
-- the table is currently empty, so a restored number can never collide with
-- old paperwork.
-- ---------------------------------------------------------------------------
insert into counters (id, count)
select 'orders', greatest(124, coalesce(max(substring(order_number from '[0-9]+$')::bigint), 0))
from orders
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Expenses. The branch and production tables deliberately SHARE one counter so
-- EXP-###### is unique across both — the max must therefore span both tables.
-- ---------------------------------------------------------------------------
insert into counters (id, count)
select 'expenses', coalesce(max(n), 0)
from (
  select substring(expense_number from '[0-9]+$')::bigint as n from expenses
  union all
  select substring(expense_number from '[0-9]+$')::bigint     from production_expenses
) s
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Demand (production_orders) — the counter whose absence raised the 500.
-- ---------------------------------------------------------------------------
insert into counters (id, count)
select 'demand', coalesce(max(substring(demand_number from '[0-9]+$')::bigint), 0)
from production_orders
on conflict (id) do nothing;

insert into counters (id, count)
select 'price_history', coalesce(max(substring(price_number from '[0-9]+$')::bigint), 0)
from product_price_history
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Stock codes. THIS is the one that must not be 0 — see the header. `products`
-- is master data and survived the purge.
-- ---------------------------------------------------------------------------
insert into counters (id, count)
select 'stock', coalesce(max(substring(stock_code from '[0-9]+$')::bigint), 0)
from products
on conflict (id) do nothing;

insert into counters (id, count)
select 'support', coalesce(max(substring(ticket_number from '[0-9]+$')::bigint), 0)
from support_tickets
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Guard: make a repeat purge fail loudly instead of silently breaking every
-- numbered insert.
--
-- TWO triggers, and that is the point rather than belt-and-braces: a
-- BEFORE DELETE ... FOR EACH ROW trigger does NOT fire on TRUNCATE, and a bulk
-- "clear all test data" is far more likely written as `truncate ... cascade`
-- than as a row-by-row delete. A delete-only guard would have missed precisely
-- the event that caused this outage.
--
-- The function never references OLD: a statement-level TRUNCATE trigger has no
-- OLD row, so touching it would error at runtime. TG_OP is valid in both.
--
-- Triggers fire for service_role too — the service key bypasses RLS, not
-- triggers — so this also covers the API's own client.
-- ---------------------------------------------------------------------------
create or replace function app.forbid_counter_removal() returns trigger
  language plpgsql
  as $$
  begin
    raise exception
      'counters rows must never be removed (% attempted). counters is CONFIGURATION, not '
      'transactional data: it is the gapless allocator behind MB-/EXP-/DMD-/PRC-/STK-/EVT- '
      'numbers. Exclude it from any data purge, or every numbered insert fails with '
      '"counters row ... is missing".', tg_op;
  end;
  $$;

revoke all on function app.forbid_counter_removal() from public, anon, authenticated;
grant execute on function app.forbid_counter_removal() to service_role;

drop trigger if exists counters_no_delete on counters;
create trigger counters_no_delete
  before delete on counters
  for each row execute function app.forbid_counter_removal();

drop trigger if exists counters_no_truncate on counters;
create trigger counters_no_truncate
  before truncate on counters
  for each statement execute function app.forbid_counter_removal();
