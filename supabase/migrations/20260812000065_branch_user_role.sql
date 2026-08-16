-- 65: the `branch_user` role.
--
-- WHY THIS IS ITS OWN MIGRATION FILE — the same reason migration 51 was, and the
-- comment is repeated rather than cross-referenced because merging the two files
-- is exactly the mistake it prevents. `alter type ... add value` is allowed
-- inside a transaction on PG 12+, but the new value may not be USED in that same
-- transaction:
--
--     ERROR: unsafe use of new value "branch_user" of enum type user_role
--     HINT:  New enum values must be committed before they can be used.
--
-- The Supabase CLI wraps each migration file in one transaction, and migration
-- 66 names this value in the check constraint that keeps `users.shift` off every
-- other role. So it is added here, alone, and everything that references it
-- lives in the next file. Do not merge them.
--
-- WHAT THE ROLE IS. A shift account on a branch, opened by an admin at a branch
-- manager's request (migration 66 carries that queue). It holds the SAME
-- `branchId` claim as the manager who asked for it, which is the whole point:
-- every branch-scoped query it makes returns the manager's branch data rather
-- than a private set of its own, so a morning and an evening user are two hands
-- on one shop's books rather than two shops.
--
-- Extending `user_role` rather than inventing a sub-account flag keeps
-- middleware/auth.ts, requireRole(), app.jwt_role() and the client's RouteGuard
-- all turning on the one axis they already turn on. What a branch_user may
-- actually reach is application policy — six screens, enforced in the API — not
-- schema. The database only needs to tell it apart from a manager.

alter type user_role add value if not exists 'branch_user';

-- The round-trip for the request queue in migration 66. `notification_type` is
-- an enum too, so these are subject to exactly the same rule and belong in this
-- file for exactly the same reason — see migration 14, which added a single
-- notification value on its own for this cause.
alter type notification_type add value if not exists 'branch_user_requested';
alter type notification_type add value if not exists 'branch_user_reviewed';
