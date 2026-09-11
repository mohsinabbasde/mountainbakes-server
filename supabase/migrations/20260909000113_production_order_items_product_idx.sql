-- Production dashboard/page optimization pass: production_order_items had no
-- index on product_id, despite being a hot join column on every order review
-- and verification — production_outstanding_demand() and
-- production_stock_availability() (migration 90) both join through it, and
-- production_demand_shortfalls() looks it up once per product on every
-- review/verify call. The table is append-only (one row per demand line,
-- never purged), so this was a growing sequential-scan cost on a write path.
-- Partial (product_id is nullable — a deleted product sets it null), matching
-- the pattern used elsewhere for nullable FK indexes in this schema.
create index production_order_items_product_idx
  on production_order_items (product_id)
  where product_id is not null;
