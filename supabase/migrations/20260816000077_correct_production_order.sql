-- 77: let the Support Center correct a demand's lines.
--
-- Until now a 'demand' reference was readOnly: the Help Desk could raise a query
-- against DMD-######, and the admin could read it and write a note, but could not
-- change anything. Every other reference type (sale, expense, branch stock, pool
-- stock) has had a live correction path for several migrations. This closes that
-- gap.
--
-- ── WHY THE STATUS COLUMN CANNOT DECIDE THIS ────────────────────────────────
--
-- The obvious implementation gates on production_orders.status: "if it is not yet
-- verified, nothing has moved; if it is verified, reconcile the difference."
-- That is WRONG on this schema, and quietly so.
--
-- The real lifecycle is:
--
--   pending -> awaiting_verification -> [branch verifies] -> 'verified'
--                                    -> [Production's final approval] -> 'approved'
--
-- Verification is what moves stock (verify_production_order returns the final
-- lines and the route applies transfer_out + production). But Production's final
-- approval then flips the status BACK to 'approved'. So a delivered order and an
-- approved-but-never-delivered order both read status = 'approved'. Live data on
-- 2026-08-16: DMD-000037 is status='approved' with verified_at set and approved_at
-- ~57 minutes LATER, and its id is the ref_id on 31 stock_history rows totalling
-- 168 units. Meanwhile DMD-000015/16/17 are also 'approved' and never moved a
-- unit. Exactly one order in the whole table sits in 'verified' at any moment.
--
-- verified_at is closer, but still a proxy, and it does not describe orders from
-- before migration 58 (when approval, not verification, moved the stock).
--
-- So this function asks the LEDGER, which cannot be wrong:
--
--     exists (select 1 from stock_history
--              where ref_id = p_order_id::text and type = 'production')
--
-- That is true if and only if units were actually credited to the branch for this
-- order, whatever the status says and whichever era the order is from.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--
-- p_lines is the DESIRED FINAL STATE of the demand's product lines, the same
-- shape the Support Center's sale editor uses: lines absent from it are removed,
-- product ids not currently on the order are added, the rest are updated. Per
-- migration 74 every line is written fresh-demand-only -- previous_balance_qty
-- and remaining_balance_qty are pinned to 0 and total_required_qty tracks qty --
-- so a correction can never resurrect the carry-forward that migration deleted.
--
-- It returns the per-product delta in APPROVED quantity and does NOT move stock
-- itself. The caller applies those deltas to branch stock and to the production
-- pool, exactly as the verification route already does with this function's
-- sibling verify_production_order. Two reasons that split is right here:
--
--   * The pool and the branch ledger have separate movement functions
--     (apply_production_stock_movement / apply_stock_movement), each with its own
--     idempotency key. Reimplementing either inline would duplicate rules that
--     already exist in one place.
--   * The compensating movements MUST carry a fresh ref_id. Both ledgers are
--     idempotent on (ref_id, product_id, type) and the original movements are
--     keyed on the bare order id, so re-using it would silently no-op the
--     correction rather than apply it. The route mints '<order_id>:fix:<uuid>'.
--
-- When the ledger shows nothing moved, deltas come back empty: the line edit is
-- all that is needed, because verification has not happened yet and will move
-- whatever approved_qty then says.

create or replace function public.correct_production_order(
  p_order_id   uuid,
  p_lines      jsonb,   -- [{productId, productName, qty, approvedQty}] -- FINAL state
  p_reason     text,
  p_actor_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_branch_id    uuid;
  v_branch_name  text;
  v_status       branch_production_order_status;
  v_stock_moved  boolean;
  v_max_line     integer;
  v_before       jsonb;
  v_after        jsonb;
  v_deltas       jsonb;
begin
  -- Lock the order for the whole correction: a concurrent review or verification
  -- of the same order would otherwise interleave with the rewrite below.
  select branch_id, branch_name, status
    into v_branch_id, v_branch_name, v_status
    from production_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A rejected or cancelled demand was never a commitment to anything and moved
  -- no stock. Editing its lines would produce a document that claims otherwise.
  if v_status in ('rejected', 'cancelled') then
    return jsonb_build_object('status', 'not_correctable', 'orderStatus', v_status);
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('status', 'empty');
  end if;

  select exists (
           select 1 from stock_history
            where ref_id = p_order_id::text
              and type   = 'production'
         )
    into v_stock_moved;

  select coalesce(jsonb_agg(jsonb_build_object(
           'productId',   product_id,
           'productName', product_name,
           'qty',         qty,
           'approvedQty', coalesce(approved_qty, 0)
         ) order by line_no), '[]'::jsonb)
    into v_before
    from production_order_items
   where production_order_id = p_order_id;

  -- ── The per-product change in APPROVED quantity ───────────────────────────
  -- A full outer join so a line only in p_lines (added) and a line only on the
  -- order (removed) both produce a delta. Zero-deltas are filtered out so the
  -- caller moves nothing for an untouched line.
  with newl as (
    select (l->>'productId')::uuid                    as product_id,
           nullif(trim(l->>'productName'), '')        as product_name,
           coalesce((l->>'qty')::numeric, 0)          as qty,
           coalesce((l->>'approvedQty')::numeric, 0)  as approved_qty
      from jsonb_array_elements(p_lines) l
  ),
  oldl as (
    select product_id, product_name, coalesce(approved_qty, 0) as approved_qty
      from production_order_items
     where production_order_id = p_order_id
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'productId',   coalesce(n.product_id, o.product_id),
             'productName', coalesce(n.product_name, o.product_name),
             'delta',       coalesce(n.approved_qty, 0) - coalesce(o.approved_qty, 0)
           )) filter (where coalesce(n.approved_qty, 0) - coalesce(o.approved_qty, 0) <> 0),
           '[]'::jsonb)
    into v_deltas
    from newl n
    full outer join oldl o on o.product_id = n.product_id;

  -- ── Rewrite the lines: remove, update, add ────────────────────────────────
  delete from production_order_items i
   where i.production_order_id = p_order_id
     and not exists (
           select 1 from jsonb_array_elements(p_lines) l
            where (l->>'productId')::uuid = i.product_id
         );

  update production_order_items i
     set qty                   = n.qty,
         product_name          = coalesce(n.product_name, i.product_name),
         -- Migration 74's invariants, restated on every corrected line so a
         -- correction can never reintroduce a carry-forward.
         previous_balance_qty  = 0,
         total_required_qty    = n.qty,
         approved_qty          = n.approved_qty,
         remaining_balance_qty = 0
    from (
      select (l->>'productId')::uuid                   as product_id,
             nullif(trim(l->>'productName'), '')       as product_name,
             coalesce((l->>'qty')::numeric, 0)         as qty,
             coalesce((l->>'approvedQty')::numeric, 0) as approved_qty
        from jsonb_array_elements(p_lines) l
    ) n
   where i.production_order_id = p_order_id
     and i.product_id = n.product_id;

  select coalesce(max(line_no), 0) into v_max_line
    from production_order_items where production_order_id = p_order_id;

  insert into production_order_items (
    production_order_id, product_id, product_name, qty, remarks,
    previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
  )
  select p_order_id,
         n.product_id,
         coalesce(n.product_name, 'Unknown product'),
         n.qty,
         'Added by Support Center',
         0, n.qty, n.approved_qty, 0,
         v_max_line + row_number() over (order by n.product_name, n.product_id)
    from (
      select (l->>'productId')::uuid                   as product_id,
             nullif(trim(l->>'productName'), '')       as product_name,
             coalesce((l->>'qty')::numeric, 0)         as qty,
             coalesce((l->>'approvedQty')::numeric, 0) as approved_qty
        from jsonb_array_elements(p_lines) l
    ) n
   where not exists (
           select 1 from production_order_items i
            where i.production_order_id = p_order_id
              and i.product_id = n.product_id
         );

  update production_orders
     set was_changed   = true,
         change_reason = left(
           coalesce(nullif(trim(p_reason), ''), 'Corrected from the Support Center')
           || ' (Support Center' || coalesce(' — ' || nullif(trim(p_actor_name), ''), '') || ')',
           1000)
   where id = p_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'productId',   product_id,
           'productName', product_name,
           'qty',         qty,
           'approvedQty', coalesce(approved_qty, 0)
         ) order by line_no), '[]'::jsonb)
    into v_after
    from production_order_items
   where production_order_id = p_order_id;

  return jsonb_build_object(
    'status',      'ok',
    'branchId',    v_branch_id,
    'branchName',  v_branch_name,
    'orderStatus', v_status,
    -- The caller moves stock only when this is true. See the header.
    'stockMoved',  v_stock_moved,
    'deltas',      case when v_stock_moved then v_deltas else '[]'::jsonb end,
    'before',      v_before,
    'after',       v_after
  );
end;
$$;

revoke all on function public.correct_production_order(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.correct_production_order(uuid, jsonb, text, text) to service_role;
