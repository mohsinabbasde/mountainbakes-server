-- 39: packing material lines on a branch demand.
--
-- The sibling of production_order_items. A branch may optionally attach packing
-- materials to its daily demand; they travel with the same production_order, are
-- reviewed in the same action, and print on the same slip as a separate table.
--
-- Two deliberate differences from production_order_items:
--
--   1. NO balance columns. Products carry unmet demand forward through
--      production_balances (migration 05's "ASSIGN, never increment" warning). An
--      unfilled shopper request is not a debt the factory owes — the branch simply
--      re-requests tomorrow — so there is no previous_balance_qty /
--      total_required_qty / remaining_balance_qty here, and review_production_order
--      must not touch production_balances for these rows.
--
--   2. UNIQUE (production_order_id, packing_material_id). A duplicate packing line
--      is meaningless (it is one material and one quantity), so the rule is enforced
--      here rather than trusted to the form. The Zod schema rejects duplicates too;
--      this is the backstop for anything posting directly to the API.
--
-- material_name is a snapshot, exactly like production_order_items.product_name: a
-- renamed or deleted material must not rewrite what a historical slip said.

create table production_order_packing_items (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders (id) on delete cascade,
  packing_material_id uuid references packing_materials (id) on delete set null,
  material_name       text not null,
  qty                 numeric(14,3) not null,   -- as requested by the branch
  approved_qty        numeric(14,3),            -- populated only on approval
  line_no             integer not null,
  constraint production_order_packing_items_unique_material
    unique (production_order_id, packing_material_id)
);

create index production_order_packing_items_order_idx
  on production_order_packing_items (production_order_id, line_no);

-- Usage reporting joins these to orders by material; the report filters by material.
create index production_order_packing_items_material_idx
  on production_order_packing_items (packing_material_id);

alter table production_order_packing_items enable row level security;

-- Same shape as the order_items policy in migration 09: visibility follows the
-- parent order's branch.
create policy production_order_packing_items_select_branch on production_order_packing_items
  for select to authenticated
  using (
    exists (
      select 1 from production_orders o
      where o.id = production_order_packing_items.production_order_id
        and (app.is_super_admin() or o.branch_id = app.jwt_branch_id())
    )
  );
