-- 37: the Production counter's sentinel branch.
--
-- Sales rung up on the Production dashboard belong to no branch — they come out
-- of the central pool. But orders.branch_id is `not null references branches(id)`
-- and is load-bearing: the orders RLS policies, every report's branch grouping and
-- the branch dashboard all key on it. Making it nullable would ripple through all
-- of that, so instead these orders point at one dedicated row.
--
-- is_active = false is what keeps it out of the way: GET /api/branches filters on
-- is_active unless ?includeInactive=true, so this row never appears in a branch
-- picker, a user's branch assignment, or a report filter — while the FK, RLS and
-- the receipt header all keep working unchanged.
--
-- The slug is the lookup key (getProductionBranchId resolves by it); the uuid is
-- generated, so nothing may hardcode an id. `slug` is already `not null unique`,
-- which makes the conflict clause a true no-op on re-run.
insert into branches (name, slug, is_active)
values ('Production', 'production-counter', false)
on conflict (slug) do nothing;
