-- 74: a demand is the fresh demand. The pending-balance carry-forward is gone.
--
-- WHAT WAS WRONG
--
-- Since migration 16 the review has computed
--
--     total_required = previous_balance + new_demand
--     approved       = override ?? total_required        -- <= the actual bug
--     remaining      = total_required - approved         -- written back as the
--                                                        --    next previous_balance
--
-- so Production's screen showed an inflated "Total Demand" and, on every line
-- nobody hand-edited, APPROVED THE PREVIOUS BALANCE ALONG WITH THE FRESH DEMAND.
-- A branch that was ever short once carried that shortfall into every subsequent
-- demand, and the shortfall re-fed itself: approving the inflated total moved
-- that much stock, and anything still unmet became the next carry-forward.
--
-- WHAT IT IS NOW
--
--     total_required = new_demand                        -- fresh demand only
--     approved       = override ?? new_demand            -- editable / reducible
--     remaining      = 0                                 -- nothing carries
--
-- Each demand is independent. Nothing from a past demand can enter a new one.
--
-- WHY previous_balance_qty / total_required_qty SURVIVE AS COLUMNS
--
-- They are dropped from the CALCULATION, not from the table. Orders reviewed
-- before this migration have real figures frozen onto their rows, and the order
-- detail / print slip read them back to reproduce what was actually approved on
-- the day. Dropping the columns would rewrite history into something that never
-- happened. New rows simply get previous_balance_qty = 0 and
-- total_required_qty = qty.
--
-- production_balances is likewise kept as a table but is no longer WRITTEN by
-- either function, and every outstanding row is zeroed at the bottom of this
-- file. The reads that remain (the outstanding-balances route, the daily-closing
-- snapshot, the production report) keep working and now report zero, which is
-- the truth once nothing carries forward.
--
-- DEPLOY ORDER — read this before pushing.
--
-- This migration is additive/behavioural: it changes no column and no constraint,
-- so it is safe to apply BEFORE the frontend ships. But it does not fix the bug
-- on its own. The frontend sends an explicit approvedQty per line, and an RPC
-- honours an explicit override by design (that is how Production reduces a line).
-- A not-yet-redeployed frontend still computes prev + new client-side and sends
-- THAT, so it keeps approving the inflated figure until the matching frontend
-- deploy lands. Push this, then deploy the frontend; the window in between
-- behaves exactly as it does today, so there is no broken state — only a
-- not-yet-fixed one.

-- ── review_production_order — Production's review. Signature unchanged from
-- migration 56, so CREATE OR REPLACE is safe (no DROP needed).
create or replace function public.review_production_order(
  p_order_id          uuid,
  p_status            branch_production_order_status,
  p_overrides         jsonb,
  p_reason            text,
  p_reviewed_by       uuid,
  p_reviewed_by_name  text,
  p_packing_overrides jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_branch_id     uuid;
  v_branch_name   text;
  v_exists        boolean;
  v_was_changed   boolean := false;
  v_items         jsonb   := '[]'::jsonb;
  v_packing       jsonb   := '[]'::jsonb;
  v_demand        numeric;
  v_approved      numeric;
  v_override      numeric;
  r               record;
begin
  update production_orders
     set status           = p_status,
         approved_by      = p_reviewed_by,
         approved_by_name = p_reviewed_by_name,
         approved_at      = now()
   where id = p_order_id
     and status = 'pending'
  returning branch_id, branch_name into v_branch_id, v_branch_name;

  if not found then
    select exists (select 1 from production_orders where id = p_order_id) into v_exists;
    if v_exists then
      return jsonb_build_object('status', 'already_reviewed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Rejection: status flipped, nothing computed. Kept as `= 'rejected'` rather
  -- than a negation for the same backward-compatibility reason migration 56
  -- documents at length — an old server still sending 'approved' must run the
  -- full computation, not fall into this early return.
  if p_status = 'rejected' then
    return jsonb_build_object(
      'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
      'items', '[]'::jsonb, 'packingItems', '[]'::jsonb
    );
  end if;

  for r in
    select i.id, i.product_id, i.product_name, i.qty
      from production_order_items i
     where i.production_order_id = p_order_id
     order by i.product_id
  loop
    -- The fresh demand IS the requirement. No production_balances read, and so
    -- no `for update` row lock: this loop no longer contends with a concurrent
    -- review of another order for the same branch/product.
    v_demand := coalesce(r.qty, 0);

    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
     where (o->>'productId')::uuid = r.product_id
     limit 1;

    -- Default is the fresh demand. An explicit override still wins — that is how
    -- Production reduces (or raises) a line, which is the intended edit path.
    v_approved := coalesce(v_override, v_demand);
    if v_approved <> v_demand then v_was_changed := true; end if;

    update production_order_items
       set previous_balance_qty  = 0,
           total_required_qty    = v_demand,
           approved_qty          = v_approved,
           remaining_balance_qty = 0
     where id = r.id;

    -- Deliberately NO production_balances write. A short-approved line is a
    -- decision Production made about THIS demand; it does not become a debt the
    -- next demand inherits.

    v_items := v_items || jsonb_build_object(
      'productId',           r.product_id,
      'productName',         r.product_name,
      'qty',                 r.qty,
      'previousBalanceQty',  0,
      'totalRequiredQty',    v_demand,
      'approvedQty',         v_approved,
      'remainingBalanceQty', 0
    );

    v_override := null;
  end loop;

  -- Packing materials are unchanged: they never had a carry-forward, so this
  -- loop is copied verbatim from migration 56.
  for r in
    select p.id, p.packing_material_id, p.material_name, p.qty
      from production_order_packing_items p
     where p.production_order_id = p_order_id
     order by p.line_no
  loop
    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_packing_overrides, '[]'::jsonb)) as o
     where (o->>'packingMaterialId')::uuid = r.packing_material_id
     limit 1;

    v_approved := coalesce(v_override, r.qty);
    if v_approved <> r.qty then v_was_changed := true; end if;

    update production_order_packing_items
       set approved_qty = v_approved
     where id = r.id;

    v_packing := v_packing || jsonb_build_object(
      'packingMaterialId', r.packing_material_id,
      'materialName',      r.material_name,
      'qty',               r.qty,
      'approvedQty',       v_approved
    );

    v_override := null;
  end loop;

  update production_orders
     set was_changed   = v_was_changed,
         change_reason = p_reason
   where id = p_order_id;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
    'items', v_items, 'packingItems', v_packing
  );
end;
$$;

revoke all on function public.review_production_order(uuid, branch_production_order_status, jsonb, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.review_production_order(uuid, branch_production_order_status, jsonb, text, uuid, text, jsonb) to service_role;

-- ── verify_production_order — the branch's physical-receipt confirmation.
--
-- Based on migration 58's definition (status -> 'verified', returns every final
-- line so the route moves stock), NOT migration 56's. Only the carry-forward is
-- removed: the counted quantity still becomes approved_qty, but the shortfall
-- against the requirement is no longer computed into production_balances.
create or replace function public.verify_production_order(
  p_order_id         uuid,
  p_verified_items   jsonb,  -- [{"productId": uuid, "verifiedQty": numeric}]
  p_new_items        jsonb,  -- [{"productId": uuid, "productName": text, "qty": numeric}]
  p_verified_by      uuid,
  p_verified_by_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_branch_id     uuid;
  v_branch_name   text;
  v_exists        boolean;
  v_items         jsonb;
  v_max_line      integer;
  r               record;
  n               record;
begin
  update production_orders
     set status           = 'verified',
         verified_by      = p_verified_by,
         verified_by_name = p_verified_by_name,
         verified_at      = now()
   where id = p_order_id
     and status = 'awaiting_verification'
  returning branch_id, branch_name into v_branch_id, v_branch_name;

  if not found then
    select exists (select 1 from production_orders where id = p_order_id) into v_exists;
    if v_exists then
      return jsonb_build_object('status', 'already_reviewed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The branch's counted quantity becomes the approved figure. Whatever it falls
  -- short of is a fact about this delivery, recorded on the line as the gap
  -- between qty and approved_qty — it is no longer promoted into a balance the
  -- next demand inherits.
  for r in
    select o->>'productId' as product_id, (o->>'verifiedQty')::numeric as verified_qty
      from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
  loop
    select i.id
      into n
      from production_order_items i
     where i.production_order_id = p_order_id
       and i.product_id = r.product_id::uuid
     limit 1;
    if not found then continue; end if;

    update production_order_items
       set approved_qty          = r.verified_qty,
           remaining_balance_qty = 0
     where id = n.id;
  end loop;

  -- Lines that arrived without being demanded — unchanged from migration 58.
  if jsonb_array_length(coalesce(p_new_items, '[]'::jsonb)) > 0 then
    select coalesce(max(line_no), 0) into v_max_line
      from production_order_items
     where production_order_id = p_order_id;

    for r in
      select o->>'productId' as product_id, o->>'productName' as product_name, (o->>'qty')::numeric as qty
        from jsonb_array_elements(p_new_items) as o
    loop
      v_max_line := v_max_line + 1;
      insert into production_order_items (
        production_order_id, product_id, product_name, qty, remarks,
        previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
      ) values (
        p_order_id, r.product_id::uuid, r.product_name, r.qty, 'Added at verification',
        0, r.qty, r.qty, 0, v_max_line
      );
    end loop;
  end if;

  -- Every final line, read back after the writes above — the caller moves stock
  -- from this, so it must reflect the whole order.
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'productId',   i.product_id,
             'productName', i.product_name,
             'qty',         coalesce(i.approved_qty, 0)
           ) order by i.line_no),
           '[]'::jsonb)
    into v_items
    from production_order_items i
   where i.production_order_id = p_order_id;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
    'items', v_items
  );
end;
$$;

revoke all on function public.verify_production_order(uuid, jsonb, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.verify_production_order(uuid, jsonb, jsonb, uuid, text) to service_role;

-- ── Clear every outstanding carry-forward.
--
-- Without this the balances standing at the moment of the deploy would sit in
-- the table forever: nothing writes them any more, so nothing would ever work
-- them back down to zero, and the outstanding-balances route and the daily
-- closing would keep reporting a debt no demand can now discharge.
--
-- Rows are zeroed, not deleted, so the (branch_id, product_id) pairs and their
-- names survive for anything that joins to them.
update production_balances
   set pending_qty = 0
 where pending_qty <> 0;

comment on table production_balances is
  'DEPRECATED as of migration 74. The pending-balance carry-forward was removed: '
  'a demand is now the fresh demand only. Nothing writes this table any more and '
  'every row was zeroed by that migration. Reads are retained so the outstanding '
  'route, the daily-closing snapshot and the production report keep working; they '
  'now report zero. Do not reintroduce writes without reading migration 74.';

comment on column production_order_items.previous_balance_qty is
  'Always 0 for orders reviewed from migration 74 onward. Historical orders keep '
  'the real carry-forward figure that was frozen onto them at review time.';

comment on column production_order_items.total_required_qty is
  'Equals qty (the fresh demand) from migration 74 onward. Historical orders keep '
  'previous_balance_qty + qty, which is what was actually approved against.';
