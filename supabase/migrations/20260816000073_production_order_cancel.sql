-- 73: a branch can delete a demand it has just sent, with a mandatory reason.
--
-- SOFT delete, not a row removal. The demand is gone as work — it drops out of
-- Production's Demand Summary and out of every demand analytic — but the row
-- stays so both sides can see WHAT was withdrawn and WHY. A hard delete would
-- also cascade `production_order_items` away, taking the reason's context with
-- it, and leave the `demand_number` sequence with a hole nobody can account for.
--
-- Only a 'pending' demand may be cancelled. Once Production reviews it the order
-- is 'awaiting_verification' — goods are out of the door — and past verification
-- stock has already moved, so withdrawing it would leave branch stock claiming
-- goods against an order that no longer exists. That rule is enforced by the
-- check-and-set in the route (`.eq('status', 'pending')`), the same posture
-- review/final-approve take.

alter table production_orders
  add column if not exists cancel_reason    text,
  add column if not exists cancelled_by     uuid references users (id) on delete set null,
  add column if not exists cancelled_by_name text,
  add column if not exists cancelled_at     timestamptz;

comment on column production_orders.cancel_reason is
  'Why the branch withdrew this demand. Mandatory at cancellation; null on every other order.';

-- The branch history and Production's order list both read the last 7 business
-- days across every status, so no new index is needed for them —
-- production_orders_status_idx (status, business_date desc) already serves a
-- status-filtered scan, which is what the analytics exclusions use.
