-- 33: apply_stock_correction — apply an admin stock correction from the Support Center.
--
-- The Help Desk lets a branch raise a query against a product's stock (STK-######)
-- when what the system shows disagrees with the shelf. Until now the admin's "Change
-- figures" on such a ticket only wrote a resolution note: `editableFields` was empty
-- for stock references, so nothing ever reached `stock` / `stock_history` and the
-- branch's Stock page was unchanged. This is the missing write.
--
-- ─── The figures are DERIVED, so a correction is a compensating movement ─────────
-- The Stock page shows Opening / New / Sold / Returned / Adjustment / Balance, all
-- reconstructed from `stock_history` by computeStockRows (see stock.service.ts):
--
--   new      =  Σ delta where type = 'production'      (positive)
--   sold     = −Σ delta where type = 'sale'            (reported positive)
--   returned = −Σ delta where type = 'return'          (reported positive)
--   adjust   =  Σ delta where type = 'adjustment'      (SIGNED)
--   opening  =  balance − (new − sold − returned + adjust)
--
-- The admin supplies ABSOLUTE targets — the figures as they should read — because
-- that is what they can see and what the branch reported. Each target becomes one
-- appended movement of the matching type, sized to close the gap between the LIVE
-- figure and the target. Nothing is rewritten: the ledger stays append-only
-- (migration 04) and the original rows keep their audit value.
--
-- Because `opening` is defined as balance minus today's net, and every movement we
-- append lands in BOTH balance and net, opening is invariant under this function —
-- correctly so: opening is yesterday's closing, and correcting it would mean
-- rewriting a day that has already been closed. It is read-only in the UI.
--
-- Balance is handled last and specially. New/Sold/Returned each move the balance on
-- their own, so `balance` is treated as the final say: whatever gap remains between
-- the balance implied by the other three and the requested balance is booked as one
-- 'adjustment' movement. Supplying only `balance` is therefore a plain stock-count
-- correction; supplying the others reclassifies units without needing an adjustment.
--
-- ─── Invariants kept ────────────────────────────────────────────────────────────
--   * Append-only, one movement per corrected figure, all under ONE ref_id
--     `<ticketId>:stock:<uuid>` — unique per correction, so the idempotency key
--     (ref_id, product_id, type) never collides with an earlier correction on the
--     same ticket, and the four movements of one correction share a traceable ref.
--     Same scheme as migration 26's sale edit.
--   * A figure whose target already matches writes nothing (no zero-delta rows), so
--     a resubmit of unchanged figures is a true no-op.
--   * The resulting balance may not go NEGATIVE. Migration 04 permits negative
--     balances in general, but this path exists to make the ledger match a physical
--     count, and a physical count cannot be below zero — so it is rejected with the
--     shortfall rather than silently recorded.
--   * Locking mirrors migration 12: `select ... for update` on the stock row before
--     the read-modify-write, which a PostgREST call cannot hold across two round
--     trips. Single product, so no lock-ordering concern.
--
-- NOTE ON SCOPE: correcting `sold` here moves STOCK ONLY. It does not touch orders,
-- revenue or payment method — a sale recorded wrongly is corrected through the sale
-- (MB-######) query and edit_sale_items (migration 26), which moves stock, order
-- totals, customer spend and tender together. The UI says so at the point of entry.
--
-- p_targets is jsonb; an absent or null key means "leave this figure alone":
--   { "newQty": N, "sold": N, "returned": N, "balance": N }
--
-- Returns jsonb:
--   {"status":"ok","applied":bool,"refId":text|null,
--    "before":{"opening":N,"newQty":N,"sold":N,"returned":N,"adjustment":N,"balance":N},
--    "after": {  ... same shape ... },
--    "movements":[{"type":text,"delta":N}]}
--   {"status":"negative_balance","balance":N}
--
-- SECURITY: locked to service_role at the bottom, like every other write function.

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
  v_implied := v_balance + v_d_new - v_d_sold - v_d_returned;
  v_target  := nullif(p_targets->>'balance', '')::numeric;
  if v_target is not null then v_d_adjust := v_target - v_implied; end if;

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
