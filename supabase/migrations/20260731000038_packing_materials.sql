-- 38: packing materials catalogue.
--
-- Company service items — shoppers, boxes, spoons, writing cream — that go out WITH
-- a branch's daily demand. Deliberately a table of its own rather than rows in
-- `products`, for two reasons:
--
--   1. They have NO selling price and NO cost price. Sharing `products` would mean
--      carrying price/cost_price columns that must be nulled and then excluded from
--      every price import, price-history trigger and POS product picker.
--   2. They are never saleable. Keeping them out of `products` means the POS, price
--      list, stock and sales reports cannot accidentally surface them — no filter to
--      remember and no filter to forget.
--
-- `category` is plain text on purpose: reusing the shared `categories` table would
-- put packing categories into the bakery category dropdowns and vice versa.
--
-- STOCK-READY, NOT STOCK-TRACKED. There is deliberately no balance column here. A
-- future packing_material_stock / packing_material_stock_history pair can mirror the
-- production pool exactly (migrations 05 and 15) — the id on this table is the key
-- those would hang off, which is why order lines reference packing_material_id
-- rather than a name.
--
-- The field list this was specified from said `status`; it is modelled as
-- `is_active boolean` to match products/branches and the existing Enable/Disable UI.

create table packing_materials (
  id            uuid primary key default gen_random_uuid(),
  material_code text not null unique,
  material_name text not null,
  category      text,
  description   text,
  is_active     boolean not null default true,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Mirrors products_active_name_idx: the branch dropdown reads active rows by name.
create index packing_materials_active_name_idx on packing_materials (material_name) where is_active;

create trigger packing_materials_touch before update on packing_materials
  for each row execute function app.touch_updated_at();

-- The API uses the service-role key and bypasses RLS (authorization is enforced in
-- application code), but every table carries policies for consistency — same shape
-- as products_select in migration 09.
alter table packing_materials enable row level security;

create policy packing_materials_select on packing_materials
  for select to authenticated using (is_active or app.is_super_admin());

-- ---------------------------------------------------------------------------
-- Default catalogue. `on conflict (material_code) do nothing` makes a re-run a
-- no-op and, more importantly, means this never overwrites a name an admin has
-- since edited.
-- ---------------------------------------------------------------------------
insert into packing_materials (material_code, material_name, category) values
  ('PACK-001', 'Small Shopper (10 × 13)',              'Shoppers'),
  ('PACK-002', 'Large Shopper (12 × 15)',              'Shoppers'),
  ('PACK-003', '1 Pound Shopper',                      'Shoppers'),
  ('PACK-004', '2 Pound Shopper',                      'Shoppers'),
  ('PACK-005', '2 Pastry Box',                         'Boxes'),
  ('PACK-006', '3 Pastry Box',                         'Boxes'),
  ('PACK-007', 'Bento Box',                            'Boxes'),
  ('PACK-008', '1 Pound Cake Box',                     'Boxes'),
  ('PACK-009', '2 Pound Cake Box',                     'Boxes'),
  ('PACK-010', 'Plastic Spoon Packet',                 'Consumables'),
  ('PACK-011', 'Cake Writing Cream (Various Colours)', 'Consumables')
on conflict (material_code) do nothing;
