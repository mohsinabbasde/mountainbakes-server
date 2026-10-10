-- 78: let the Support Center set the Adjustment figure directly.
--
-- Migration 33 exposed four absolute targets — newQty / sold / returned / balance
-- — and deliberately left Adjustment out, because Adjustment is not an
-- independent figure. It is the RESIDUAL:
--
--     opening + new − sold − returned + adjustment = balance
--
-- so with the other four fixed, choosing a balance chooses an adjustment and vice
-- versa. Migration 33 picked balance as the one you type ("balance is the final
-- say; whatever gap remains is booked as one 'adjustment' movement").
--
-- That is fine when the admin is reconciling against a physical count. It is the
-- wrong end of the stick when the admin's intent is the correction itself —
-- "this product was adjusted by −4 today, make it −6", or "clear this adjustment
-- entirely". Expressing that through the balance box means doing the arithmetic
-- in your head, and getting it wrong writes a real stock movement.
--
-- WHAT CHANGES
--
-- `adjustment` joins the target set as the ALTERNATIVE to `balance`. Setting it
-- moves the adjustment figure to the target, and the balance follows by exactly
-- the same amount, which is the only self-consistent reading:
--
--     d_adjust = adjustment_target − adjustment_live
--
-- Clearing a correction is therefore `{"adjustment": 0}` — the day's adjustment
-- goes to 0 and the balance gives back precisely what the correction took (or
-- keeps what it added). That is what the Support Center's "Clear" does.
--
-- Supplying BOTH balance and adjustment is refused rather than silently resolved.
-- They are two names for one degree of freedom, and honouring one while ignoring
-- the other would leave the admin looking at a figure they did not ask for. The
-- UI offers one box or the other, so this is a stale-client guard.
--
-- WHAT DOES NOT CHANGE
--
--   · Opening stays invariant and uncorrectable — it is the previous day's
--     closing (migration 33's header explains why).
--   · The ledger stays APPEND-ONLY. "Deleting" an adjustment appends a
--     compensating movement; it never removes a stock_history row. Every balance
--     in the system is derived from that table, so deleting rows would silently
--     restate closed days and orphan the corrections' audit refs.
--   · Adjustment remains DAY-SCOPED. It is summed for one business_date, so a
--     correction shows on the day it was made and the column reads 0 the next
--     day — its effect having rolled into that day's opening balance.
--   · The negative-balance guard, the no-op-on-unchanged-targets behaviour, the
--     single shared ref_id and the row lock are all unchanged from migration 33.

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

  -- Balance last: it absorbs whatever the other three did not account for.
  v_implied    := v_balance + v_d_new - v_d_sold - v_d_returned;
  v_target     := nullif(p_targets->>'balance', '')::numeric;
  v_target_adj := nullif(p_targets->>'adjustment', '')::numeric;

  -- One degree of freedom, two names for it. Refuse rather than pick.
  if v_target is not null and v_target_adj is not null then
    return jsonb_build_object('status', 'overdetermined');
  end if;

  if v_target is not null then
    -- Reconcile to a counted balance; the gap becomes the adjustment.
    v_d_adjust := v_target - v_implied;
  elsif v_target_adj is not null then
    -- Set the adjustment itself; the balance follows by the same amount. Only the
    -- 'adjustment' movement below changes that figure, so the delta is simply the
    -- distance from the live value to the target. `{"adjustment": 0}` clears it.
    v_d_adjust := v_target_adj - v_adjust;
  end if;

  v_final := v_implied + v_d_adjust;

  -- ── Validate before ANY write ──────────────────────────────────────────────
  if v_final < 0 then
    return jsonb_build_object('status', 'negative_balance', 'balance', v_final);
  end if;

  if v_d_new = 0 and v_d_sold = 0 and v_d_returned = 0 and v_d_adjust = 0 then
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

  -- ── Append the movements, chaining balance_after through each ──────────────
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
      -- opening is invariant (see the header); the rest move by their correction.
      'opening',  v_opening,
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
