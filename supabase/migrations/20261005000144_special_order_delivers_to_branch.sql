-- 144: an approved Special Order ends up in the ORDERING BRANCH's stock.
--
-- Migration 143 stopped at Production Stock: approval booked `+qty` as prepared
-- and left it there. But the item was made FOR a branch, and the branch has
-- already confirmed it with a photo before approval is even possible — so the
-- units sat in the central pool, on a shelf they are not on, and the branch
-- that holds the cake had nothing in its own stock to show for it.
--
-- Approval now books the whole journey, per row, in the one transaction:
--
--   Production Stock   +qty   'prepare'       it was made
--   Production Stock   −qty   'transfer_out'  it went to the branch
--   Branch stock       +qty   'production'    the branch holds it
--
-- These are the same three movements, through the same two functions, that a
-- delivered demand line produces — so the stock page reads it as "Prepared" and
-- "Demand fulfilled", and branch stock reads it like any other delivery.
--
-- STILL EXACTLY ONCE. Nothing about the guards changes:
--   · the check-and-set on status = 'verified' means a repeat reaches no ledger;
--   · each movement is keyed `<SO number>/<line>`, and both ledgers are UNIQUE
--     on (ref_id, product_id, type), so no movement can be booked twice even by
--     a caller that got past the status check;
--   · it is one plpgsql body — all three movements land, or none do.
--
-- Still no manual stock step, still nothing at create / prepare / verify, and
-- `amount` is still not read.
--
-- Orders approved under migration 143 (none existed when this was written) keep
-- the single 'prepare' they were given; this function never revisits an
-- 'approved' order.
create or replace function public.approve_special_order(
  p_order_id      uuid,
  p_by            uuid,
  p_by_name       text,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_ref         text;
  v_note        text;
  v_move_id     uuid;
  v_txn         text;
  v_meta        jsonb;
  v_moves       jsonb := '[]'::jsonb;
  r             record;
begin
  update special_orders
     set status = 'approved', approved_by = p_by, approved_by_name = p_by_name,
         approved_at = now(), stock_added_at = now()
   where id = p_order_id and status = 'verified'
  returning branch_id, branch_name, order_number into v_branch, v_branch_name, v_number;

  if not found then
    select status into v_status from special_orders where id = p_order_id;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  v_note := 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '');

  -- product_id order: migration 04's lock-ordering invariant for pool rows.
  for r in
    select id, product_id, item_name, qty, line_no
      from special_order_items
     where special_order_id = p_order_id
     order by product_id, line_no
  loop
    v_ref  := v_number || '/' || r.line_no;
    v_meta := jsonb_build_object(
      'source',             'special_order',
      'specialOrderId',     p_order_id,
      'specialOrderNumber', v_number,
      'specialOrderItemId', r.id);

    -- 1. Made: into Production Stock.
    perform public.apply_production_stock_movement(
      p_product_id      => r.product_id,
      p_product_name    => r.item_name,
      p_delta           => r.qty,
      p_type            => 'prepare',
      p_ref_id          => v_ref,
      p_business_date   => p_business_date,
      p_branch_id       => v_branch,
      p_created_by      => p_by,
      p_created_by_name => p_by_name,
      p_reason          => 'Special Order ' || v_number,
      p_remarks         => v_note
    );

    -- 2. Delivered: out of Production Stock, to the branch that ordered it.
    perform public.apply_production_stock_movement(
      p_product_id      => r.product_id,
      p_product_name    => r.item_name,
      p_delta           => -r.qty,
      p_type            => 'transfer_out',
      p_ref_id          => v_ref,
      p_business_date   => p_business_date,
      p_branch_id       => v_branch,
      p_created_by      => p_by,
      p_created_by_name => p_by_name,
      p_reason          => 'Special Order ' || v_number,
      p_remarks         => v_note
    );

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta
     where ref_id = v_ref and product_id = r.product_id and type in ('prepare', 'transfer_out');

    -- The 'prepare' row is the one the item points at: it is the stock ADDITION.
    select id, transaction_no into v_move_id, v_txn
      from production_stock_history
     where ref_id = v_ref and product_id = r.product_id and type = 'prepare';

    -- 3. Received: into the ordering branch's stock.
    perform public.apply_stock_movement(
      p_branch_id     => v_branch,
      p_product_id    => r.product_id,
      p_product_name  => r.item_name,
      p_delta         => r.qty,
      p_type          => 'production',
      p_ref_id        => v_ref,
      p_business_date => p_business_date
    );

    update special_order_items
       set stock_movement_id = v_move_id, stock_transaction_no = v_txn
     where id = r.id;

    v_moves := v_moves || jsonb_build_object(
      'itemId', r.id, 'productId', r.product_id, 'itemName', r.item_name,
      'qty', r.qty, 'stockMovementId', v_move_id, 'stockTransactionNo', v_txn);
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch, 'orderNumber', v_number, 'movements', v_moves);
end;
$$;

revoke all on function public.approve_special_order(uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function public.approve_special_order(uuid, uuid, text, date) to service_role;
