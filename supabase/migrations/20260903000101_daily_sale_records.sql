-- 101: Daily Sale Record — the branch's daily financial reconciliation.
--
-- ─── What this is, and what it deliberately is not ───────────────────────────
-- A RECONCILIATION LAYER over sales that already exist. It records, for one
-- branch and one business day:
--
--   * what the sales system says was taken, per payment method (AUTO)
--   * what a person physically counted and received            (MANUAL)
--   * the difference between the two, per method
--   * who checked it, who signed it off, and every change since
--
-- It writes NOTHING back to `orders`, `order_items` or `expenses`. A wrong auto
-- figure is a wrong SALE and is corrected by correcting the sale (the Help Desk
-- exists for exactly that); it is never corrected by overwriting the figure here,
-- which would leave the books and the reconciliation each claiming to be right.
-- That is the whole reason `auto_*` is not amendable and `manual_*` is.
--
-- It is also NOT the Branch Closing sheet and not the 2 AM business-day closure.
-- Branch Closing (branch-closing.routes.ts, BranchClosingPage) is a read of the
-- day that writes nothing and locks nothing. `business_day_closures` is the
-- admin's once-a-day archive. This table is the third thing neither of those was:
-- a durable, signed, audited statement that the money was counted and agreed.
--
-- ─── Where the auto figures come from ────────────────────────────────────────
-- `public.daily_sale_figures` below, which reproduces `buildBranchReport`
-- (services/closing-report.service.ts) EXACTLY — same order filter, same staff
-- exemption, same discount base, same cash-expense definition. That is not
-- incidental: `buildBranchReport` is what Finance approves branch income from
-- (finance-income.service.ts), so any other arithmetic here would produce a
-- reconciliation that disagrees with the figure the company banked. If one of the
-- two ever changes, change both.
--
-- ADDITIVE. Three new tables, two new enums, one new schema-level helper, six new
-- functions. Nothing existing is altered; the only touch to an existing table is
-- one additional index on `orders` for the range this feature reads.
-- ---------------------------------------------------------------------------

-- ─── The 2 AM business day, in SQL ───────────────────────────────────────────
--
-- `shared/utils/timezone.ts` owns this rule for the app; this is the same
-- arithmetic for the queries that cannot call into it. Shift the instant back by
-- the rollover offset, then take the Karachi calendar date — so 01:30 belongs to
-- the previous business day and 02:00 starts a new one.
--
-- Written as `+ 5 hours` (Karachi, fixed UTC+5 with no DST since 2009) and
-- `- 2 hours` (BUSINESS_DAY_START_MINUTES) rather than folded into one interval,
-- so both constants stay visible next to the two things they mean. Deliberately
-- NOT `at time zone 'Asia/Karachi'`: tzdata carries the 2002 and 2008-09 DST
-- experiments, and this app's TS helper does not — matching the helper matters
-- more than matching the zone database for data that starts in 2026.
--
-- STABLE, not IMMUTABLE: `at time zone` is stable in Postgres, so this cannot
-- back an index. Every caller below therefore pairs it with a sargable
-- `created_at` range that prunes the scan, and uses this only to bucket the rows
-- the range returned.
create or replace function app.business_date(ts timestamptz) returns date
  language sql
  stable
  as $$ select ((ts + interval '5 hours' - interval '2 hours') at time zone 'UTC')::date $$;

comment on function app.business_date(timestamptz) is
  'Business date (Asia/Karachi, 02:00 rollover) for an instant. Mirrors businessDateStr() in shared/utils/timezone.ts.';

-- ─── Statuses ────────────────────────────────────────────────────────────────
--
--   open                 — generated from sales; nobody has counted anything yet
--   pending_verification — a manual figure has been fed; awaiting sign-off
--   verified             — signed off. Still correctable by an admin.
--   locked               — closed. The branch cannot touch it at all.
--   amended              — locked, and an admin has since corrected a figure.
--                          A SEPARATE state from `locked` on purpose: "this
--                          record was changed after it was closed" is exactly the
--                          thing a reader must not have to dig for.
--
-- `open` and `pending_verification` are the only two states a branch may write
-- in. That single rule is enforced inside the functions below, not in the app.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'daily_sale_record_status') then
    create type daily_sale_record_status as enum
      ('open', 'pending_verification', 'verified', 'locked', 'amended');
  end if;
end
$$;

-- ─── Audit actions ───────────────────────────────────────────────────────────
--
-- One value per thing that can happen to a record or to a branch's lock
-- configuration. `refreshed` is separate from `generated` so a re-read of the
-- day's sales is distinguishable from its first snapshot, and
-- `manual_feed_override` is separate from `manual_feed` because an admin writing
-- into a LOCKED payment method is the single most sensitive act this feature
-- allows and must never look like an ordinary entry.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'daily_sale_audit_action') then
    create type daily_sale_audit_action as enum (
      'generated',
      'refreshed',
      'manual_feed',
      'manual_feed_override',
      'verified',
      'locked',
      'unlocked',
      'amended',
      'method_locked',
      'method_unlocked'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- daily_sale_records
-- ---------------------------------------------------------------------------
create table if not exists daily_sale_records (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches (id) on delete restrict,
  -- Denormalised at insert, exactly as `branch_discounts.branch_name` is: the
  -- admin board lists thirty days across every branch and must not join for a
  -- label, and renaming a branch must not silently rewrite what a signed record
  -- said at the time.
  branch_name   text,
  business_date date not null,

  -- ── AUTO: what the sales system says. Never editable by anybody. ──
  --
  -- `auto_other` exists for the same reason buildBranchReport's `payments.other`
  -- does — a payment method added later still lands somewhere — and it is what
  -- keeps `payment_total` below able to equal `auto_total_sale` instead of
  -- quietly shedding a bucket.
  auto_total_sale numeric(14,2) not null default 0,
  auto_cash       numeric(14,2) not null default 0,
  auto_easypaisa  numeric(14,2) not null default 0,
  auto_foodpanda  numeric(14,2) not null default 0,
  auto_bank       numeric(14,2) not null default 0,
  auto_other      numeric(14,2) not null default 0,
  -- A staff sale takes no money (migration 36). Carried so the parts still sum
  -- to the whole and a reader can see WHY the shelf moved more than the till did;
  -- excluded from every money figure above.
  auto_staff      numeric(14,2) not null default 0,
  -- Already deducted inside `auto_total_sale` — grand_total is post-discount.
  -- Recorded, never subtracted again. Double-subtracting it is the classic bug
  -- this column exists to make visible rather than invite.
  discount        numeric(14,2) not null default 0,
  -- Cash paid out of the till. Deliberately cash-only: an Easypaisa expense never
  -- touched the drawer, so netting it against a physical cash count would make an
  -- honest drawer read short.
  cash_expense    numeric(14,2) not null default 0,
  -- Every shop expense for the day, whatever it was paid with. Reported, not
  -- netted off any payment method.
  expense_total   numeric(14,2) not null default 0,
  order_count     integer       not null default 0,
  /** When the auto figures were last read off the sales system. */
  generated_at    timestamptz   not null default now(),

  -- ── MANUAL: what a person counted. NULL means "not counted yet". ──
  --
  -- Nullable, and that is load-bearing: 0 is a real count (an empty drawer) and
  -- must be distinguishable from an absent one. A NULL here makes the matching
  -- difference NULL too, so an uncounted method reads as "—" rather than as a
  -- confident Rs. -45,000 shortfall.
  --
  -- Foodpanda has no manual column on purpose: the aggregator settles it and
  -- there is nothing at the counter to count. See DAILY_SALE_MANUAL_METHODS in
  -- shared/types/daily-sale.types.ts, which is the one list both sides read.
  manual_cash      numeric(14,2),
  manual_easypaisa numeric(14,2),
  manual_bank      numeric(14,2),
  fed_by           uuid references users (id) on delete set null,
  fed_by_name      text,
  fed_at           timestamptz,

  -- ── DIFFERENCE: derived, never written. ──
  --
  -- Generated columns rather than app-maintained ones, because a stored
  -- difference that anybody can write is a difference that can be made to say
  -- zero. These cannot disagree with their own operands.
  --
  -- `manual - auto`, per §9 of the brief, against the GROSS auto figure — not
  -- against cash-after-expense. `expected_cash_in_hand` below is the separate
  -- figure for "what should physically be in the drawer"; conflating the two
  -- would make every day with a cash expense read as short by exactly that
  -- expense.
  cash_difference numeric(14,2)
    generated always as (case when manual_cash      is null then null else manual_cash      - auto_cash      end) stored,
  easypaisa_difference numeric(14,2)
    generated always as (case when manual_easypaisa is null then null else manual_easypaisa - auto_easypaisa end) stored,
  bank_difference numeric(14,2)
    generated always as (case when manual_bank      is null then null else manual_bank      - auto_bank      end) stored,
  -- The three differences summed, with an uncounted method contributing 0 rather
  -- than poisoning the total to NULL. Equivalently: manual total − expected total.
  overall_difference numeric(14,2)
    generated always as (
      coalesce(case when manual_cash      is null then null else manual_cash      - auto_cash      end, 0)
    + coalesce(case when manual_easypaisa is null then null else manual_easypaisa - auto_easypaisa end, 0)
    + coalesce(case when manual_bank      is null then null else manual_bank      - auto_bank      end, 0)
    ) stored,
  -- The payment breakdown re-added. Should always equal `auto_total_sale`; it is
  -- carried so that if it ever does not, the screen can say so instead of
  -- printing a breakdown whose rows do not sum to their own heading.
  payment_total numeric(14,2)
    generated always as (auto_cash + auto_easypaisa + auto_foodpanda + auto_bank + auto_other) stored,
  -- What the drawer should hold: cash taken, less cash paid out of it. The
  -- physical expectation, kept beside `cash_difference` rather than folded into
  -- it. Same definition as ClosingTotals.cashInHand in shared/utils/closing.ts.
  expected_cash_in_hand numeric(14,2)
    generated always as (auto_cash - cash_expense) stored,

  -- ── Workflow ──
  status           daily_sale_record_status not null default 'open',
  created_by       uuid references users (id) on delete set null,
  created_by_name  text,
  verified_by      uuid references users (id) on delete set null,
  verified_by_name text,
  verified_at      timestamptz,
  locked_by        uuid references users (id) on delete set null,
  locked_by_name   text,
  locked_at        timestamptz,
  /** Set the first time an admin amends a closed record; never cleared. */
  amended_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- §14. ONE record per branch per business day, enforced by the database rather
  -- than by a check in the handler — a page refresh, a second tab, a double click
  -- and a network retry all arrive as concurrent inserts, and only a constraint
  -- settles those. Every writer below goes through ON CONFLICT on this key.
  constraint daily_sale_records_branch_date_key unique (branch_id, business_date),
  -- A negative count is a data error, not a credit note. Manual figures are
  -- allowed to be 0 (an empty drawer) but never below it.
  constraint daily_sale_records_manual_non_negative check (
    coalesce(manual_cash, 0) >= 0
    and coalesce(manual_easypaisa, 0) >= 0
    and coalesce(manual_bank, 0) >= 0
  )
);

-- The three reads this table gets: one branch over a window (its own page), one
-- business date across every branch (the admin board), and one exact record.
create index if not exists daily_sale_records_branch_date_idx
  on daily_sale_records (branch_id, business_date desc);
create index if not exists daily_sale_records_date_idx
  on daily_sale_records (business_date desc);
-- Partial, as `branch_discounts_status_idx` is: the only status ever *searched*
-- for is the open work.
create index if not exists daily_sale_records_open_idx
  on daily_sale_records (status)
  where status in ('open', 'pending_verification');

create trigger daily_sale_records_touch before update on daily_sale_records
  for each row execute function app.touch_updated_at();

comment on table daily_sale_records is
  'Per-branch, per-business-day reconciliation of system sales against physically counted receipts. A reporting layer over orders/expenses — it never modifies them.';

-- ---------------------------------------------------------------------------
-- daily_sale_record_audits — append-only history (§17)
-- ---------------------------------------------------------------------------
--
-- Its own table rather than rows in `audit_logs`: that table is shaped around an
-- admin acting on a USER (target_user_id / target_user_name / target_user_role)
-- and carries no field/old/new triple, so a figure changing from 45,000 to 44,500
-- could only be recorded there as prose. §16 requires the old value, the new
-- value, the reason and the actor as data, and this is that shape.
--
-- Never updated and never deleted. `record_id` is ON DELETE CASCADE only because
-- a record has no delete path at all — if one is ever added, the history must go
-- with it rather than dangle.
--
-- `record_id` is NULLABLE, for exactly one case: a lock configuration change
-- (`method_locked` / `method_unlocked`) governs the BRANCH, not one day, and
-- there may be no record in existence when an admin sets it. The alternative was
-- generating a Daily Sale Record for a day nobody had opened just to have
-- something to point at. The check constraint below is what keeps that hole to
-- those two actions — every record-scoped entry still has to name its record.
create table if not exists daily_sale_record_audits (
  id            uuid primary key default gen_random_uuid(),
  record_id     uuid references daily_sale_records (id) on delete cascade,
  -- Denormalised so the history of a branch's locks and overrides is queryable
  -- without joining back through the record it happened to land on.
  branch_id     uuid not null references branches (id) on delete restrict,
  business_date date not null,
  action        daily_sale_audit_action not null,
  /** Which figure moved — 'manual_cash', 'manual_bank', … Null for whole-record actions. */
  field         text,
  /** Held as text, not numeric: this column also carries a status ('verified') or
   *  a lock state ('locked'), and one history table beats two. */
  old_value     text,
  new_value     text,
  /** Mandatory for an unlock and for an amendment; the functions below enforce it. */
  reason        text,
  actor_id      uuid references users (id) on delete set null,
  actor_name    text,
  actor_role    text,
  created_at    timestamptz not null default now(),
  constraint daily_sale_audits_record_present check (
    record_id is not null or action in ('method_locked', 'method_unlocked')
  )
);

create index if not exists daily_sale_audits_record_idx on daily_sale_record_audits (record_id, created_at desc);
create index if not exists daily_sale_audits_branch_idx on daily_sale_record_audits (branch_id, created_at desc);

comment on table daily_sale_record_audits is
  'Append-only history for Daily Sale Records: every manual feed, lock, unlock, verification, amendment and admin override, with old and new values.';

-- ---------------------------------------------------------------------------
-- payment_method_settings — which methods a branch may key by hand (§10-§12)
-- ---------------------------------------------------------------------------
--
-- Configuration, per branch, in the database. There is deliberately no
-- "cash = locked" written into any code path; the app asks this table.
--
-- ─── What an ABSENT row means ────────────────────────────────────────────────
-- A default is unavoidable — a fresh install and a newly created branch both
-- have no rows — so the question is which default is defensible. It is derived
-- from one rule rather than listed per method: **a method whose receipts a person
-- can physically count is open; one that nobody at the counter ever handles is
-- closed.** That makes cash, Easypaisa and bank unlocked and Foodpanda locked out
-- of the box, because the aggregator settles Foodpanda and there is nothing at the
-- shop to count. The rule lives in one place — DAILY_SALE_MANUAL_METHODS in
-- shared/types/daily-sale.types.ts — and a stored row overrides it for any of the
-- four, in either direction, per branch. Which is what §12 asks for: configurable,
-- not hardcoded.
--
-- Fail-closed was considered and rejected: locking everything by default leaves
-- the Manual Feed button inert on every branch until an admin visits each one,
-- which is not a safety property, only a feature nobody can use.
create table if not exists payment_method_settings (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches (id) on delete cascade,
  -- The `payment_method` enum, so a typo cannot create a setting that governs
  -- nothing. 'staff' is a member of that enum and is meaningless here; the
  -- functions below never consult it and the API never offers it.
  payment_method payment_method not null,
  is_locked      boolean not null,
  updated_by     uuid references users (id) on delete set null,
  updated_by_name text,
  /** Why an admin changed it — shown beside the lock and copied into the audit. */
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint payment_method_settings_branch_method_key unique (branch_id, payment_method)
);

create index if not exists payment_method_settings_branch_idx on payment_method_settings (branch_id);

create trigger payment_method_settings_touch before update on payment_method_settings
  for each row execute function app.touch_updated_at();

comment on table payment_method_settings is
  'Per-branch lock configuration for manual payment entry on Daily Sale Records. An absent row means the shared default (see DAILY_SALE_MANUAL_METHODS).';

-- ---------------------------------------------------------------------------
-- Index on orders for the range this feature reads
-- ---------------------------------------------------------------------------
--
-- `orders_branch_created_idx (branch_id, created_at desc)` already exists and is
-- what prunes the scan. This adds the four payload columns as INCLUDE so the
-- aggregate below is an index-only scan and never visits the heap — the same
-- trick migration 100 used for its own rollup, and worth it here because the
-- branch page re-reads a 30-day window on every date change.
create index if not exists orders_branch_created_recon_idx
  on orders (branch_id, created_at)
  include (status, payment_method, grand_total, discount_total);

-- ---------------------------------------------------------------------------
-- public.daily_sale_figures — the AUTO side, aggregated in Postgres (§24, §25)
-- ---------------------------------------------------------------------------
--
-- One row per (branch, business date) that has any sale or any expense in the
-- window. Days with neither are absent rather than zero: unlike a sales GRAPH
-- (migration 100, which fills its series so a closed Sunday is not drawn as a
-- trend), a reconciliation list must not invite anybody to sign off a day the
-- shop never opened.
--
-- ─── This is buildBranchReport's arithmetic, deliberately ────────────────────
--   * `status <> 'cancelled'` — a cancelled order took no money.
--   * `payment_method <> 'staff'` for every MONEY figure — a staff sale is exempt
--     from payment (migration 36); the goods left and nothing came in. Reported
--     separately as `staff_total` so the parts still sum to the whole.
--   * `discount` summed over PAID orders only, matching buildBranchReport, which
--     skips a staff order before reaching its discount. NOTE this differs from
--     `computeClosingTotals` in shared/utils/closing.ts, which sums discounts over
--     every live order including staff. The two already disagreed before this
--     migration; this file follows buildBranchReport because that is the figure
--     Finance approves income from, and a reconciliation must agree with the money.
--   * orders filtered on `created_at` over business-day bounds — again as
--     buildBranchReport does, NOT on the stored `business_date` column. Same
--     reason: the finance path reads it this way, and a reconciliation that
--     bracketed the day differently from the income approval would produce two
--     defensible totals for one day, which is worse than either.
--   * expenses filtered on their stored `business_date`, which is the only day
--     column that table has.
--
-- The upper bound is half-open at the next 02:00 rather than inclusive at
-- 01:59:59.999. Migration 03 warns against half-open bounds because they DROP the
-- final millisecond; this one is a strict superset of the inclusive form, so the
-- warning does not apply — nothing can fall out of it.
create or replace function public.daily_sale_figures(
  p_from      date,
  p_to        date,
  p_branch_id uuid
)
returns table (
  branch_id     uuid,
  business_date date,
  total_sale    numeric,
  cash          numeric,
  easypaisa     numeric,
  foodpanda     numeric,
  bank          numeric,
  other         numeric,
  staff_total   numeric,
  discount      numeric,
  order_count   integer,
  cash_expense  numeric,
  expense_total numeric
)
language sql
stable
as $$
with sale_agg as (
  select o.branch_id                          as bid,
         app.business_date(o.created_at)      as bdate,
         sum(case when o.payment_method <> 'staff'      then o.grand_total    else 0 end) as total_sale,
         sum(case when o.payment_method =  'cash'       then o.grand_total    else 0 end) as cash,
         sum(case when o.payment_method =  'easypaisa'  then o.grand_total    else 0 end) as easypaisa,
         sum(case when o.payment_method =  'foodpanda'  then o.grand_total    else 0 end) as foodpanda,
         sum(case when o.payment_method = 'bank_account' then o.grand_total   else 0 end) as bank,
         -- Anything that is neither staff nor one of the four named methods.
         -- Forward-compatible: a method added to the enum later still shows up in
         -- a total instead of vanishing out of the breakdown.
         sum(case when o.payment_method not in ('staff','cash','easypaisa','foodpanda','bank_account')
                  then o.grand_total else 0 end)                                          as other,
         sum(case when o.payment_method =  'staff'      then o.grand_total    else 0 end) as staff_total,
         sum(case when o.payment_method <> 'staff'      then o.discount_total else 0 end) as discount,
         count(*) filter (where o.payment_method <> 'staff')                              as order_count
    from orders o
   -- ── The business-day window, as a sargable range on created_at ──
   --
   -- Business day D runs from Karachi D 02:00 to D+1 02:00, i.e. UTC (D-1) 21:00
   -- to D 21:00. Written inline rather than joined in from a CTE so the planner
   -- sees an ordinary range predicate and uses `orders_branch_created_recon_idx`;
   -- a cross join to a one-row CTE plans as a nested loop and is a needless
   -- obstacle between this query and its index.
   --
   -- HALF-OPEN at the top, deliberately. Migration 03 warns against half-open
   -- bounds because they drop the final millisecond of a business day; this one
   -- ends at the next 02:00 rather than at 01:59:59.999, so it is a strict
   -- SUPERSET of the inclusive form and nothing can fall out of it.
   where o.created_at >= ((  p_from::timestamp    + interval '2 hours' - interval '5 hours') at time zone 'UTC')
     and o.created_at <  (((p_to + 1)::timestamp  + interval '2 hours' - interval '5 hours') at time zone 'UTC')
     and o.status <> 'cancelled'
     and (p_branch_id is null or o.branch_id = p_branch_id)
   group by 1, 2
),
exp_agg as (
  select e.branch_id     as bid,
         e.business_date as bdate,
         sum(case when e.payment_method = 'cash' then e.amount else 0 end) as cash_expense,
         sum(e.amount)                                                     as expense_total
    from expenses e
   where e.business_date between p_from and p_to
     and (p_branch_id is null or e.branch_id = p_branch_id)
   group by 1, 2
),
keys as (
  select bid, bdate from sale_agg
  union
  select bid, bdate from exp_agg
)
select k.bid,
       k.bdate,
       coalesce(s.total_sale,    0),
       coalesce(s.cash,          0),
       coalesce(s.easypaisa,     0),
       coalesce(s.foodpanda,     0),
       coalesce(s.bank,          0),
       coalesce(s.other,         0),
       coalesce(s.staff_total,   0),
       coalesce(s.discount,      0),
       coalesce(s.order_count,   0)::integer,
       coalesce(e.cash_expense,  0),
       coalesce(e.expense_total, 0)
  from keys k
  left join sale_agg s on s.bid = k.bid and s.bdate = k.bdate
  left join exp_agg  e on e.bid = k.bid and e.bdate = k.bdate
 order by k.bdate desc, k.bid;
$$;

comment on function public.daily_sale_figures(date, date, uuid) is
  'AUTO reconciliation figures per branch per business day. Mirrors buildBranchReport() exactly — change both together.';

-- ---------------------------------------------------------------------------
-- app.payment_method_default_locked — the default when no setting row exists
-- ---------------------------------------------------------------------------
--
-- MIRRORS `DAILY_SALE_MANUAL_METHODS` in shared/types/daily-sale.types.ts. Two
-- copies, kept in step by hand, exactly as the `notification_type` enum and
-- `NotificationType` are — and for the same reason: the rule has to be applied
-- both inside a transaction that must not trust its caller and on a client that
-- has to decide whether to render an input. Change one, change the other.
--
-- The rule, once: a method whose receipts somebody physically handles is open to
-- manual entry; one the shop never touches is closed. See the header comment on
-- `payment_method_settings` for why a default is needed at all.
create or replace function app.payment_method_default_locked(m payment_method) returns boolean
  language sql
  immutable
  as $$ select m not in ('cash', 'easypaisa', 'bank_account') $$;

-- ---------------------------------------------------------------------------
-- public.ensure_daily_sale_record — create or refresh one day's record (§13, §14)
-- ---------------------------------------------------------------------------
--
-- Idempotent by construction. The unique key on (branch_id, business_date) is the
-- duplicate protection, and ON CONFLICT is how concurrent callers converge on one
-- row: a refresh, a second tab, a double-clicked button and a retried request all
-- end up updating the same record instead of racing to insert a second one.
--
-- ─── The auto snapshot FREEZES at sign-off ───────────────────────────────────
-- Auto figures are re-read only while the record is `open` or
-- `pending_verification`. Once it is verified, locked or amended, re-reading them
-- would restate the figures somebody has already signed their name against — the
-- record would silently stop matching what was verified, and the difference
-- column would move on its own. A later correction to a sale therefore does NOT
-- rewrite a closed record; an admin unlocks it, which puts it back in an open
-- state and lets the next refresh through.
create or replace function public.ensure_daily_sale_record(
  p_branch_id     uuid,
  p_business_date date,
  p_actor_id      uuid,
  p_actor_name    text,
  p_actor_role    text
) returns uuid
language plpgsql
as $$
declare
  v_branch_name text;
  v_fig         record;
  v_prior       daily_sale_records;
  v_id          uuid;
  v_frozen      boolean;
  v_action      daily_sale_audit_action;
begin
  select name into v_branch_name from branches where id = p_branch_id;
  if v_branch_name is null then
    raise exception 'Branch not found' using errcode = 'P0001';
  end if;

  -- At most one row: the function groups by (branch, date) and both are pinned.
  -- No row at all means a day with no sales and no expenses, which is a legitimate
  -- record of zero rather than an error — a shop that was shut still has a day to
  -- account for.
  --
  -- The LEFT JOIN against a one-row source is what guarantees `v_fig` always gets
  -- a row shape, even when the aggregate returns nothing. A bare `SELECT … INTO`
  -- over an empty result leaves a `record` variable in a state the field
  -- references below would be reading on trust, and every one of those fields is
  -- a money figure — not the place to depend on a subtlety.
  select f.* into v_fig
    from (select 1) as one
    left join public.daily_sale_figures(p_business_date, p_business_date, p_branch_id) f
           on true
   limit 1;

  select * into v_prior
    from daily_sale_records
   where branch_id = p_branch_id and business_date = p_business_date;

  v_frozen := v_prior.id is not null
              and v_prior.status not in ('open', 'pending_verification');

  insert into daily_sale_records (
    branch_id, branch_name, business_date,
    auto_total_sale, auto_cash, auto_easypaisa, auto_foodpanda, auto_bank, auto_other, auto_staff,
    discount, cash_expense, expense_total, order_count, generated_at,
    created_by, created_by_name
  ) values (
    p_branch_id, v_branch_name, p_business_date,
    coalesce(v_fig.total_sale, 0), coalesce(v_fig.cash, 0), coalesce(v_fig.easypaisa, 0),
    coalesce(v_fig.foodpanda, 0), coalesce(v_fig.bank, 0), coalesce(v_fig.other, 0),
    coalesce(v_fig.staff_total, 0), coalesce(v_fig.discount, 0), coalesce(v_fig.cash_expense, 0),
    coalesce(v_fig.expense_total, 0), coalesce(v_fig.order_count, 0), now(),
    p_actor_id, p_actor_name
  )
  on conflict (branch_id, business_date) do update set
    -- `v_frozen` and not a predicate on the DO UPDATE clause: a WHERE there would
    -- skip the row entirely and RETURNING would hand back nothing, leaving the
    -- caller with no id for a record that plainly exists.
    auto_total_sale = case when v_frozen then daily_sale_records.auto_total_sale else excluded.auto_total_sale end,
    auto_cash       = case when v_frozen then daily_sale_records.auto_cash       else excluded.auto_cash       end,
    auto_easypaisa  = case when v_frozen then daily_sale_records.auto_easypaisa  else excluded.auto_easypaisa  end,
    auto_foodpanda  = case when v_frozen then daily_sale_records.auto_foodpanda  else excluded.auto_foodpanda  end,
    auto_bank       = case when v_frozen then daily_sale_records.auto_bank       else excluded.auto_bank       end,
    auto_other      = case when v_frozen then daily_sale_records.auto_other      else excluded.auto_other      end,
    auto_staff      = case when v_frozen then daily_sale_records.auto_staff      else excluded.auto_staff      end,
    discount        = case when v_frozen then daily_sale_records.discount        else excluded.discount        end,
    cash_expense    = case when v_frozen then daily_sale_records.cash_expense    else excluded.cash_expense    end,
    expense_total   = case when v_frozen then daily_sale_records.expense_total   else excluded.expense_total   end,
    order_count     = case when v_frozen then daily_sale_records.order_count     else excluded.order_count     end,
    generated_at    = case when v_frozen then daily_sale_records.generated_at    else now()                    end,
    -- Kept current whatever the status: this is a display label, not a figure, and
    -- a record still naming a branch by its old name is a different kind of wrong.
    branch_name     = excluded.branch_name
  returning id into v_id;

  -- ── Audit only when something actually happened ──
  --
  -- This function is called on every read of the page, so auditing each call
  -- unconditionally would bury the entries that matter under thousands that say
  -- "somebody looked at Tuesday". A first snapshot is always worth a row; a
  -- refresh only when a figure moved.
  if v_prior.id is null then
    v_action := 'generated';
  elsif not v_frozen and row(
      v_prior.auto_total_sale, v_prior.auto_cash, v_prior.auto_easypaisa, v_prior.auto_foodpanda,
      v_prior.auto_bank, v_prior.auto_other, v_prior.auto_staff, v_prior.discount,
      v_prior.cash_expense, v_prior.expense_total, v_prior.order_count
    ) is distinct from row(
      coalesce(v_fig.total_sale, 0), coalesce(v_fig.cash, 0), coalesce(v_fig.easypaisa, 0),
      coalesce(v_fig.foodpanda, 0), coalesce(v_fig.bank, 0), coalesce(v_fig.other, 0),
      coalesce(v_fig.staff_total, 0), coalesce(v_fig.discount, 0), coalesce(v_fig.cash_expense, 0),
      coalesce(v_fig.expense_total, 0), coalesce(v_fig.order_count, 0)
    ) then
    v_action := 'refreshed';
  else
    v_action := null;
  end if;

  if v_action is not null then
    insert into daily_sale_record_audits (
      record_id, branch_id, business_date, action, field, old_value, new_value,
      actor_id, actor_name, actor_role
    ) values (
      v_id, p_branch_id, p_business_date, v_action, 'auto_total_sale',
      case when v_prior.id is null then null else v_prior.auto_total_sale::text end,
      coalesce(v_fig.total_sale, 0)::text,
      p_actor_id, p_actor_name, p_actor_role
    );
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.feed_daily_sale_record — record what was physically counted (§7-§10)
-- ---------------------------------------------------------------------------
--
-- ─── The lock is enforced HERE ───────────────────────────────────────────────
-- §10 is explicit that a disabled input in React is not enforcement. It is not
-- enforcement in the route handler either, strictly speaking — the check and the
-- write would be two PostgREST calls and therefore two transactions, so a lock
-- flipped between them would be missed. Both live in this function, in one
-- transaction, reading `payment_method_settings` itself.
--
-- An admin may write into a locked method; the entry is audited as
-- `manual_feed_override` rather than `manual_feed`, because an override is the
-- most sensitive thing this feature permits and must never read like routine
-- data entry.
--
-- ─── A closed record refuses EVERYBODY, admin included ───────────────────────
-- Not an oversight and not a gap in the admin's authority: an admin correcting a
-- signed-off figure goes through `amend_daily_sale_record`, which demands a
-- reason and records the old value. Letting them reach it through the ordinary
-- feed path would be the one route by which a verified figure could change with
-- nothing written down.
--
-- Passing NULL for a method leaves that method's stored count alone, so a partial
-- count (cash now, bank when the slip arrives) is one call per figure rather than
-- a re-key of all three.
create or replace function public.feed_daily_sale_record(
  p_branch_id     uuid,
  p_business_date date,
  p_cash          numeric,
  p_easypaisa     numeric,
  p_bank          numeric,
  p_actor_id      uuid,
  p_actor_name    text,
  p_actor_role    text,
  p_is_admin      boolean
) returns uuid
language plpgsql
as $$
declare
  v_id     uuid;
  v_rec    daily_sale_records;
  v_row    record;
  v_locked boolean;
  v_wrote  boolean := false;
begin
  if p_cash is null and p_easypaisa is null and p_bank is null then
    raise exception 'Enter at least one counted amount' using errcode = 'P0001';
  end if;

  -- Refresh the auto figures first, so the count is compared against what the
  -- sales system says NOW rather than against a snapshot taken hours earlier.
  -- This is also what creates the record when the day has never been opened.
  v_id := public.ensure_daily_sale_record(p_branch_id, p_business_date, p_actor_id, p_actor_name, p_actor_role);

  select * into v_rec from daily_sale_records where id = v_id for update;

  if v_rec.status not in ('open', 'pending_verification') then
    raise exception 'This record is % and can no longer be fed. An admin must unlock or amend it.', v_rec.status
      using errcode = 'P0001';
  end if;

  for v_row in
    select * from (values
      ('cash'::payment_method,         'manual_cash',      p_cash,      v_rec.manual_cash),
      ('easypaisa'::payment_method,    'manual_easypaisa', p_easypaisa, v_rec.manual_easypaisa),
      ('bank_account'::payment_method, 'manual_bank',      p_bank,      v_rec.manual_bank)
    ) as t(method, field, new_value, old_value)
     where new_value is not null
       and new_value is distinct from old_value
  loop
    v_locked := coalesce(
      (select s.is_locked from payment_method_settings s
        where s.branch_id = p_branch_id and s.payment_method = v_row.method),
      app.payment_method_default_locked(v_row.method)
    );

    if v_locked and not p_is_admin then
      -- 42501 (insufficient_privilege) rather than the default P0001, so the
      -- service layer can answer 403 for "you are not allowed to" and keep 409
      -- for "the record is in the wrong state". Two different fixes, and the
      -- branch should not be told to try again on the first one.
      raise exception '% is locked for manual entry at this branch. Ask an admin to unlock it.', v_row.method
        using errcode = '42501';
    end if;

    insert into daily_sale_record_audits (
      record_id, branch_id, business_date, action, field, old_value, new_value,
      actor_id, actor_name, actor_role
    ) values (
      v_id, p_branch_id, p_business_date,
      case when v_locked then 'manual_feed_override'::daily_sale_audit_action
           else 'manual_feed'::daily_sale_audit_action end,
      v_row.field,
      v_row.old_value::text,
      v_row.new_value::text,
      p_actor_id, p_actor_name, p_actor_role
    );
    v_wrote := true;
  end loop;

  -- Nothing changed — every figure sent already matched what was stored. Return
  -- without touching the row, so a resubmitted form (a double-clicked Save, a
  -- retried request) does not restamp `fed_at` and attribute the count to whoever
  -- pressed the button second.
  if not v_wrote then
    return v_id;
  end if;

  update daily_sale_records set
    manual_cash      = coalesce(p_cash,      manual_cash),
    manual_easypaisa = coalesce(p_easypaisa, manual_easypaisa),
    manual_bank      = coalesce(p_bank,      manual_bank),
    fed_by           = p_actor_id,
    fed_by_name      = p_actor_name,
    fed_at           = now(),
    status           = 'pending_verification'
   where id = v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.decide_daily_sale_record — verify / lock / unlock (§11, §15)
-- ---------------------------------------------------------------------------
--
--   verify  — sign off the counted figures.       'open'|'pending_verification' → 'verified'
--   lock     — close the record to the branch.     'verified'|'amended'          → 'locked'
--   unlock   — put it back in play, with a reason. 'verified'|'locked'|'amended' → 'pending_verification'
--
-- `verify` is allowed from `open` deliberately. Two real cases reach sign-off
-- with nothing fed: a day the shop took no money at all, and a branch whose every
-- payment method an admin has locked. Refusing those would leave a record that
-- can never be closed, and the difference columns stay NULL — which reads as
-- "not counted", which is the truth.
--
-- `lock` and `unlock` are admin-only, checked here as well as by requireRole in
-- the router. The duplication is deliberate for these two: they are the actions
-- that decide whether a branch can still change a figure, and a bug in a future
-- route mount must not be the only thing standing between a branch and its own
-- signed-off record.
--
-- An unlock CLEARS the verification and the lock stamps. Leaving a verified_by on
-- a record that has gone back to being counted would attribute a sign-off to
-- somebody who signed off different numbers.
create or replace function public.decide_daily_sale_record(
  p_id         uuid,
  p_action     text,
  p_reason     text,
  p_actor_id   uuid,
  p_actor_name text,
  p_actor_role text,
  p_is_admin   boolean
) returns uuid
language plpgsql
as $$
declare
  v_rec    daily_sale_records;
  v_next   daily_sale_record_status;
  v_action daily_sale_audit_action;
begin
  select * into v_rec from daily_sale_records where id = p_id for update;
  if v_rec.id is null then
    raise exception 'Daily Sale Record not found' using errcode = 'P0001';
  end if;

  if p_action = 'verify' then
    if v_rec.status not in ('open', 'pending_verification') then
      raise exception 'This record is already % and cannot be verified again.', v_rec.status
        using errcode = 'P0001';
    end if;
    v_next := 'verified'; v_action := 'verified';

    update daily_sale_records set
      status = v_next, verified_by = p_actor_id, verified_by_name = p_actor_name, verified_at = now()
     where id = p_id;

  elsif p_action = 'lock' then
    if not p_is_admin then
      raise exception 'Only an admin can lock a Daily Sale Record' using errcode = '42501';
    end if;
    if v_rec.status not in ('verified', 'amended') then
      raise exception 'Verify this record before locking it (it is currently %).', v_rec.status
        using errcode = 'P0001';
    end if;
    v_next := 'locked'; v_action := 'locked';

    update daily_sale_records set
      status = v_next, locked_by = p_actor_id, locked_by_name = p_actor_name, locked_at = now()
     where id = p_id;

  elsif p_action = 'unlock' then
    if not p_is_admin then
      raise exception 'Only an admin can unlock a Daily Sale Record' using errcode = '42501';
    end if;
    if v_rec.status not in ('verified', 'locked', 'amended') then
      raise exception 'This record is already open (%).', v_rec.status using errcode = 'P0001';
    end if;
    -- §11: every unlock is recorded WITH ITS REASON. Enforced here rather than
    -- only in the Zod schema, because the reason is the entire audit value of an
    -- unlock — "Admin unlocked Cash" on its own answers nothing.
    if coalesce(btrim(p_reason), '') = '' then
      raise exception 'Say why this record is being unlocked' using errcode = 'P0001';
    end if;
    v_next := 'pending_verification'; v_action := 'unlocked';

    update daily_sale_records set
      status = v_next,
      verified_by = null, verified_by_name = null, verified_at = null,
      locked_by   = null, locked_by_name   = null, locked_at   = null
     where id = p_id;

  else
    raise exception 'Unknown action "%"', p_action using errcode = 'P0001';
  end if;

  insert into daily_sale_record_audits (
    record_id, branch_id, business_date, action, field, old_value, new_value, reason,
    actor_id, actor_name, actor_role
  ) values (
    p_id, v_rec.branch_id, v_rec.business_date, v_action, 'status',
    v_rec.status::text, v_next::text, nullif(btrim(coalesce(p_reason, '')), ''),
    p_actor_id, p_actor_name, p_actor_role
  );

  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.amend_daily_sale_record — an admin corrects a closed record (§16)
-- ---------------------------------------------------------------------------
--
-- ONLY the manual columns are amendable. An `auto_*` figure is derived from
-- `orders`, and a wrong one means a wrong SALE — corrected by correcting the sale
-- (the Help Desk is the audited channel for exactly that), never by overwriting
-- the reconciliation, which would leave the ledger and this record each claiming
-- to be right about the same day. That is §28 restated as a constraint rather
-- than as advice.
--
-- The old value is never lost: it goes to `daily_sale_record_audits` in the same
-- transaction as the new one is written. The record moves to `amended`, a state
-- distinct from `locked`, so "this was changed after sign-off" is visible on the
-- board rather than buried in the history.
--
-- The column is chosen by CASE rather than by building SQL with EXECUTE — a
-- field name arriving from a request should not be able to become an identifier.
create or replace function public.amend_daily_sale_record(
  p_id         uuid,
  p_field      text,
  p_amount     numeric,
  p_reason     text,
  p_actor_id   uuid,
  p_actor_name text,
  p_actor_role text
) returns uuid
language plpgsql
as $$
declare
  v_rec daily_sale_records;
  v_old numeric;
begin
  if p_field not in ('manual_cash', 'manual_easypaisa', 'manual_bank') then
    raise exception 'Only a counted figure can be amended (got "%")', p_field using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'An amended amount must be zero or more' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why this figure is being amended' using errcode = 'P0001';
  end if;

  select * into v_rec from daily_sale_records where id = p_id for update;
  if v_rec.id is null then
    raise exception 'Daily Sale Record not found' using errcode = 'P0001';
  end if;
  -- An open record is not amended, it is fed. Sending it here would write an
  -- 'amended' history entry and an `amended_at` for an ordinary first count.
  if v_rec.status not in ('verified', 'locked', 'amended') then
    raise exception 'This record is still open — use Manual Feed rather than an amendment.'
      using errcode = 'P0001';
  end if;

  v_old := case p_field
             when 'manual_cash'      then v_rec.manual_cash
             when 'manual_easypaisa' then v_rec.manual_easypaisa
             else                         v_rec.manual_bank
           end;

  update daily_sale_records set
    manual_cash      = case when p_field = 'manual_cash'      then p_amount else manual_cash      end,
    manual_easypaisa = case when p_field = 'manual_easypaisa' then p_amount else manual_easypaisa end,
    manual_bank      = case when p_field = 'manual_bank'      then p_amount else manual_bank      end,
    status     = 'amended',
    amended_at = now()
   where id = p_id;

  insert into daily_sale_record_audits (
    record_id, branch_id, business_date, action, field, old_value, new_value, reason,
    actor_id, actor_name, actor_role
  ) values (
    p_id, v_rec.branch_id, v_rec.business_date, 'amended', p_field,
    v_old::text, p_amount::text, btrim(p_reason),
    p_actor_id, p_actor_name, p_actor_role
  );

  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.set_payment_method_lock — admin configures a branch's locks (§11, §12)
-- ---------------------------------------------------------------------------
--
-- Upsert plus audit in one transaction. The audit row carries no `record_id`:
-- a lock governs the branch, not one day's record, and attaching it to whichever
-- record happened to exist would have generated a Daily Sale Record for a day
-- nobody had opened yet just to have something to point at.
create or replace function public.set_payment_method_lock(
  p_branch_id      uuid,
  p_payment_method payment_method,
  p_is_locked      boolean,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_actor_role     text
) returns void
language plpgsql
as $$
declare
  v_prior boolean;
begin
  if p_payment_method = 'staff' then
    raise exception 'A staff sale takes no money and has nothing to reconcile' using errcode = 'P0001';
  end if;
  if not exists (select 1 from branches where id = p_branch_id) then
    raise exception 'Branch not found' using errcode = 'P0001';
  end if;

  select s.is_locked into v_prior
    from payment_method_settings s
   where s.branch_id = p_branch_id and s.payment_method = p_payment_method;

  insert into payment_method_settings (
    branch_id, payment_method, is_locked, reason, updated_by, updated_by_name
  ) values (
    p_branch_id, p_payment_method, p_is_locked,
    nullif(btrim(coalesce(p_reason, '')), ''), p_actor_id, p_actor_name
  )
  on conflict (branch_id, payment_method) do update set
    is_locked       = excluded.is_locked,
    reason          = excluded.reason,
    updated_by      = excluded.updated_by,
    updated_by_name = excluded.updated_by_name;

  -- Nothing to record when the stored state already said this. An admin opening
  -- the panel and pressing Save should not leave a history entry claiming a
  -- change that did not happen.
  if v_prior is not distinct from p_is_locked then
    return;
  end if;

  insert into daily_sale_record_audits (
    record_id, branch_id, business_date, action, field, old_value, new_value, reason,
    actor_id, actor_name, actor_role
  ) values (
    null, p_branch_id, app.business_date(now()),
    case when p_is_locked then 'method_locked'::daily_sale_audit_action
         else 'method_unlocked'::daily_sale_audit_action end,
    p_payment_method::text,
    -- Null where there was no stored row: "it was on the default" is a different
    -- fact from "it was explicitly unlocked", and flattening the two would make
    -- the first configuration of a branch unreadable afterwards.
    v_prior::text,
    p_is_locked::text,
    nullif(btrim(coalesce(p_reason, '')), ''),
    p_actor_id, p_actor_name, p_actor_role
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS (§27)
-- ---------------------------------------------------------------------------
--
-- On, with branch-scoped select policies, exactly as migration 93 does for
-- `branch_discounts`. The API reaches all three tables through the service-role
-- client, which bypasses RLS entirely and re-decides every request against the
-- JWT in application code — so these policies are the floor under a direct
-- client read, not the authorisation the app relies on. There is no insert,
-- update or delete policy at all: every write goes through one of the functions
-- above, called with the service role.
alter table daily_sale_records        enable row level security;
alter table daily_sale_record_audits  enable row level security;
alter table payment_method_settings   enable row level security;

drop policy if exists daily_sale_records_select_branch on daily_sale_records;
create policy daily_sale_records_select_branch on daily_sale_records
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

drop policy if exists daily_sale_audits_select_branch on daily_sale_record_audits;
create policy daily_sale_audits_select_branch on daily_sale_record_audits
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

drop policy if exists payment_method_settings_select_branch on payment_method_settings;
create policy payment_method_settings_select_branch on payment_method_settings
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

-- ---------------------------------------------------------------------------
-- Grants — service_role only, like every other function in this schema
-- ---------------------------------------------------------------------------
--
-- These functions decide who may write to a signed-off financial record from
-- parameters their caller supplies (`p_is_admin`, `p_actor_role`). A client that
-- could call them directly could pass whatever it liked, so `authenticated` is
-- revoked explicitly rather than left to default grants.
revoke all on function public.daily_sale_figures(date, date, uuid) from public, anon, authenticated;
grant execute on function public.daily_sale_figures(date, date, uuid) to service_role;

revoke all on function public.ensure_daily_sale_record(uuid, date, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ensure_daily_sale_record(uuid, date, uuid, text, text) to service_role;

revoke all on function public.feed_daily_sale_record(uuid, date, numeric, numeric, numeric, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.feed_daily_sale_record(uuid, date, numeric, numeric, numeric, uuid, text, text, boolean) to service_role;

revoke all on function public.decide_daily_sale_record(uuid, text, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.decide_daily_sale_record(uuid, text, text, uuid, text, text, boolean) to service_role;

revoke all on function public.amend_daily_sale_record(uuid, text, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.amend_daily_sale_record(uuid, text, numeric, text, uuid, text, text) to service_role;

revoke all on function public.set_payment_method_lock(uuid, payment_method, boolean, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_payment_method_lock(uuid, payment_method, boolean, text, uuid, text, text) to service_role;
