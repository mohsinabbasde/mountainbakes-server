-- 75: file Production-accepted returns as 'return', not 'adjustment'.
--
-- WHAT WAS WRONG
--
-- A return reaches branch stock by two paths that describe the SAME business
-- event and differed only in who recorded it:
--
--   A. Branch-initiated  — POST /api/stock/return -> commit_branch_return
--                          wrote stock_history.type = 'return'.   correct
--   B. Production-recorded — POST /api/production-returns, then
--                          PUT /:id/review {accepted} -> applyStockMovement
--                          wrote stock_history.type = 'adjustment'.  the bug
--
-- Path B's delta was always negative, so the persisted `stock.balance` was
-- correct the whole time — the stock really did come off. What was wrong was
-- the CATEGORY, and that had two consequences:
--
--   1. The branch Stock page derives its columns from the type. Path B's units
--      landed under Adjustment and left Returned reading 0, so a branch that had
--      returned stock read the row as "my return was never taken off".
--
--   2. apply_stock_correction (migration 33) takes an ABSOLUTE target for
--      `returned` and sizes its compensating movement against the live figure.
--      Because getProductStockFigures counts only type = 'return', it reported
--      returned = 0 for these. An admin correcting Returned to the true figure
--      therefore appended a SECOND, genuine 'return' movement — removing the
--      same stock twice. That one moved real balances.
--
-- The write side is fixed in src/routes/production-returns.routes.ts (type is
-- now 'return'). This migration reclassifies the rows already written.
--
-- WHY THIS IS SAFE
--
-- It rewrites `type` only. delta, balance_after, business_date and ref_id are
-- untouched, and `stock.balance` is not read or written — so no balance moves
-- and no figure changes except the Adjustment/Returned split that was wrong to
-- begin with. It is a relabel of history to what actually happened, not a
-- restatement of it.
--
-- The predicate is exact. `return_<uuid>` is the only prefixed ref_id anywhere
-- in the codebase (grep: one hit, production-returns.routes.ts); every other
-- writer uses a bare uuid, and apply_stock_correction uses
-- '<ticket_id>:stock:<uuid>'. So no genuine admin correction can match.
--
-- DEPLOY ORDER — deploy the server FIRST, then apply this.
--
-- The two are independent (neither breaks without the other), but in that order
-- the backfill is final: once the server is writing 'return', no new
-- 'adjustment' return can appear behind the update. Apply it first and any
-- return accepted in the gap is written as 'adjustment' and left behind —
-- harmless, but it needs this statement run again to clear.

update stock_history
   set type = 'return'
 where type = 'adjustment'
   and ref_id like 'return\_%'
   -- Belt and braces against the UNIQUE (ref_id, product_id, type) index: Path B
   -- writes exactly one movement per return id, so this can never fire, but a
   -- flipped row must not collide with an existing 'return' for the same pair.
   and not exists (
     select 1
       from stock_history other
      where other.ref_id     = stock_history.ref_id
        and other.product_id = stock_history.product_id
        and other.type       = 'return'
   );

comment on column stock_history.type is
  'sale | production | return | adjustment. A return is ''return'' regardless of '
  'which side recorded it — branch-initiated (commit_branch_return) and '
  'Production-accepted (PUT /api/production-returns/:id/review) are the same '
  'event. ''adjustment'' means an admin correction (apply_stock_correction, '
  'migration 33) and nothing else; see migration 75.';
