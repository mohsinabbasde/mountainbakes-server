-- 82: let the Support Center DELETE a demand, reversing whatever it delivered.
--
-- Migration 77 gave the admin a line editor for a demand raised as a query. That
-- covers "these quantities are wrong". It does not cover the case this migration
-- exists for: a demand that was verified — and so CREDITED STOCK — when it should
-- never have been. There is no set of corrected lines that expresses "this
-- delivery did not happen"; removing every line is refused as `empty`, and
-- leaving one line at zero still leaves a document asserting a delivery.
--
-- ── WHY THE STATUS COLUMN CANNOT DECIDE THIS (still) ────────────────────────
--
-- Exactly as migration 77 explains at length: verification moves the stock, but
-- Production's final approval then flips the status BACK to 'approved', so a
-- delivered order and an approved-but-never-delivered order read identically.
-- This function therefore asks the LEDGER, which cannot be wrong, and it asks it
-- for the NET position rather than the original credit:
--
--     ref_id = <order_id>  OR  ref_id LIKE '<order_id>:%'
--
-- The bare id is the original delivery. The ':%' family is every compensating
-- movement already applied against this demand — migration 77's corrections mint
-- '<order_id>:fix:<ticket_id>'. Summing the family is what makes delete correct
-- on a demand that was ALREADY corrected once: reversing only the original credit
-- would leave that correction's adjustment stranded on the branch's balance.
--
-- ── WHY THIS ONE MOVES STOCK ITSELF, UNLIKE correct_production_order ────────
--
-- Migration 77 deliberately returns deltas and lets the route apply them. That
-- split is wrong HERE, and the difference is retryability.
--
-- A correction is retryable: if the route dies after the RPC, the ticket is still
-- 'open' and re-running recomputes the same deltas against a demand that still
-- exists. A delete is not. Once the order row is gone the deltas can never be
-- recomputed, so a crash between "deleted" and "stock reversed" would leave the
-- branch holding units credited by a demand that no longer exists, with no way to
-- discover the amount. So the reversal and the delete happen in ONE transaction,
-- by calling apply_stock_movement / apply_production_stock_movement in-place.
-- That is not duplicating their rules — it is invoking them.
--
-- Each ledger is reversed by ITS OWN net rather than mirroring the branch figure
-- onto the pool. They are separate ledgers with separate idempotency keys, and if
-- they have ever diverged, "return each to its pre-demand state" is the honest
-- reading of the instruction; mirroring one onto the other would silently import
-- the discrepancy.
--
-- ── WHAT SURVIVES ───────────────────────────────────────────────────────────
--
-- The order row, its items and its packing lines are physically deleted (both
-- child tables are ON DELETE CASCADE, migrations 05 and 39). What is deliberately
-- KEPT:
--
--   * stock_history / production_stock_history — both the original movements and
--     the reversals. These are append-only ledgers; deleting from them is how you
--     get balances that no longer explain themselves. The pair reads as
--     "delivered, then un-delivered", which is what actually happened.
--   * attachments — the table has no FK by design and migration 67 states that a
--     parent's deletion leaving the rows behind is intentional for the audit
--     trail. Same rule here rather than a special case for this one entity.
--   * audit_logs — a full jsonb snapshot of the demand, its lines and the exact
--     reversals, written BEFORE the delete. This is what makes the surviving
--     ledger rows explicable: without it a dangling ref_id is unattributable.
--
-- Reversals are keyed '<order_id>:del:<ticket_id>' so they can never collide with
-- the original delivery or with a migration-77 correction — both ledgers are
-- idempotent on (ref_id, product_id, type) and reusing an existing ref would
-- silently no-op the entire reversal.
create or replace function public.delete_production_order(
  p_order_id   uuid,
  p_reason     text,
  p_ref_id     text,   -- '<order_id>:del:<ticket_id>' — minted by the caller
  p_actor_id   uuid,
  p_actor_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_demand_number text;
  v_branch_id     uuid;
  v_branch_name   text;
  v_status        branch_production_order_status;
  v_business_date date;
  v_order         jsonb;
  v_items         jsonb;
  v_packing       jsonb;
  v_branch_rev    jsonb;
  v_pool_rev      jsonb;
  v_today         date;
  r               record;
begin
  -- Lock the order for the whole operation: a concurrent verification would
  -- otherwise credit stock between the sum below and the delete, and that credit
  -- would survive with nothing left to attribute it to.
  select demand_number, branch_id, branch_name, status, business_date
    into v_demand_number, v_branch_id, v_branch_name, v_status, v_business_date
    from production_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The business date drives the reversal's ledger row. Deliberately TODAY, not
  -- the demand's own date: the correction happens now, and back-dating it into a
  -- business day that may already be closed and snapshotted would change a figure
  -- that has been reported.
  v_today := (timezone('Asia/Karachi', now()))::date;

  -- ── Snapshot before anything is destroyed ─────────────────────────────────
  select to_jsonb(po) into v_order from production_orders po where po.id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.line_no), '[]'::jsonb)
    into v_items
    from production_order_items i
   where i.production_order_id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(pk) order by pk.line_no), '[]'::jsonb)
    into v_packing
    from production_order_packing_items pk
   where pk.production_order_id = p_order_id;

  -- ── Reverse the branch ledger ─────────────────────────────────────────────
  -- Net across the whole ref family (see header). A product whose net is already
  -- zero is skipped rather than written as a 0-delta row: a zero movement conveys
  -- nothing and would still consume the (ref_id, product_id, type) key.
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_branch_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
         and branch_id = v_branch_id
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_branch_rev) e
  loop
    perform public.apply_stock_movement(
      v_branch_id, r.product_id, r.product_name, r.delta,
      'adjustment'::stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Reverse the production pool ───────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_pool_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from production_stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_pool_rev) e
  loop
    perform public.apply_production_stock_movement(
      r.product_id, r.product_name, r.delta,
      'adjustment'::production_stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Record what is about to be destroyed ──────────────────────────────────
  -- Written before the delete so a failure anywhere below rolls this back with
  -- it: an audit row describing a demand that still exists would be worse than
  -- none at all.
  insert into audit_logs (action, admin_id, admin_name, details)
  values (
    'production_order_deleted',
    p_actor_id,
    p_actor_name,
    jsonb_build_object(
      'orderId',       p_order_id,
      'demandNumber',  v_demand_number,
      'branchId',      v_branch_id,
      'branchName',    v_branch_name,
      'status',        v_status::text,
      'businessDate',  v_business_date,
      'reason',        p_reason,
      'reversalRefId', p_ref_id,
      'reversedOn',    v_today,
      'order',         v_order,
      'items',         v_items,
      'packingItems',  v_packing,
      'branchReversals', v_branch_rev,
      'poolReversals',   v_pool_rev
    )
  );

  -- Cascades production_order_items and production_order_packing_items.
  delete from production_orders where id = p_order_id;

  return jsonb_build_object(
    'status',          'deleted',
    'demandNumber',    v_demand_number,
    'branchId',        v_branch_id,
    'branchName',      v_branch_name,
    'orderStatus',     v_status::text,
    'stockMoved',      jsonb_array_length(v_branch_rev) > 0 or jsonb_array_length(v_pool_rev) > 0,
    'branchReversals', v_branch_rev,
    'poolReversals',   v_pool_rev
  );
end;
$$;

comment on function public.delete_production_order(uuid, text, text, uuid, text) is
  'Hard-deletes a demand and reverses whatever it moved, in one transaction. Reversal amount comes from the NET of the ledger ref family (<id> plus <id>:%), so a demand already corrected by migration 77 reverses correctly. Keeps stock_history, production_stock_history and attachments; writes an audit_logs snapshot first.';
