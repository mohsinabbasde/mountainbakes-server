-- 79: let the Support Center correct Opening Stock.
--
-- Migration 33 declared opening uncorrectable and was right about the mechanism:
--
--     opening = balance − (new − sold − returned + adjustment)   [for ONE day]
--
-- Every movement apply_stock_correction appends lands in BOTH the balance and
-- that day's net, so opening is INVARIANT under it. You cannot move opening with
-- a today-dated movement, however large — balance and net shift together and the
-- difference does not budge. That is arithmetic, not policy, and it is why the
-- figure was left out rather than merely hidden.
--
-- WHAT ACTUALLY MOVES IT
--
-- Only a movement dated BEFORE the day being looked at. It raises the balance
-- while today's net is untouched, so:
--
--     opening_after = (balance + d) − net_today = opening_before + d
--
-- and today's New / Sold / Returned / Adjustment are all left exactly as they
-- were. So this appends its movement to the PREVIOUS business date.
--
-- That is not a trick to dodge the old rule; it is what the correction means.
-- Opening is yesterday's closing. Saying "the day opened with 12" is saying "the
-- previous day ended with 12", and the ledger should record it on the day it
-- belongs to. The row is an ordinary append — nothing is rewritten or deleted,
-- and the correction is as auditable as any other, carrying the same
-- '<ticketId>:stock:<uuid>' ref.
--
-- WHY THIS IS SAFE TO ALLOW NOW
--
-- Migration 33's objection was that correcting opening "would mean rewriting a
-- day that has already been closed". Nothing has been closed: business_day_closures
-- and daily_closing_reports are both EMPTY (0 rows), because the 2 AM closing job
-- is commented out in server.ts and has never run. There is no snapshot for a
-- restated opening to contradict — every figure in the system is derived live from
-- stock_history.
--
-- That will not always be true, so the guard is built in rather than assumed: if
-- the previous business date HAS been closed, the correction is refused with
-- 'day_closed'. Turning the scheduler on therefore closes this path automatically
-- on closed days, without anyone having to remember this migration exists.
--
-- HOW IT COMPOSES
--
-- Unlike balance/adjustment — which are one degree of freedom and are refused
-- together (migration 78) — opening is genuinely independent: it is a different
-- day's figure. Setting opening AND balance is coherent and means "the day started
-- here, and ended there"; the balance target still has the final say over today,
-- and the leftover still books as today's adjustment.

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
    values (p_branch_id, p_product_id, p_product_name, 'adjustment', v_d_open, v_after, v_ref, v_prev_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_open, 'businessDate', v_prev_date);
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
