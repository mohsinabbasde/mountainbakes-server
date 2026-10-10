-- Branch dashboard/page optimization pass: two composite indexes for query
-- patterns the Data Engine registry already declares (branch scope + default
-- sort) but that had no supporting index yet.
--
-- finance_income_approvals: branch-scoped (income resource, groupable by
-- branchId) but had no index on branch_id at all — only (status, business_date)
-- and (business_date).
create index finance_income_branch_date_idx
  on finance_income_approvals (branch_id, business_date desc);

-- customers: registry default sort is createdAt desc, but only (branch_id, name)
-- existed — a branch-scoped createdAt-desc query had no supporting index.
create index customers_branch_created_idx
  on customers (branch_id, created_at desc);
