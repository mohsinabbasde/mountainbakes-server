-- 51: the four Finance Ledger roles.
--
-- WHY THIS IS ITS OWN MIGRATION FILE
-- `alter type ... add value` is allowed inside a transaction on PG 12+, but the
-- new value may not be USED in that same transaction:
--
--     ERROR: unsafe use of new value "finance_admin" of enum type user_role
--     HINT:  New enum values must be committed before they can be used.
--
-- The Supabase CLI wraps each migration file in one transaction, and migration
-- 52 needs these values in RLS policy predicates (app.jwt_role() = 'finance_admin')
-- and in a seeded row or two. So the values are added here and committed, and
-- everything that references them lives in the next file. Do not merge the two.
--
-- Why extend `user_role` at all rather than invent a separate `finance_role`
-- claim: role is already the axis that middleware/auth.ts, requireRole(),
-- app.jwt_role() and the client's RouteGuard all turn on. A second parallel
-- claim would mean every one of those grows a special case, and the two could
-- disagree. A finance account is provisioned through the same POST /api/users
-- as every other account, and its role rides in app_metadata exactly like the
-- others.
--
-- The four map to the brief's Finance Admin / Finance Manager / Accountant /
-- Read Only Auditor. What each may do is application policy (financeCan() in
-- shared/types/finance.types.ts), not schema — the database only needs to tell
-- a finance user from a branch manager.

alter type user_role add value if not exists 'finance_admin';
alter type user_role add value if not exists 'finance_manager';
alter type user_role add value if not exists 'accountant';
alter type user_role add value if not exists 'finance_auditor';
