-- ---------------------------------------------------------------------------
-- Special order items on a branch demand.
--
-- A one-off a branch needs that is not in the catalogue: a named birthday cake,
-- a colour of box nobody stocks, a customer's written request. The branch types
-- a name, a quantity, an optional description and an optional photo.
--
-- THE DESIGN DECISION, and why it is this one:
--
-- The requirement is that a special item reaches BOTH `production_stock` and
-- branch `stock`. Both of those tables are keyed by `product_id` with a NOT NULL
-- foreign key to `products` — there is no way to carry stock for something that
-- has no product row. So a special item must become a product.
--
-- Given that, the cheapest correct shape is for a special line to be an ORDINARY
-- `production_order_items` row pointing at that product. Everything downstream —
-- the review's approved-quantity handling, `production_balances`, the verify RPC
-- in migration 58, `applyProductionToStock`, `transferOutOnApproval`, every
-- stock report — then works on it unchanged, because it genuinely is a product
-- line. The alternative (a separate special-items table) would have required
-- each of those paths to learn about a second kind of line, and the first one
-- anybody forgot would be a silent stock discrepancy.
--
-- What makes it "special" is therefore a flag, not a different table.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- products.is_special — a product that exists only to carry a one-off.
--
-- It is a real, active product so that stock works, but it must not appear
-- anywhere a person picks from the catalogue: the branch order form, the price
-- list, the POS. Those all read GET /api/products, which now filters it out
-- unless asked for explicitly (`includeSpecial=true`).
--
-- NOT modelled as `is_active = false`: inactive means retired, and the stock
-- and production-stock queries deliberately read only active products. Marking
-- these inactive would have hidden them from the very tables this feature
-- exists to reach.
-- ---------------------------------------------------------------------------
alter table products
  add column if not exists is_special boolean not null default false;

comment on column products.is_special is
  'Auto-created to carry a branch special order item. Real and active (so stock works) but hidden from the order catalogue, price list and POS.';

-- The catalogue read is "active, not special, by name" — the existing
-- products_active_name_idx no longer matches it. Partial on the same predicate.
create index if not exists products_active_ordinary_name_idx
  on products (name) where is_active and not is_special;

-- Find-or-create matches on the normalised name so "Name Cake" and "name cake "
-- are one product rather than two that drift apart in stock. Unique only among
-- special products: an ordinary product is free to share a name with anything.
create unique index if not exists products_special_name_key
  on products (lower(trim(name))) where is_special;

-- ---------------------------------------------------------------------------
-- production_order_items.is_special — this line came from the Special Order
-- Items section rather than the product list.
--
-- Denormalised from products.is_special on purpose: the demand screens group
-- and label special lines, and doing that from a flag on the line costs no join
-- on a query that already embeds two other tables. It also keeps a historical
-- demand rendering correctly if a product's flag is ever changed.
-- ---------------------------------------------------------------------------
alter table production_order_items
  add column if not exists is_special boolean not null default false;

-- ---------------------------------------------------------------------------
-- The optional per-item photo — "this is the cake I mean".
--
-- Its own enum value, added in its own statement: Postgres will not let a value
-- added to an enum be USED inside the transaction that added it. Nothing below
-- uses it; the runtime binding in production-orders.routes.ts is a later
-- transaction.
--
-- entity_id is the `production_order_items.id` of the special line, so the photo
-- hangs off the individual item rather than off the whole demand.
--
-- attachments_read (migration 67) needs no change: its CASE sends every
-- non-finance entity down the `else true` branch, which is the correct posture
-- for an operational photo any signed-in staff member may already see.
-- ---------------------------------------------------------------------------
alter type attachment_entity add value if not exists 'production_order_special_item';
