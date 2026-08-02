-- 47: re-seed the default packing-material catalogue.
--
-- Migration 38 created `packing_materials` and shipped this same seed, but the
-- catalogue came up empty in production — the table and its indexes exist, the
-- rows do not. Without rows the branch demand form renders the Packing Materials
-- panel with an empty dropdown, which reads as "the feature did not deploy".
--
-- Kept as its own migration rather than editing 38: an already-applied migration
-- must never change, or the two environments stop describing the same history.
--
-- `on conflict (material_code) do nothing` is what makes this safe to run more
-- than once, and — the reason it matters here — means it will not overwrite a
-- name an admin has since edited or re-enable one they deliberately disabled.
-- Adding a material is an additive fix; re-activating one is an admin decision.

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
