-- ---------------------------------------------------------------------------
-- Per-branch company/branch share split.
--
-- Until now the split was ONE global pair in finance_settings
-- (company_share_pct / branch_share_pct, defaulting to 75/25) applied to every
-- branch alike. A branch negotiated onto different terms had nowhere to record
-- that, so Finance either approved the wrong figure or hand-corrected the
-- ledger afterwards.
--
-- This column is the override. Deliberately ONE column, not a pair:
--
--   * The branch share is always 100 − company, so storing both invites the
--     half-applied edit that the finance_settings CHECK exists to catch. With a
--     single number there is no second value to leave stale.
--   * NULL is meaningful and is the default — it means "no override, use the
--     global finance_settings split". That keeps "this branch is deliberately
--     on 70/30" distinguishable from "this branch happens to match the current
--     default", which matters the day someone changes the default: the first
--     must not move, the second must.
--
-- It lives on `branches` rather than in a finance table because the brief puts
-- the editor on the Admin → Branches screen, which is Super Admin's and does
-- not go through the finance permission model. Reading it costs nothing extra:
-- every consumer already loads the branch row.
--
-- Nothing is backfilled. Every existing branch stays NULL and therefore keeps
-- behaving exactly as it does today.
--
-- History is unaffected. finance_income_approvals snapshots the pair it was
-- approved under (see migration 52), so changing a branch's percentage only
-- affects what is approved from now on — the same rule the global setting
-- already follows.
-- ---------------------------------------------------------------------------
alter table branches
  add column if not exists company_share_pct numeric(5,2)
    check (company_share_pct is null or (company_share_pct >= 0 and company_share_pct <= 100));

comment on column branches.company_share_pct is
  'Company''s cut of this branch''s collection, 0-100. NULL = inherit finance_settings.company_share_pct. Branch share is always 100 minus this.';
