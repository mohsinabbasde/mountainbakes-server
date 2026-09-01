-- 96: Finance Help Desk — a query may name a SALE.
--
-- §15 of the brief lists the handles a Finance user may quote and expects the
-- desk to resolve each one and show the record behind it:
--
--     Sale ID · Expense ID · Ledger ID · Company Transaction ID ·
--     Partner Advance ID · Branch Share ID · Voucher ID
--
-- Six of the seven already resolve. The Sale ID — `orders.order_number`,
-- MB-000125 — did not, and it is the one a Finance user reaches for most often:
-- a day's income that does not agree with the branch's takings is queried
-- against the sale that produced the difference, not against the ledger row
-- that summarises fifty of them.
--
-- FINANCE_TICKET_REFERENCES (shared/types/finance.types.ts) gains an `order`
-- entry in the same change. That map and this CHECK have to move together, for
-- the reason migration 87 gave when it added ADV-: resolving a number the
-- constraint then refuses turns a valid query into a 23514 at insert, and only
-- after the raiser has typed the whole thing.
--
-- READ-ONLY, AND THAT IS THE POINT.
--
-- A sale is the only referencable record here that is NOT a finance document. It
-- is a branch's ledger row and a stock movement at once, and correcting one has
-- to rewrite `order_items`, recompute the order's totals, adjust the customer's
-- spend and reconcile branch stock — which `edit_sale_items` already does, from
-- the Support Center, where branch and production queries are worked.
--
-- So `amend_finance_record` and `soft_delete_finance_record` are deliberately
-- NOT taught about 'order': they raise `unknown finance reference type` for it,
-- and the API refuses before reaching them (FINANCE_AMENDABLE_FIELDS carries an
-- empty list, which every layer reads as "this reference is informational").
-- Building a second sale-correction path through the finance desk is exactly the
-- duplicate support architecture the brief's acceptance criteria rule out; a
-- Finance user raising an MB- query gets the sale's figures in front of an
-- Admin, and the Admin corrects it where sales are corrected.
--
-- Nothing else changes. No existing row carries 'order', so widening the CHECK
-- rewrites nothing and cannot fail on existing data.

alter table finance_tickets drop constraint if exists finance_tickets_reference_type_check;

alter table finance_tickets add constraint finance_tickets_reference_type_check
  check (reference_type in (
    'ledger_entry', 'income_approval', 'finance_transaction',
    'salary_payment', 'employee_advance', 'partner_expense',
    'branch_share_payment', 'order'
  ));
