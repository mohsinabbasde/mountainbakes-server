-- 70: rename the cake writing cream to "Writing Cream" and split it per colour.
--
-- 'Cake Writing Cream (Various Colours)' (PACK-011, seeded in 38 and re-seeded in
-- 47) was one line for every colour, so a branch asking for red and a branch
-- asking for black looked identical on the slip and in the usage report. Replaced
-- by four rows under the shorter name the branches actually use — Writing Cream —
-- one per colour, plus an Any Color catch-all for when the branch genuinely does
-- not mind which goes out.
--
-- No UI change goes with this. The Packing Materials panel on Create New
-- Production Order is already one row per material with its own quantity box
-- (NewOrderModal.tsx), and the dropdown drops a material once a row has taken it —
-- so four colours means four rows, each with its own qty, and no colour can be
-- ordered twice on one demand.
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
-- Its NAME is left as it was, deliberately: the report labels historic cream
-- requests from this row, and those requests really were "various colours" —
-- relabelling them "Writing Cream" would claim a precision the old data does not
-- have.
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
  ('PACK-012', 'Writing Cream (Red)',       'Consumables'),
  ('PACK-013', 'Writing Cream (White)',     'Consumables'),
  ('PACK-014', 'Writing Cream (Black)',     'Consumables'),
  ('PACK-015', 'Writing Cream (Any Color)', 'Consumables')
on conflict (material_code) do nothing;
