-- ---------------------------------------------------------------------------
-- The date the branch needs a demand delivered by.
--
-- Until now a demand carried only `business_date` — the day it was RAISED,
-- stamped by the server on insert. That answers "when was this asked for", not
-- "when is this needed", and Production had no way to tell a demand wanted this
-- afternoon from one wanted at the weekend. The two were being communicated by
-- phone, or not at all.
--
-- Deliberately a separate column rather than a reinterpretation of
-- business_date: business_date is the key the whole day-scoped reporting layer
-- runs on (the 7-day list predicate, the closing snapshot, every index below
-- it), and it must keep meaning "the business day this demand belongs to". The
-- required date is branch-chosen, may be days ahead, and is never the day the
-- record is filed under.
--
-- NULLABLE, and nothing is backfilled. Every demand raised before this change
-- genuinely has no required date — there was no field to enter one in — and
-- inventing one (business_date, business_date + 1) would fabricate a commitment
-- nobody made. The screens read it as "—" when absent.
--
-- New demands always carry one: the API requires it
-- (CreateProductionOrderSchema) and the form will not submit without it. That
-- rule lives in application code rather than a NOT NULL constraint precisely
-- BECAUSE the existing rows are null — a NOT NULL here could not be applied
-- without backfilling exactly the data this comment says not to invent.
--
-- No index. It is a display and planning column: read back with the order row
-- that already came out of the business_date index, never filtered on.
-- ---------------------------------------------------------------------------
alter table production_orders
  add column if not exists required_date date;

comment on column production_orders.required_date is
  'Date the branch needs this demand delivered by, chosen on the order form. NULL only on demands raised before the field existed; required for every new demand. Distinct from business_date, which is the day the demand was raised.';
