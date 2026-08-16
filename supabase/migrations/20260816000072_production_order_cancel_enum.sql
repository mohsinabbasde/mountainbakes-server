-- 72: enum values for a branch deleting its own demand (see migration 73).
--
-- Split into its own migration/transaction ON PURPOSE, for the same reason
-- migration 55 was: Postgres will not let a newly ADDed enum value be referenced
-- within the SAME transaction it was added in. Migration 73 does not compile any
-- function body against 'cancelled', but keeping the ALTER TYPE alone matches the
-- established pattern and leaves 73 free to grow one later without a silent
-- rollback of the whole batch.

-- A demand the BRANCH withdrew before Production reviewed it. Distinct from
-- 'rejected', which is Production's decision — the two must stay separable
-- because only one of them reflects on Production's fulfilment.
alter type branch_production_order_status add value if not exists 'cancelled';

alter type notification_type add value if not exists 'production_demand_cancelled';
