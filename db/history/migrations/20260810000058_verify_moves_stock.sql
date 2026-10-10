-- 58: verification becomes the point at which stock actually moves.
--
-- Requires migration 57 ('verified') already committed.
--
-- The lifecycle is now:
--
--   pending               branch submits
--   awaiting_verification Production submits          — no stock movement
--   verified              branch confirms receipt     — STOCK MOVES HERE
--   approved              Production's final sign-off — status only
--
-- Previously stock moved at Production's step and the branch's corrections were
-- booked afterwards as separate 'adjustment' movements. Moving it here instead
-- means the pool is debited ONCE, for the quantity the branch actually counted,
-- so there is no correction entry to reconcile and no window where branch stock
-- claims goods nobody has confirmed arriving.
--
-- This function still does NOT touch production_stock / stock itself: PostgREST
-- gives each RPC its own transaction, so those live in the stock services, same
-- separation review_production_order has always kept. It returns every final
-- line so the route can make that transfer.

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
  v_total         numeric;
  v_verified      numeric;
  v_remaining     numeric;
  v_max_line      integer;
  r               record;
  n               record;
begin
  -- Atomic check-and-set, same double-review guard as review_production_order.
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

  -- Existing lines: the branch's counted quantity becomes the approved figure,
  -- and whatever it falls short of the requirement carries forward.
  for r in
    select o->>'productId' as product_id, (o->>'verifiedQty')::numeric as verified_qty
      from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
  loop
    select i.id, i.product_name, i.total_required_qty
      into n
      from production_order_items i
     where i.production_order_id = p_order_id
       and i.product_id = r.product_id::uuid
     limit 1;
    if not found then continue; end if;

    v_total     := coalesce(n.total_required_qty, 0);
    v_verified  := r.verified_qty;
    v_remaining := greatest(0, v_total - v_verified);

    update production_order_items
       set approved_qty          = v_verified,
           remaining_balance_qty = v_remaining
     where id = n.id;

    -- Hazard 2 (migrations 05/40): ASSIGN, never increment.
    insert into production_balances (branch_id, branch_name, product_id, product_name, pending_qty)
    values (v_branch_id, v_branch_name, r.product_id::uuid, n.product_name, v_remaining)
    on conflict (branch_id, product_id) do update
       set pending_qty  = excluded.pending_qty,
           branch_name  = coalesce(excluded.branch_name, production_balances.branch_name),
           product_name = coalesce(excluded.product_name, production_balances.product_name);
  end loop;

  -- Lines that arrived without being demanded. No production_balances write:
  -- they were never part of the demand cycle, so there is no shortfall to carry
  -- — the same reasoning migration 40 applies to packing materials.
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
  -- from this, so it must reflect the whole order, not just the lines the branch
  -- happened to send a quantity for.
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
