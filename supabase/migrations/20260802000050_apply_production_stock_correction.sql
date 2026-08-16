-- 50: apply_production_stock_correction — the pool's sibling of migration 33.
--
-- A stock query raised from the Production dashboard (STK-###### on the Help Desk)
-- is about the CENTRAL POOL, not a branch. The Support Center could not correct one:
-- apply_stock_correction sizes its compensating movement against exactly one branch's
-- `stock` row, and the pool has none — so those tickets were marked read-only and
-- could only be answered in words. This is the missing write.
--
-- ─── Same model as the branch, different ledger ────────────────────────────────
-- The Production Stock page shows Prepared Today / Total Stock / Approved Qty /
-- Sold / Returned / Balance, all reconstructed from `production_stock_history` by
-- getProductionStockRows (production-stock.service.ts):
--
--   prepared =  Σ delta where type = 'prepare'       (stored positive)
--   approved = −Σ delta where type = 'transfer_out'  (stored negative, shown positive)
--   returned =  Σ delta where type = 'return_in'     (stored positive)
--   sold     = −Σ delta where type = 'sale'          (stored negative, shown positive)
--   adjust   =  Σ delta where type = 'adjustment'    (SIGNED)
--   total    =  balance + approved + sold            (gross in, derived — not correctable)
--
-- The admin supplies ABSOLUTE targets — the figures as they should read. Each one
-- becomes a single appended movement of the matching type, sized to close the gap
-- between the LIVE figure and the target. Nothing is rewritten: like `stock_history`,
-- `production_stock_history` is append-only and the original rows keep their audit
-- value.
--
-- Balance is handled last and absorbs the remainder, as in migration 33: correcting
-- only Balance is a plain "the shelf disagrees with the system" count, while
-- correcting the others reclassifies units without needing an adjustment at all.
--
-- ─── Two deliberate differences from the branch version ────────────────────────
--   1. NO BRANCH. `production_stock` is keyed by product_id alone (it is the
--      PRIMARY KEY), so there is one row to lock and no lock-ordering concern.
--   2. A NEGATIVE result is ALLOWED. Migration 15 is explicit that the pool may go
--      negative — it is flagged in the UI, never blocked — and it does in practice.
--      Rejecting one here would make a product that is already negative impossible
--      to correct at all. The final balance is returned so the caller can warn.
--      (The branch version rejects, because a physical shelf count cannot be < 0.)
--
-- ─── Invariants kept ───────────────────────────────────────────────────────────
--   * One movement per corrected figure, all under ONE ref_id
--     `<ticketId>:prodstock:<uuid>` — unique per correction, so the idempotency key
--     (ref_id, product_id, type) never collides with an earlier correction on the
--     same ticket. Same scheme as migrations 26 and 33.
--   * A figure whose target already matches writes nothing, so resubmitting
--     unchanged figures is a true no-op.
--   * Movements are written directly rather than through
--     apply_production_stock_movement: that function reserves an idempotency key
--     per (ref_id, product_id, type) and returns early when it is taken, which is
--     right for a retryable prepare/transfer but would silently swallow a second,
--     genuinely different correction here. The ref_id is fresh per call instead.
--
-- NOTE ON SCOPE: correcting `sold` moves POOL STOCK ONLY. It does not touch the
-- order, its total or its tender — a counter sale recorded wrongly is a sale query
-- (MB-######). Production counter sales cannot be edited from the Support Center at
-- all (they draw on the pool while edit_sale_items reconciles branch stock), so a
-- wrong one is answered, and only its stock effect is corrected here.
--
-- p_targets is jsonb; an absent or null key means "leave this figure alone":
--   { "preparedToday": N, "approvedQty": N, "returned": N, "soldToday": N, "balance": N }
--
-- Returns jsonb:
--   {"status":"ok","applied":bool,"refId":text|null,
--    "before":{"preparedToday":N,"approvedQty":N,"returned":N,"soldToday":N,
--              "adjustment":N,"balance":N,"totalStock":N},
--    "after": {  ... same shape ... },
--    "movements":[{"type":text,"delta":N}]}
--
-- SECURITY: locked to service_role at the bottom, like every other write function.

create or replace function public.apply_production_stock_correction(
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
  v_balance    numeric;          -- live pool balance (locked)
  v_prepared   numeric := 0;     -- live derived figures for p_business_date
  v_approved   numeric := 0;
  v_returned   numeric := 0;
  v_sold       numeric := 0;
  v_adjust     numeric := 0;
  v_d_prepared numeric := 0;     -- signed corrections to apply
  v_d_approved numeric := 0;
  v_d_returned numeric := 0;
  v_d_sold     numeric := 0;
  v_d_adjust   numeric := 0;
  v_implied    numeric;          -- balance after the four figure corrections
  v_final      numeric;
  v_after      numeric;
  v_ref        text;
  v_movements  jsonb := '[]'::jsonb;
  v_target     numeric;
begin
  -- ── Read the live figures under the row lock ────────────────────────────────
  select balance into v_balance from production_stock
   where product_id = p_product_id
   for update;
  if not found then v_balance := 0; end if;

  select coalesce(sum(delta)  filter (where type = 'prepare'),      0),
         coalesce(-sum(delta) filter (where type = 'transfer_out'), 0),
         coalesce(sum(delta)  filter (where type = 'return_in'),    0),
         coalesce(-sum(delta) filter (where type = 'sale'),         0),
         coalesce(sum(delta)  filter (where type = 'adjustment'),   0)
    into v_prepared, v_approved, v_returned, v_sold, v_adjust
    from production_stock_history
   where product_id = p_product_id
     and business_date = p_business_date;

  -- ── Size each correction from its target ───────────────────────────────────
  v_target := nullif(p_targets->>'preparedToday', '')::numeric;
  if v_target is not null then v_d_prepared := v_target - v_prepared; end if;

  v_target := nullif(p_targets->>'approvedQty', '')::numeric;
  if v_target is not null then v_d_approved := v_target - v_approved; end if;

  v_target := nullif(p_targets->>'returned', '')::numeric;
  if v_target is not null then v_d_returned := v_target - v_returned; end if;

  v_target := nullif(p_targets->>'soldToday', '')::numeric;
  if v_target is not null then v_d_sold := v_target - v_sold; end if;

  -- Balance last: it absorbs whatever the four above did not account for.
  -- Prepared and returned add to the pool; approved and sold take from it.
  v_implied := v_balance + v_d_prepared - v_d_approved + v_d_returned - v_d_sold;
  v_target  := nullif(p_targets->>'balance', '')::numeric;
  if v_target is not null then v_d_adjust := v_target - v_implied; end if;

  v_final := v_implied + v_d_adjust;

  if v_d_prepared = 0 and v_d_approved = 0 and v_d_returned = 0
     and v_d_sold = 0 and v_d_adjust = 0 then
    return jsonb_build_object(
      'status', 'ok', 'applied', false, 'refId', null,
      'before', jsonb_build_object(
        'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
        'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
        'totalStock', v_balance + v_approved + v_sold),
      'after', jsonb_build_object(
        'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
        'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
        'totalStock', v_balance + v_approved + v_sold),
      'movements', v_movements
    );
  end if;

  v_ref := p_ticket_id || ':prodstock:' || gen_random_uuid()::text;

  -- ── Append the movements, chaining balance_after through each ──────────────
  -- Each insert mirrors the sign convention the pool already stores in:
  -- prepare / return_in positive, transfer_out / sale negative.
  if v_d_prepared <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_prepared)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_prepared,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'prepare', v_d_prepared, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'prepare', 'delta', v_d_prepared);
  end if;

  if v_d_approved <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, -v_d_approved)
    on conflict (product_id) do update
       set balance = production_stock.balance - v_d_approved,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'transfer_out', -v_d_approved, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'transfer_out', 'delta', -v_d_approved);
  end if;

  if v_d_returned <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_returned)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_returned,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'return_in', v_d_returned, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'return_in', 'delta', v_d_returned);
  end if;

  if v_d_sold <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, -v_d_sold)
    on conflict (product_id) do update
       set balance = production_stock.balance - v_d_sold,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'sale', -v_d_sold, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'sale', 'delta', -v_d_sold);
  end if;

  if v_d_adjust <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_adjust)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_adjust,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'adjustment', v_d_adjust, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_adjust);
  end if;

  return jsonb_build_object(
    'status', 'ok', 'applied', true, 'refId', v_ref,
    'before', jsonb_build_object(
      'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
      'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
      'totalStock', v_balance + v_approved + v_sold),
    'after', jsonb_build_object(
      'preparedToday', v_prepared + v_d_prepared,
      'approvedQty',   v_approved + v_d_approved,
      'returned',      v_returned + v_d_returned,
      'soldToday',     v_sold     + v_d_sold,
      'adjustment',    v_adjust   + v_d_adjust,
      'balance',       v_final,
      'totalStock',    v_final + (v_approved + v_d_approved) + (v_sold + v_d_sold)),
    'movements', v_movements
  );
end;
$$;

-- Lock down: never callable by anon/authenticated via the Data API.
revoke all on function public.apply_production_stock_correction(uuid, text, jsonb, text, date) from public, anon, authenticated;
grant execute on function public.apply_production_stock_correction(uuid, text, jsonb, text, date) to service_role;
