-- ---------------------------------------------------------------------------
-- Restriction Rules: a `production` group.
--
-- The production stock check at "Submit for Verification" (migration 90) has
-- been enforced since before the rules screen existed. This lets Admin see and
-- configure it there like every other rule: on/off, and whether a Super Admin
-- may send a short demand through.
--
-- Only the list of group keys changes. No row is written: a missing row means
-- "use DEFAULT_RESTRICTION_RULES", which keeps the check ON, exactly as today.
-- ---------------------------------------------------------------------------
alter table restriction_rules drop constraint if exists restriction_rules_group_check;
alter table restriction_rules add constraint restriction_rules_group_check
  check (group_key in ('demand', 'sales', 'production', 'cash', 'ledger', 'company'));
