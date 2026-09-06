-- 102: reconcile the counted cash against CASH ON TABLE, not gross cash sales.
--
-- ─── What changes ────────────────────────────────────────────────────────────
-- `cash_difference` was `manual_cash - auto_cash`. It becomes
-- `manual_cash - (auto_cash - cash_expense)` — the counted notes against what
-- should physically be in the drawer. `overall_difference` picks up the same
-- term, since it is the three per-method differences summed.
--
-- ─── Why the original was wrong in practice ──────────────────────────────────
-- Migration 101 followed the brief's §9 literally ("Difference = Manual Amount −
-- Auto Amount") and compared the count against GROSS cash takings, keeping
-- cash-after-expense as a separate `expected_cash_in_hand` figure. That is
-- defensible on paper and wrong at the counter: the person counting is counting
-- physical notes, and the drawer has already had the day's cash expenses paid out
-- of it. Every branch would therefore have read SHORT by exactly its cash
-- expenses, every single day.
--
-- That is not a rounding annoyance. Shop expenses over the last month were 87
-- payments totalling ~Rs 63,660 — around Rs 730 a day — so the feature would have
-- reported a fabricated shortfall on every record and trained everybody to ignore
-- the one column it exists to draw attention to.
--
-- ─── The other two methods are untouched, deliberately ───────────────────────
-- Only cash leaves the till. `expense_payment_method` is ('cash','easypaisa') and
-- every expense on record is cash, but even an Easypaisa expense would not reduce
-- a BANK or FOODPANDA settlement — so netting anything against those would invent
-- a discrepancy rather than remove one. If Easypaisa expenses ever start being
-- recorded, the question of whether they leave the till is a business question,
-- not a schema one; `cash_expense` is cash-only and this expression uses it.
--
-- ─── Gross cash is still stored and still shown ──────────────────────────────
-- `auto_cash` is unchanged. The payment breakdown must keep summing to
-- `auto_total_sale` — a breakdown whose rows do not add up to their own heading is
-- worse than one with a row missing — so the table shows Cash, Cash Expense and
-- Cash on Table side by side and lets the reader see the subtraction.
--
-- ─── This RETROACTIVELY recomputes every stored difference ───────────────────
-- `SET EXPRESSION` rewrites the table, so existing rows are recomputed against
-- the new rule — including any that were already verified or locked. That is the
-- correct outcome (the old figures were wrong), and it is safe to do now for a
-- reason that will not be true later: there are TWO records in the table, both
-- created today, neither signed off by anyone.
--
-- **Do not run a change like this again once the table holds signed history.**
-- A figure somebody put their name against must not move underneath them; the
-- amendment path exists for corrections, and it records the old value.
--
-- Both columns are altered in ONE statement so the table is rewritten once
-- rather than twice.
--
-- NOTE: this supersedes the rule stated in migration 101's comment on
-- `cash_difference`. 101 is left as it was — an applied migration is a historical
-- record, not a document to keep current.
-- ---------------------------------------------------------------------------

alter table daily_sale_records
  alter column cash_difference set expression as (
    case
      when manual_cash is null then null
      else manual_cash - (auto_cash - cash_expense)
    end
  ),
  alter column overall_difference set expression as (
    coalesce(case when manual_cash      is null then null else manual_cash      - (auto_cash - cash_expense) end, 0)
  + coalesce(case when manual_easypaisa is null then null else manual_easypaisa - auto_easypaisa             end, 0)
  + coalesce(case when manual_bank      is null then null else manual_bank      - auto_bank                  end, 0)
  );

comment on column daily_sale_records.cash_difference is
  'Counted cash minus CASH ON TABLE (auto_cash - cash_expense) — what should physically be in the drawer, not gross takings. See migration 102.';
comment on column daily_sale_records.expected_cash_in_hand is
  'Cash on Table: cash taken less cash paid out of the till. The figure cash_difference reconciles against.';
