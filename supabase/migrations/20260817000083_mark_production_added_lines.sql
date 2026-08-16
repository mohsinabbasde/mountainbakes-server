-- 83: tell a line the BRANCH demanded from one somebody added.
--
-- production_order_items.qty is the branch's demand. Two paths were writing a
-- quantity nobody demanded into it:
--
--   * POST /api/production-orders/:id/items — Production adding a line to a
--     pending demand, writing its own figure into qty.
--   * verify_production_order's p_new_items — goods that turned up in the
--     delivery without being asked for, writing the arrived quantity into qty
--     AND approved_qty.
--
-- Everything downstream reads qty as "what the branch asked for", so an added
-- line came out with Demand equal to Approved, the review screen's "changed"
-- flag stayed false because approved == demand, and the Demand total counted
-- quantities the branch never requested. That last one is why the totals on a
-- reviewed demand did not agree with what the branch actually sent.
--
-- Reducing a line was never affected: review_production_order writes only
-- approved_qty and has never touched qty.
--
-- ── WHY A FLAG AND NOT qty = 0 ──────────────────────────────────────────────
--
-- Storing qty = 0 on an added line is the strictly correct data model, and it
-- is deliberately NOT what this does. The web app is a static-export PWA, so a
-- Production tab still running the previous bundle would compute that line's
-- default approval from qty, get 0, and submit it — silently approving at zero
-- a line somebody had just added, and not shipping it. Approval drives the
-- stock movement, so that failure costs real goods.
--
-- The flag changes nothing about approval: qty keeps carrying Production's
-- intended quantity and remains the approval default, so an old bundle behaves
-- exactly as it does today. Only the DISPLAY of demand changes, which is what
-- was actually wrong.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- Lines added at verification are recoverable: the function stamps them
-- remarks = 'Added at verification', which nothing else writes. Those are
-- backfilled.
--
-- Lines added by Production before review are NOT recoverable — they carry no
-- marker, and there is no way to tell one from a line the branch genuinely
-- demanded. They stay false and keep reading as branch demand, which is what
-- they have always done. Nothing is invented to paper over that.
-- ---------------------------------------------------------------------------
alter table production_order_items
  add column if not exists added_by_production boolean not null default false;

comment on column production_order_items.added_by_production is
  'True when this line was added by Production or found at verification rather than demanded by the branch. Its qty still carries the intended quantity and is still the approval default; this only tells the screens not to report that quantity as branch demand.';

-- Only the verification path can be identified retrospectively; see header.
update production_order_items
   set added_by_production = true
 where remarks = 'Added at verification'
   and added_by_production = false;

-- Recreated verbatim from migration 74 with one change: the p_new_items insert
-- now stamps added_by_production. Extracted from that file programmatically
-- rather than retyped, so the rest of the body is byte-identical.

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
        previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no,
        added_by_production
      ) values (
        p_order_id, r.product_id::uuid, r.product_name, r.qty, 'Added at verification',
        0, r.qty, r.qty, 0, v_max_line,
        -- Nobody demanded this line: it turned up in the delivery. Flagged so the
        -- review screen reads its Demand as '-' instead of quoting the arrived
        -- quantity back as though the branch had asked for it.
        true
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
