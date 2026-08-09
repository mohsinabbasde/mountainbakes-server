-- 55: enum values for branch physical-receipt verification (see migration 56).
--
-- Split into its own migration/transaction ON PURPOSE. Postgres will not let a
-- newly ADDed enum value be referenced within the SAME transaction it was added
-- in — and by default `plpgsql.check_function_bodies` compiles a PL/pgSQL
-- function's body at CREATE time, which counts as a reference. Migration 56
-- creates functions whose bodies compare against 'awaiting_verification', so
-- this value must already be committed before that migration runs, or the
-- whole batch aborts and silently rolls back the ALTER TYPE too.

alter type branch_production_order_status add value if not exists 'awaiting_verification';
alter type notification_type add value if not exists 'production_order_verified';
