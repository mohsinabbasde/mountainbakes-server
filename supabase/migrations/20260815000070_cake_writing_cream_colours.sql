-- 70: split the cake writing cream into per-colour materials.
--
-- 'Cake Writing Cream (Various Colours)' (PACK-011, seeded in 38 and re-seeded in
-- 47) was one line for every colour, so a branch asking for red and a branch
-- asking for black looked identical on the slip and in the usage report. Replaced
-- by four rows: Red, White, Black, and an Any Colour catch-all for when the branch
-- genuinely does not mind which goes out.
--
-- PACK-011 is DISABLED, not deleted. Two reasons:
--
--   1. production_order_packing_items.packing_material_id is `on delete set null`,
--      and PackingUsageReport groups by that id — deleting the row would silently
--      drop every past cream request out of the report. (The printed slip is safe
--      either way: material_name is a snapshot on the line, per migration 39.)
--   2. is_active=false is already how "no longer orderable" is expressed. The
--      catalogue GET filters to active rows for every role except super_admin, so
--      disabling is what removes it from the branch demand dropdown — no code
--      change needed here.
--
-- Guarded on the name so this does not disable a PACK-011 an admin has since
-- repurposed to something else entirely.

update packing_materials
   set is_active = false
 where material_code = 'PACK-011'
   and material_name = 'Cake Writing Cream (Various Colours)';

-- Fresh codes rather than reusing PACK-011 for red: the code is what the usage
-- report joins on, and a reused code would fold the old undifferentiated history
-- into the red line. Ordering is by material_code, so these follow PACK-011.
--
-- `on conflict (material_code) do nothing` for the same reason as migration 47:
-- a re-run must not overwrite a name an admin has edited or re-enable one they
-- deliberately disabled.
insert into packing_materials (material_code, material_name, category) values
  ('PACK-012', 'Cake Writing Cream (Red)',        'Consumables'),
  ('PACK-013', 'Cake Writing Cream (White)',      'Consumables'),
  ('PACK-014', 'Cake Writing Cream (Black)',      'Consumables'),
  ('PACK-015', 'Cake Writing Cream (Any Colour)', 'Consumables')
on conflict (material_code) do nothing;
