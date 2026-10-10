-- 145: a Special Order's stock follows the goods — Production Stock when it is
-- PREPARED, Branch Stock when the branch VERIFIES it.
--
-- Migrations 143/144 booked everything at one late step (Production's approval,
-- after branch verification). That was one transaction too few places: the item
-- sat in nobody's stock while Production held it, and the branch — which had
-- already confirmed it with a photo — waited on a second Production action
-- before it could sell what was on its own counter.
--
-- The lifecycle is now three states, each with exactly one stock event or none:
--
--   pending               branch raised it                 — no stock
--   awaiting_verification Production PREPARED it           — Production Stock +prepared
--   approved              branch VERIFIED & APPROVED it,   — Production Stock −verified
--                         with its photo                     Branch Stock     +verified
--
-- ONE addition per stock location. Production Stock gets its `+` once, at
-- preparation; Branch Stock gets its `+` once, at verification. The `−` on
-- Production Stock at verification is not a second entry for the same units, it
-- is the same units leaving: a delivered demand books exactly this pair
-- (`transfer_out` / `production`), through the same two functions. Without it the
-- item would be counted in both places at once.
--
-- Nobody types a quantity into stock. Both movements are written by the step
-- that causes them, keyed `<SO number>/<line>` in ledgers that are UNIQUE on
-- (ref_id, product_id, type), so neither can be booked twice — by a retry, a
-- double tap, or a caller that got past the status check.
--
-- THREE QUANTITIES, kept apart and never overwritten into one another:
--   qty           what the branch requested
--   prepared_qty  what Production made      (may be less)
--   verified_qty  what the branch received  (never more than prepared)
--
-- 'verified' is no longer produced. Orders already sitting in it (verified under
-- 143, waiting on the old Production approval) still finish through
-- approve_special_order from migration 144, which is left exactly as it was.
-- ---------------------------------------------------------------------------

alter table special_order_items
  add column if not exists prepared_qty numeric(14,3) check (prepared_qty >= 0),
  add column if not exists verified_qty numeric(14,3) check (verified_qty >= 0);

comment on column special_order_items.prepared_qty is
  'What Production actually prepared — the quantity added to Production Stock. NULL until prepared. Never written over qty.';
comment on column special_order_items.verified_qty is
  'What the branch confirmed receiving — the quantity added to Branch Stock. NULL until verified. Never more than prepared_qty.';


-- ═══ The business date, when a caller does not pass one ══════════════════════
-- The day runs 02:00 → 02:00 Karachi (see production-ledger.service.ts), the
-- same rule businessDateStr() applies in the API.
create or replace function app.karachi_business_date()
returns date
language sql
stable
as $fn$
  select ((now() at time zone 'Asia/Karachi') - interval '2 hours')::date;
$fn$;


-- ═══ create_special_order — one hidden product PER LINE, priced for the till ══
--
-- Migration 143 shared one hidden product between every order that used the same
-- item name. That cannot carry a sale: two branches ordering "Custom Cake" at
-- different amounts would share one price and one stock identity, and a sale
-- could not be traced to the order it came from.
--
-- Each line now gets its own hidden product, named `<item> — <SO number>/<line>`,
-- so branch stock, the till and every sale point at exactly one Special Order
-- line. Its price is the AGREED AMOUNT ÷ REQUESTED QUANTITY — what one unit of
-- this order sells for at the till. That price lives only on this order's own
-- hidden product: no catalogue product, no price-list entry and no other order
-- is touched, and it is never recalculated afterwards.
--
-- `amount` itself is stored on the line exactly as entered and stays the record.
create or replace function public.create_special_order(
  p_branch_id       uuid,
  p_branch_name     text,
  p_business_date   date,
  p_created_by      uuid,
  p_created_by_name text,
  p_items           jsonb,
  p_required_date   date default null
)
returns jsonb
language plpgsql
as $$
declare
  v_id      uuid;
  v_number  text;
  v_name    text;
  v_qty     numeric;
  v_amount  numeric;
  v_product uuid;
  v_item_id uuid;
  v_items   jsonb := '[]'::jsonb;
  r         record;
begin
  if p_branch_id is null then
    return jsonb_build_object('status', 'invalid', 'error', 'No branch assigned to this account');
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'A Special Order needs at least one item.');
  end if;

  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) loop
    if btrim(coalesce(r.o->>'name', '')) = '' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the item name.');
    end if;
    if jsonb_typeof(r.o->'qty') is distinct from 'number' or (r.o->>'qty')::numeric <= 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter quantity.');
    end if;
    if jsonb_typeof(r.o->'amount') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the Special Order amount.');
    end if;
    if (r.o->>'amount')::numeric < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'The Special Order amount cannot be negative.');
    end if;
  end loop;

  insert into special_orders (branch_id, branch_name, business_date, required_date, status, created_by, created_by_name)
  values (p_branch_id, p_branch_name, p_business_date, p_required_date, 'pending', p_created_by, p_created_by_name)
  returning id, order_number into v_id, v_number;

  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) order by ord loop
    v_name   := btrim(r.o->>'name');
    v_qty    := (r.o->>'qty')::numeric;
    v_amount := (r.o->>'amount')::numeric;

    insert into products (name, price, is_active, is_special)
    values (v_name || ' — ' || v_number || '/' || r.ord, round(v_amount / v_qty, 2), true, true)
    returning id into v_product;

    insert into special_order_items (special_order_id, product_id, item_name, qty, amount, description, line_no)
    values (v_id, v_product, v_name, v_qty, v_amount, btrim(coalesce(r.o->>'description', '')), r.ord::integer)
    returning id into v_item_id;

    v_items := v_items || jsonb_build_object('id', v_item_id, 'lineNo', r.ord::integer);
  end loop;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'orderNumber', v_number, 'items', v_items);
end;
$$;

-- Orders raised under 143 share a zero-priced product. Give each the price its
-- own order agreed, so it can be sold once it reaches branch stock. Touches
-- hidden special products only, and only ones still at 0.
update products p
   set price = x.unit_price
  from (
    select distinct on (i.product_id) i.product_id, round(i.amount / i.qty, 2) as unit_price
      from special_order_items i
      join special_orders o on o.id = i.special_order_id
     order by i.product_id, o.submitted_at desc
  ) x
 where p.id = x.product_id and p.is_special and coalesce(p.price, 0) = 0;


-- ═══ prepare_special_order — Production prepares it; Production Stock +prepared ═
--
-- p_items: [{"itemId": uuid, "preparedQty": numeric}] — optional. An item not
-- listed is prepared in full (its requested qty). The amount is not an input:
-- Production cannot change what the branch agreed.
--
-- The old 3-argument form is dropped rather than left beside this one — two
-- functions of one name with overlapping defaults make every call ambiguous.
-- The two new parameters are defaulted, so the 3-argument call still resolves.
drop function if exists public.prepare_special_order(uuid, uuid, text);

create or replace function public.prepare_special_order(
  p_order_id      uuid,
  p_by            uuid,
  p_by_name       text,
  p_items         jsonb default '[]'::jsonb,
  p_business_date date  default null
)
returns jsonb
language plpgsql
as $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_date        date := coalesce(p_business_date, app.karachi_business_date());
  v_prepared    numeric;
  v_any         boolean := false;
  v_ref         text;
  v_move_id     uuid;
  v_txn         text;
  r             record;
begin
  select branch_id, branch_name, order_number, status
    into v_branch, v_branch_name, v_number, v_status
    from special_orders where id = p_order_id
     for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_status <> 'pending' then
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  -- Validate every quantity before writing anything.
  for r in
    select i.id, i.qty,
           (select (o->>'preparedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
  loop
    v_prepared := coalesce(r.wanted, r.qty);
    if v_prepared < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Prepared quantity cannot be negative.');
    end if;
    if v_prepared > 0 then v_any := true; end if;
  end loop;
  if not v_any then
    return jsonb_build_object('status', 'invalid', 'error', 'Enter the quantity prepared for at least one item.');
  end if;

  update special_orders
     set status = 'awaiting_verification', prepared_by = p_by, prepared_by_name = p_by_name, prepared_at = now()
   where id = p_order_id;

  -- product_id order: migration 04's lock-ordering invariant for pool rows.
  for r in
    select i.id, i.product_id, i.item_name, i.qty, i.line_no,
           (select (o->>'preparedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
     order by i.product_id, i.line_no
  loop
    v_prepared := coalesce(r.wanted, r.qty);
    v_ref      := v_number || '/' || r.line_no;
    v_move_id  := null;
    v_txn      := null;

    if v_prepared > 0 then
      perform public.apply_production_stock_movement(
        p_product_id      => r.product_id,
        p_product_name    => r.item_name,
        p_delta           => v_prepared,
        p_type            => 'prepare',
        p_ref_id          => v_ref,
        p_business_date   => v_date,
        p_branch_id       => v_branch,
        p_created_by      => p_by,
        p_created_by_name => p_by_name,
        p_reason          => 'Special Order ' || v_number,
        p_remarks         => 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '')
      );

      update production_stock_history
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'source', 'special_order', 'specialOrderId', p_order_id,
               'specialOrderNumber', v_number, 'specialOrderItemId', r.id)
       where ref_id = v_ref and product_id = r.product_id and type = 'prepare'
      returning id, transaction_no into v_move_id, v_txn;
    end if;

    update special_order_items
       set prepared_qty = v_prepared, stock_movement_id = v_move_id, stock_transaction_no = v_txn
     where id = r.id;
  end loop;

  return jsonb_build_object('status', 'ok', 'branchId', v_branch, 'orderNumber', v_number);
end;
$$;


-- ═══ verify_special_order — the branch's VERIFY & APPROVE; Branch Stock +verified
--
-- p_items: [{"itemId": uuid, "receivedQty": numeric}] — optional. An item not
-- listed is received in full (its prepared qty).
--
-- One transaction: validate → mark approved → move the stock. Nothing is
-- half-done on a failure, and a repeat (a second tap on a slow connection, a
-- queued retry) finds the order already approved and answers
-- 'already_verified' without touching a ledger.
drop function if exists public.verify_special_order(uuid, uuid, uuid, text);

create or replace function public.verify_special_order(
  p_order_id      uuid,
  p_branch_id     uuid,
  p_by            uuid,
  p_by_name       text,
  p_items         jsonb default '[]'::jsonb,
  p_business_date date  default null
)
returns jsonb
language plpgsql
as $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_date        date := coalesce(p_business_date, app.karachi_business_date());
  v_prepared    numeric;
  v_verified    numeric;
  v_ref         text;
  v_note        text;
  v_meta        jsonb;
  v_moves       jsonb := '[]'::jsonb;
  r             record;
begin
  select branch_id, branch_name, status, order_number
    into v_branch, v_branch_name, v_status, v_number
    from special_orders where id = p_order_id
     for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_branch_id is null or v_branch <> p_branch_id then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_status = 'approved' then
    return jsonb_build_object('status', 'already_verified', 'orderNumber', v_number);
  end if;
  if v_status <> 'awaiting_verification' then
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;
  if not exists (
    select 1 from attachments
     where entity = 'special_order_verification' and entity_id = p_order_id
  ) then
    return jsonb_build_object('status', 'photo_required');
  end if;

  -- Validate every quantity before writing anything.
  for r in
    select i.id, i.item_name, coalesce(i.prepared_qty, i.qty) as prepared,
           (select (o->>'receivedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
  loop
    v_verified := coalesce(r.wanted, r.prepared);
    if v_verified < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Received quantity cannot be negative.');
    end if;
    if v_verified > r.prepared then
      return jsonb_build_object('status', 'invalid', 'error',
        'Received quantity for ' || r.item_name || ' cannot be more than the ' || trim(to_char(r.prepared, 'FM999999990.###'), '.') || ' prepared.');
    end if;
  end loop;

  update special_orders
     set status = 'approved',
         verified_by = p_by, verified_by_name = p_by_name, verified_at = now(),
         approved_by = p_by, approved_by_name = p_by_name, approved_at = now(),
         stock_added_at = now()
   where id = p_order_id;

  v_note := 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '');

  for r in
    select i.id, i.product_id, i.item_name, i.qty, i.line_no, i.prepared_qty,
           (select (o->>'receivedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
     order by i.product_id, i.line_no
  loop
    v_ref  := v_number || '/' || r.line_no;
    v_meta := jsonb_build_object(
      'source', 'special_order', 'specialOrderId', p_order_id,
      'specialOrderNumber', v_number, 'specialOrderItemId', r.id);

    -- An order prepared before this migration was never booked into Production
    -- Stock. Book it now, in full, so the transfer below has units to move —
    -- the unique ledger key makes this a no-op for anything already booked.
    if r.prepared_qty is null then
      perform public.apply_production_stock_movement(
        p_product_id => r.product_id, p_product_name => r.item_name, p_delta => r.qty,
        p_type => 'prepare', p_ref_id => v_ref, p_business_date => v_date,
        p_branch_id => v_branch, p_created_by => p_by, p_created_by_name => p_by_name,
        p_reason => 'Special Order ' || v_number, p_remarks => v_note);
      update special_order_items set prepared_qty = r.qty where id = r.id;
      v_prepared := r.qty;
    else
      v_prepared := r.prepared_qty;
    end if;

    v_verified := coalesce(r.wanted, v_prepared);

    if v_verified > 0 then
      -- Out of Production Stock …
      perform public.apply_production_stock_movement(
        p_product_id      => r.product_id,
        p_product_name    => r.item_name,
        p_delta           => -v_verified,
        p_type            => 'transfer_out',
        p_ref_id          => v_ref,
        p_business_date   => v_date,
        p_branch_id       => v_branch,
        p_created_by      => p_by,
        p_created_by_name => p_by_name,
        p_reason          => 'Special Order ' || v_number,
        p_remarks         => v_note
      );

      -- … and into the branch's own stock, where it is sold from.
      perform public.apply_stock_movement(
        p_branch_id     => v_branch,
        p_product_id    => r.product_id,
        p_product_name  => r.item_name,
        p_delta         => v_verified,
        p_type          => 'production',
        p_ref_id        => v_ref,
        p_business_date => v_date
      );
    end if;

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta
     where ref_id = v_ref and product_id = r.product_id and type in ('prepare', 'transfer_out');

    update special_order_items set verified_qty = v_verified where id = r.id;

    v_moves := v_moves || jsonb_build_object(
      'itemId', r.id, 'itemName', r.item_name, 'requestedQty', r.qty,
      'preparedQty', v_prepared, 'verifiedQty', v_verified, 'stockRef', v_ref);
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch, 'orderNumber', v_number, 'movements', v_moves);
end;
$$;


revoke all on function public.create_special_order(uuid, text, date, uuid, text, jsonb, date) from public, anon, authenticated;
revoke all on function public.prepare_special_order(uuid, uuid, text, jsonb, date)           from public, anon, authenticated;
revoke all on function public.verify_special_order(uuid, uuid, uuid, text, jsonb, date)      from public, anon, authenticated;
grant execute on function public.create_special_order(uuid, text, date, uuid, text, jsonb, date) to service_role;
grant execute on function public.prepare_special_order(uuid, uuid, text, jsonb, date)           to service_role;
grant execute on function public.verify_special_order(uuid, uuid, uuid, text, jsonb, date)      to service_role;
