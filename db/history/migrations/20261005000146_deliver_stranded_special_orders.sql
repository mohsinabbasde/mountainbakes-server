-- 146: deliver Special Orders that were approved but never reached branch stock.
--
-- Migration 143's approval booked `+qty` into Production Stock and stopped.
-- Migration 144 added the delivery to the branch a few minutes later — but any
-- order approved in between (SO-000001 was) is 'approved', shows as finished,
-- and sits in the central pool with nothing in the branch's stock. Nothing else
-- will ever move it: every step of the workflow only acts on an order that is
-- not yet approved.
--
-- For each line of an approved order that has no branch stock movement, this
-- books the two movements the approval should have made — out of Production
-- Stock, into the ordering branch — under the line's own `<SO number>/<line>`
-- reference, and records the quantities.
--
-- SAFE TO RE-RUN, and safe against orders that were delivered properly: a line
-- is selected only when the branch ledger holds no movement under its
-- reference, and both ledgers are UNIQUE on (ref_id, product_id, type), so a
-- second run finds nothing and could not double-book if it did.
do $$
declare
  v_date date := app.karachi_business_date();
  v_ref  text;
  v_note text;
  r      record;
begin
  for r in
    select o.id as order_id, o.order_number, o.branch_id, o.branch_name,
           o.approved_by, o.approved_by_name,
           i.id as item_id, i.product_id, i.item_name, i.qty, i.line_no
      from special_orders o
      join special_order_items i on i.special_order_id = o.id
     where o.status = 'approved'
       and i.verified_qty is null
       and not exists (
         select 1 from stock_history h
          where h.ref_id = o.order_number || '/' || i.line_no
            and h.product_id = i.product_id
            and h.type = 'production')
     order by i.product_id, i.line_no
  loop
    v_ref  := r.order_number || '/' || r.line_no;
    v_note := 'Special Order ' || r.order_number || coalesce(' — ' || nullif(r.branch_name, ''), '');

    -- A no-op where the approval already booked it; the booking where it did not.
    perform public.apply_production_stock_movement(
      p_product_id => r.product_id, p_product_name => r.item_name, p_delta => r.qty,
      p_type => 'prepare', p_ref_id => v_ref, p_business_date => v_date,
      p_branch_id => r.branch_id, p_created_by => r.approved_by, p_created_by_name => r.approved_by_name,
      p_reason => 'Special Order ' || r.order_number, p_remarks => v_note);

    perform public.apply_production_stock_movement(
      p_product_id => r.product_id, p_product_name => r.item_name, p_delta => -r.qty,
      p_type => 'transfer_out', p_ref_id => v_ref, p_business_date => v_date,
      p_branch_id => r.branch_id, p_created_by => r.approved_by, p_created_by_name => r.approved_by_name,
      p_reason => 'Special Order ' || r.order_number,
      p_remarks => v_note || ' (delivery booked by migration 146)');

    perform public.apply_stock_movement(
      p_branch_id => r.branch_id, p_product_id => r.product_id, p_product_name => r.item_name,
      p_delta => r.qty, p_type => 'production', p_ref_id => v_ref, p_business_date => v_date);

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'source', 'special_order', 'specialOrderId', r.order_id,
             'specialOrderNumber', r.order_number, 'specialOrderItemId', r.item_id)
     where ref_id = v_ref and product_id = r.product_id and type in ('prepare', 'transfer_out');

    update special_order_items
       set prepared_qty = coalesce(prepared_qty, r.qty), verified_qty = r.qty
     where id = r.item_id;
  end loop;
end $$;
