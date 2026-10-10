-- 56: branch physical-receipt verification for production orders.
--
-- Requires migration 55 already committed (the enum values this depends on) —
-- see that file's header for why the enum addition had to be split out into
-- its own transaction.
--
-- Introduces 'awaiting_verification' between 'pending' and 'approved':
-- Production's review (migration 40's review_production_order) still transfers
-- stock into branch inventory immediately, exactly as before — only the status
-- it writes changes, from 'approved' to 'awaiting_verification'. The order only
-- becomes 'approved' once the branch has physically checked what arrived and
-- confirmed it via verify_production_order below, which may correct quantities
-- (shortage/overage against what Production recorded) and/or add lines for
-- items that arrived but weren't on the original demand.
--
-- Corrections are booked as 'adjustment' stock movements (both the central pool
-- and branch stock), the same movement type production_returns already uses for
-- an out-of-band correction — not 'transfer_out'/'production', which are
-- reserved for the original review's own movement.

alter table production_orders
  add column if not exists verified_by      uuid references users (id) on delete set null,
  add column if not exists verified_by_name text,
  add column if not exists verified_at      timestamptz;

-- ── review_production_order: same signature, only the approval branch's status
-- check moves from 'approved' to 'awaiting_verification'. CREATE OR REPLACE is
-- safe here (no DROP needed) since the parameter list is unchanged from
-- migration 40.
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
  v_prev          numeric;
  v_total         numeric;
  v_approved      numeric;
  v_remaining     numeric;
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

  -- Rejection: status flipped, balances untouched by design.
  --
  -- Tested as `= 'rejected'` rather than `<> 'awaiting_verification'` so this
  -- stays BACKWARD COMPATIBLE. Local dev and production share one database, and
  -- CREATE OR REPLACE swaps this function for every caller the instant it is
  -- applied — including a not-yet-redeployed server still sending the old
  -- 'approved'. Under the negated form that old call would fall into this early
  -- return, marking the order approved while computing no approved quantities,
  -- writing no balances, and handing the route an empty items[] so it moves no
  -- stock. Treating only 'rejected' as the rejection path lets 'approved' and
  -- 'awaiting_verification' both run the full computation, so the migration can
  -- be applied before, after, or between deploys without a broken window.
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
    select pending_qty into v_prev
      from production_balances
     where branch_id = v_branch_id and product_id = r.product_id
     for update;
    if not found then v_prev := 0; end if;

    v_total := coalesce(v_prev, 0) + coalesce(r.qty, 0);

    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
     where (o->>'productId')::uuid = r.product_id
     limit 1;

    v_approved  := coalesce(v_override, v_total);
    v_remaining := greatest(0, v_total - v_approved);
    if v_approved <> v_total then v_was_changed := true; end if;

    update production_order_items
       set previous_balance_qty  = v_prev,
           total_required_qty    = v_total,
           approved_qty          = v_approved,
           remaining_balance_qty = v_remaining
     where id = r.id;

    insert into production_balances (branch_id, branch_name, product_id, product_name, pending_qty)
    values (v_branch_id, v_branch_name, r.product_id, r.product_name, v_remaining)
    on conflict (branch_id, product_id) do update
       set pending_qty  = excluded.pending_qty,
           branch_name  = coalesce(excluded.branch_name, production_balances.branch_name),
           product_name = coalesce(excluded.product_name, production_balances.product_name);

    v_items := v_items || jsonb_build_object(
      'productId',           r.product_id,
      'productName',         r.product_name,
      'qty',                 r.qty,
      'previousBalanceQty',  v_prev,
      'totalRequiredQty',    v_total,
      'approvedQty',         v_approved,
      'remainingBalanceQty', v_remaining
    );

    v_override := null;
  end loop;

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
     set was_changed = v_was_changed,
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
-- Atomic check-and-set on status = 'awaiting_verification', same double-review
-- guard as review_production_order. Returns per-product deltas (verified minus
-- previously-approved, or the full qty for a brand-new line) so the route can
-- book the matching 'adjustment' stock movements — this function only touches
-- production_orders / production_order_items / production_balances, never
-- production_stock or stock directly (same separation review_production_order
-- already keeps, since PostgREST gives each RPC its own transaction and the
-- stock services live in application code).
--
-- New lines skip production_balances entirely (previous_balance_qty = 0,
-- total_required_qty = qty, remaining_balance_qty = 0) — they were never part
-- of the original demand cycle, the same reasoning migration 40 already applies
-- to packing materials.
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
  v_corrections   jsonb := '[]'::jsonb;
  v_total         numeric;
  v_prev_approved numeric;
  v_verified      numeric;
  v_remaining     numeric;
  v_delta         numeric;
  v_max_line      integer;
  r               record;
  n               record;
begin
  update production_orders
     set status           = 'approved',
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

  -- Existing lines: only touch what the branch actually sent a verifiedQty for.
  for r in
    select o->>'productId' as product_id, (o->>'verifiedQty')::numeric as verified_qty
      from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
  loop
    select i.id, i.product_name, i.total_required_qty, i.approved_qty
      into n
      from production_order_items i
     where i.production_order_id = p_order_id
       and i.product_id = r.product_id::uuid
     limit 1;
    if not found then continue; end if;

    v_total         := coalesce(n.total_required_qty, 0);
    v_prev_approved := coalesce(n.approved_qty, 0);
    v_verified      := r.verified_qty;
    v_remaining     := greatest(0, v_total - v_verified);
    v_delta         := v_verified - v_prev_approved;

    update production_order_items
       set approved_qty          = v_verified,
           remaining_balance_qty = v_remaining
     where id = n.id;

    -- Hazard 2 (migration 05/40): ASSIGN, never increment.
    insert into production_balances (branch_id, branch_name, product_id, product_name, pending_qty)
    values (v_branch_id, v_branch_name, r.product_id::uuid, n.product_name, v_remaining)
    on conflict (branch_id, product_id) do update
       set pending_qty  = excluded.pending_qty,
           branch_name  = coalesce(excluded.branch_name, production_balances.branch_name),
           product_name = coalesce(excluded.product_name, production_balances.product_name);

    if v_delta <> 0 then
      v_corrections := v_corrections || jsonb_build_object(
        'productId', r.product_id, 'productName', n.product_name, 'delta', v_delta
      );
    end if;
  end loop;

  -- New lines: arrived but weren't on the original demand. No balance write.
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

      v_corrections := v_corrections || jsonb_build_object(
        'productId', r.product_id, 'productName', r.product_name, 'delta', r.qty
      );
    end loop;
  end if;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
    'corrections', v_corrections
  );
end;
$$;

revoke all on function public.verify_production_order(uuid, jsonb, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.verify_production_order(uuid, jsonb, jsonb, uuid, text) to service_role;
