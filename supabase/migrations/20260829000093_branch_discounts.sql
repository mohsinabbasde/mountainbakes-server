-- 93: branch discount requests — money asked for against a demand, reviewed by
-- Production.
--
-- ─── What this is ────────────────────────────────────────────────────────────
-- A branch raises a demand, Production fills it, and sometimes the branch is owed
-- money back on it: goods arrived short, arrived damaged and were sold off cheap,
-- a promotion was run at the counter. That claim had nowhere to live. It was
-- settled verbally and landed in nobody's record.
--
-- A discount is a CLAIM ABOUT A DEMAND, which is why `production_order_id` is not
-- null. "The branch is owed 500" is unanswerable on its own — Production cannot
-- review what it cannot tie to a delivery it made, and the demand is what makes
-- the amount checkable against something.
--
-- ─── It moves no stock, and that is the whole difference from a return ────────
-- `production_returns` is the model this table is shaped after, deliberately, so
-- Production reviews both the same way on two screens that read alike. But a
-- return moves units and this moves none: there is no branch balance to debit as
-- it is raised, no pool to credit on approval, and so no idempotency key, no
-- ledger row, and no compensating movement on rejection. Approving a discount
-- records that the claim was allowed. Nothing else happens.
--
-- The consequence to keep in mind when reading the routes: the review is a status
-- write and a notification, with none of the stock choreography
-- production-returns.routes.ts has to get right. That is not an oversight.
--
-- ─── Four states, two of them open ───────────────────────────────────────────
--   pending   — waiting on Production. The branch may still correct or withdraw.
--   returned  — handed back to the branch to fix. Also open; the branch corrects
--               and resubmits, which puts it back to pending.
--   approved  — allowed. Final.
--   rejected  — refused. Final.
--
-- The same four `production_returns` has, and named the same way but for
-- 'accepted' → 'approved': the Returns screen already LABELS 'accepted' as
-- "Approved" for the operator, so a new table spells it the way it reads.
--
-- ADDITIVE. New table, new enum, nothing existing is touched. The two
-- notification_type values this feature needs are added by migration 92, which
-- has to be its own transaction — see its header.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'branch_discount_status') then
    create type branch_discount_status as enum ('pending', 'approved', 'rejected', 'returned');
  end if;
end
$$;

create table if not exists branch_discounts (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references branches (id) on delete restrict,
  -- Denormalised at insert, as branch_name / product_name are on
  -- production_returns: the review board lists thirty days across every branch
  -- and must not join for a label, and a renamed branch must not silently rewrite
  -- what a settled claim said at the time.
  branch_name         text,
  -- The demand the claim is about. `restrict`, not `cascade` — a demand with a
  -- discount against it is not deletable, which is the correct answer: the money
  -- claim is evidence about a delivery and must outlive tidying up.
  production_order_id uuid not null references production_orders (id) on delete restrict,
  demand_number       text,
  -- Money, so numeric(14,2) — NOT the numeric(14,3) the stock tables use for
  -- units. Positive only: a negative discount is a charge, which this table does
  -- not model and must not be made to by a sign flip.
  amount              numeric(14,2) not null,
  reason              text not null,
  status              branch_discount_status not null default 'pending',
  business_date       date not null,
  created_by          uuid references users (id) on delete set null,
  created_by_name     text,
  created_at          timestamptz not null default now(),
  reviewed_by         uuid references users (id) on delete set null,
  reviewed_by_name    text,
  reviewed_at         timestamptz,
  -- Why it was refused or sent back, in Production's words. `production_returns`
  -- has no equivalent and the gap shows on that screen: a branch sees "Sent Back"
  -- and has to guess what to fix. A claim about money gets told.
  review_note         text,
  constraint branch_discounts_amount_positive check (amount > 0)
);

-- The three reads this table gets: Production's 30-day board (date), a branch's
-- own list (branch + date), and the pending count on the dashboard. The partial
-- index is the pattern production_returns_status_idx already uses — a queue is
-- only ever asked about its open rows.
create index if not exists branch_discounts_date_idx    on branch_discounts (business_date desc);
create index if not exists branch_discounts_branch_idx  on branch_discounts (branch_id, business_date desc);
create index if not exists branch_discounts_status_idx  on branch_discounts (status) where status = 'pending';
create index if not exists branch_discounts_order_idx   on branch_discounts (production_order_id);

comment on table branch_discounts is
  'Branch claims for money back against a production demand. Reviewed by Production like a return, but moves no stock — approval records that the claim was allowed and books nothing.';

-- RLS on, with a branch-scoped select policy, exactly as migration 09 does for
-- production_returns. The API reaches this table through the service-role client,
-- which bypasses RLS entirely and re-decides every request against the JWT in
-- application code — so this policy is the floor under a direct client read, not
-- the authorisation the app relies on.
alter table branch_discounts enable row level security;

drop policy if exists branch_discounts_select_branch on branch_discounts;
create policy branch_discounts_select_branch on branch_discounts
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());
