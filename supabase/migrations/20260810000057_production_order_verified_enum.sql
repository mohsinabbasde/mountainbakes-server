-- 57: the 'verified' status, added ahead of migration 58 that uses it.
--
-- Own migration/transaction for the same reason as 55: a newly ADDed enum value
-- is not safely usable until the transaction that added it has committed.

alter type branch_production_order_status add value if not exists 'verified';
