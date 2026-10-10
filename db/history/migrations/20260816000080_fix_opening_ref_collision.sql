-- 80: fix the 500 migration 79 introduced -- colliding idempotency keys.
--
-- THE FAILURE
--
--   PATCH /api/support/:id/figures -> 500
--   duplicate key value violates unique constraint "stock_history_idempotency_key"
--
-- reproduced live on 2026-08-16 from 10:40 onward, every attempt failing.
--
-- WHY
--
-- That constraint is `unique (ref_id, product_id, type)` (migration 04). It does
-- NOT include business_date. Migration 33 was built around that and said so --
-- "one movement per corrected figure, all under ONE ref_id" -- which holds only
-- while each correction appends at most one row PER TYPE. It did: production,
-- sale, return, adjustment, one apiece.
--
-- Migration 79 broke that invariant. The Opening correction is a SECOND
-- 'adjustment' row (dated to the previous business day), sharing the one ref_id.
-- So the moment an admin changed Opening *and* anything that books a residual
-- adjustment -- a Balance target, or an Adjustment target -- the function tried to
-- insert two rows with the same (ref_id, product_id, 'adjustment') and Postgres
-- rejected the second. Opening alone was fine, which is why the no-op probe that
-- verified migration 79 sailed through: it never wrote a row at all.
--
-- THE FIX
--
-- The previous-day row gets its own key, `<ref>:open`. Suffixed rather than
-- randomised so it still reads as part of the same correction and still sorts with
-- it. Nothing else changes: same movements, same arithmetic, same guards.
--
-- Both rows remain individually idempotent, which is the property the constraint
-- exists to give -- a retry of the same correction still cannot double-apply
-- either one.

create or replace function public.apply_stock_correction(
  p_branch_id     uuid,
  p_product_id    uuid,
  p_product_name  text,
  p_targets       jsonb,
  p_ticket_id     text,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_balance    numeric;          -- live balance (locked)
  v_new        numeric := 0;     -- live derived figures for p_business_date
  v_sold       numeric := 0;
  v_returned   numeric := 0;
  v_adjust     numeric := 0;
  v_opening    numeric;
  v_d_new      numeric := 0;     -- signed corrections to apply
  v_d_sold     numeric := 0;
  v_d_returned numeric := 0;
  v_d_adjust   numeric := 0;
  v_d_open     numeric := 0;     -- correction to OPENING (migration 79)
  v_prev_date  date;
  v_closed     boolean := false;
  v_implied    numeric;          -- balance after new/sold/returned corrections
  v_final      numeric;
  v_after      numeric;
  v_ref        text;
  v_ref_open   text;         -- distinct ref for the previous-day row (migration 80)
  v_movements  jsonb := '[]'::jsonb;
  v_target     numeric;
  v_target_adj numeric;          -- the Adjustment target (migration 78)
begin
  -- ── Read the live figures under the row lock ────────────────────────────────
  select balance into v_balance from stock
   where branch_id = p_branch_id and product_id = p_product_id
   for update;
  if not found then v_balance := 0; end if;

  select coalesce(sum(delta) filter (where type = 'production'),  0),
         coalesce(-sum(delta) filter (where type = 'sale'),       0),
         coalesce(-sum(delta) filter (where type = 'return'),     0),
         coalesce(sum(delta) filter (where type = 'adjustment'),  0)
    into v_new, v_sold, v_returned, v_adjust
    from stock_history
   where branch_id = p_branch_id
     and product_id = p_product_id
     and business_date = p_business_date;

  -- Same definition computeStockRows uses, so the admin sees what the branch sees.
  v_opening := v_balance - (v_new - v_sold - v_returned + v_adjust);

  -- ── Size each correction from its target ───────────────────────────────────
  v_target := nullif(p_targets->>'newQty', '')::numeric;
  if v_target is not null then v_d_new := v_target - v_new; end if;

  v_target := nullif(p_targets->>'sold', '')::numeric;
  if v_target is not null then v_d_sold := v_target - v_sold; end if;

  v_target := nullif(p_targets->>'returned', '')::numeric;
  if v_target is not null then v_d_returned := v_target - v_returned; end if;

  -- Opening: the only target whose movement is dated to a DIFFERENT day. See the
  -- header — a movement on p_business_date cannot shift opening at all.
  v_prev_date := p_business_date - 1;
  v_target    := nullif(p_targets->>'opening', '')::numeric;
  if v_target is not null and v_target <> v_opening then
    select exists (
             select 1 from business_day_closures
              where business_date = v_prev_date
           )
      into v_closed;
    if v_closed then
      return jsonb_build_object('status', 'day_closed', 'businessDate', v_prev_date);
    end if;
    v_d_open := v_target - v_opening;
  end if;

  -- Balance last: it absorbs whatever the others did not account for. The opening
  -- correction is already inside v_implied, so a balance target is measured
  -- against the SHIFTED baseline — "the day started here and ended there".
  v_implied    := v_balance + v_d_open + v_d_new - v_d_sold - v_d_returned;
  v_target     := nullif(p_targets->>'balance', '')::numeric;
  v_target_adj := nullif(p_targets->>'adjustment', '')::numeric;

  -- One degree of freedom, two names for it. Refuse rather than pick. (Opening is
  -- NOT part of this pair — it is a different day's figure.)
  if v_target is not null and v_target_adj is not null then
    return jsonb_build_object('status', 'overdetermined');
  end if;

  if v_target is not null then
    v_d_adjust := v_target - v_implied;
  elsif v_target_adj is not null then
    v_d_adjust := v_target_adj - v_adjust;
  end if;

  v_final := v_implied + v_d_adjust;

  -- ── Validate before ANY write ──────────────────────────────────────────────
  if v_final < 0 then
    return jsonb_build_object('status', 'negative_balance', 'balance', v_final);
  end if;

  if v_d_new = 0 and v_d_sold = 0 and v_d_returned = 0 and v_d_adjust = 0 and v_d_open = 0 then
    return jsonb_build_object(
      'status', 'ok', 'applied', false, 'refId', null,
      'before', jsonb_build_object(
        'opening', v_opening, 'newQty', v_new, 'sold', v_sold,
        'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
      'after', jsonb_build_object(
        'opening', v_opening, 'newQty', v_new, 'sold', v_sold,
        'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
      'movements', v_movements
    );
  end if;

  v_ref := p_ticket_id || ':stock:' || gen_random_uuid()::text;
  -- Same correction, its own idempotency key. The unique index is
  -- (ref_id, product_id, type) and does NOT include business_date, so the
  -- previous-day 'adjustment' row and today's 'adjustment' row would collide
  -- under one ref. Suffixed rather than randomised so it still reads as part of
  -- the same correction.
  v_ref_open := v_ref || ':open';

  -- ── The opening correction, dated to the PREVIOUS business day ─────────────
  -- First, so the balance it establishes is the one the day's movements below
  -- chain their balance_after from.
  if v_d_open <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_open)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_open,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'adjustment', v_d_open, v_after, v_ref_open, v_prev_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_open, 'businessDate', v_prev_date, 'refId', v_ref_open);
  end if;

  -- ── Append the day's movements, chaining balance_after through each ────────
  -- Sold and returned are stored NEGATIVE (migration 04); a target that lowers
  -- them therefore appends a positive delta, giving units back.
  if v_d_new <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_new)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_new,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'production', v_d_new, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'production', 'delta', v_d_new);
  end if;

  if v_d_sold <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, -v_d_sold)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance - v_d_sold,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'sale', -v_d_sold, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'sale', 'delta', -v_d_sold);
  end if;

  if v_d_returned <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, -v_d_returned)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance - v_d_returned,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'return', -v_d_returned, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'return', 'delta', -v_d_returned);
  end if;

  if v_d_adjust <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_adjust)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_adjust,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'adjustment', v_d_adjust, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_adjust);
  end if;

  return jsonb_build_object(
    'status', 'ok', 'applied', true, 'refId', v_ref,
    'before', jsonb_build_object(
      'opening',  v_opening, 'newQty', v_new, 'sold', v_sold,
      'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
    'after', jsonb_build_object(
      -- opening now moves too, by exactly the previous-day correction.
      'opening',  v_opening  + v_d_open,
      'newQty',   v_new      + v_d_new,
      'sold',     v_sold     + v_d_sold,
      'returned', v_returned + v_d_returned,
      'adjustment', v_adjust + v_d_adjust,
      'balance',  v_final),
    'movements', v_movements
  );
end;
$$;

-- Lock down: never callable by anon/authenticated via the Data API.
revoke all on function public.apply_stock_correction(uuid, uuid, text, jsonb, text, date) from public, anon, authenticated;
grant execute on function public.apply_stock_correction(uuid, uuid, text, jsonb, text, date) to service_role;
