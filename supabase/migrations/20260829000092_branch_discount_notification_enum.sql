-- 92: notification types for branch discount requests (see migration 93).
--
-- Split into its own migration/transaction ON PURPOSE, for the same reason
-- migrations 55 and 72 were: Postgres will not let a newly ADDed enum value be
-- referenced within the SAME transaction it was added in. 93 does not compile a
-- function body against either value, but keeping the ALTER TYPE alone matches
-- the established pattern and leaves 93 free to grow one later without a silent
-- rollback of the whole batch.
--
-- TWO values, not one, where returns make do with a single `production_return`
-- for both directions. That conflation is why a production user cannot tell a
-- return they have to act on from one they just decided. A claim raised travels
-- branch → Production; a claim reviewed travels Production → branch. They are
-- different audiences and different urgencies, so they are different types.

-- A branch raised a discount claim against a demand → Production.
alter type notification_type add value if not exists 'branch_discount';

-- Production approved / rejected / sent back a claim → the raising branch.
alter type notification_type add value if not exists 'branch_discount_reviewed';
