-- 52: Finance Ledger — the company's book of account.
--
-- READ THIS BEFORE CHANGING ANYTHING BELOW.
--
-- This module is not another operations table. It is a LEDGER, and the three
-- properties that make it one are enforced here rather than in application code:
--
--   1. APPEND-ONLY. `ledger_entries` has no UPDATE path for its money columns
--      and a trigger that refuses to let one exist (finance_ledger_immutable).
--      A wrong figure is corrected with a reversing entry that leaves the
--      original in the book. `delete` is refused outright.
--   2. GAPLESS VOUCHERS. FV-000001 onwards, allocated from `counters` exactly
--      like MB-/EXP-/DMD- (migrations 03 and 24). A Postgres SEQUENCE is again
--      deliberately NOT used: sequences gap on rollback and the business treats
--      a missing voucher number as a missing voucher.
--   3. A RUNNING BALANCE THAT WAS REALLY TRUE. `balance` is the book balance at
--      the instant of posting, computed under an advisory lock inside
--      post_finance_ledger_entry so two concurrent approvals cannot interleave
--      into an impossible sequence.
--
-- ORDERING NOTE, because it surprises people: the ledger is ordered by `seq`
-- (posting order), not by `entry_date`. The `balance` column only means anything
-- in posting order. Day-scoped figures — the Daily Closing page, every report —
-- come from finance_day_summary(), which aggregates by `entry_date` and never
-- reads `balance`. Posting into an already-closed day is refused, which is what
-- keeps the two views from drifting apart in practice.
--
-- Money is numeric(14,2) throughout, per the schema conventions in migration 01.
-- Business dates are `date` and come from the app's businessDateStr() — 2 AM
-- Karachi rollover, never now()::date.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type ledger_head_type      as enum ('income', 'expense');
create type finance_account       as enum ('cash', 'bank');
create type ledger_entry_status   as enum ('posted', 'locked', 'reversed');
create type finance_doc_status    as enum ('draft', 'pending_approval', 'approved', 'posted', 'locked', 'rejected');
create type finance_income_status as enum ('pending_verification', 'pending_approval', 'approved', 'rejected');
create type finance_ledger_source as enum (
  'opening', 'manual', 'branch_income', 'company_share', 'branch_share',
  'salary', 'partner_expense', 'adjustment'
);

-- ---------------------------------------------------------------------------
-- Role helpers for the policies further down.
--
-- Safe to create here: migration 51 added and COMMITTED the four finance enum
-- values, so a `language sql` body may now reference them (the parser validates
-- these at CREATE time, which is exactly why 51 had to be a separate file).
-- ---------------------------------------------------------------------------

create or replace function app.is_finance() returns boolean
  language sql stable
  as $$
    select app.jwt_role() in (
      'finance_admin'::user_role,
      'finance_manager'::user_role,
      'accountant'::user_role,
      'finance_auditor'::user_role
    )
  $$;

-- Who may SEE finance data. Super Admin is included because the brief grants
-- them reports; whether they may WRITE is application policy (financeCan() +
-- the allow_super_admin_write setting), never RLS — see the note above the
-- policies at the bottom of this file.
create or replace function app.can_read_finance() returns boolean
  language sql stable
  as $$ select app.is_finance() or app.is_super_admin() $$;

-- The policies at the bottom of this file call these under a USER JWT, so
-- `authenticated` needs EXECUTE — and USAGE on schema `app`, which migration 31
-- already granted. Without this the finance policies fail with
--   ERROR 42501: permission denied for function is_finance
-- and PostgREST turns every direct client read into an error response. Migration
-- 31's header has the full story; it is the same trap.
grant execute on function app.is_finance()       to anon, authenticated;
grant execute on function app.can_read_finance() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- finance_settings — one row, like `settings`.
--
-- The single-row shape is enforced by a PK that can only ever hold `true`, which
-- is cheaper and harder to get wrong than a trigger counting rows.
--
-- company_share_pct / branch_share_pct are the whole reason this table exists:
-- the brief is explicit that 75/25 must be configurable and not hardcoded. The
-- CHECK keeps them summing to 100 so a half-applied edit cannot silently create
-- or destroy income at the split.
-- ---------------------------------------------------------------------------
create table finance_settings (
  id                        boolean primary key default true check (id),
  company_share_pct         numeric(5,2) not null default 75,
  branch_share_pct          numeric(5,2) not null default 25,
  share_basis               text not null default 'gross' check (share_basis in ('gross', 'net')),
  opening_cash_balance      numeric(14,2) not null default 0,
  opening_bank_balance      numeric(14,2) not null default 0,
  opening_balance_date      date,
  auto_import_branch_income boolean not null default true,
  require_admin_verification boolean not null default true,
  -- "Admin can view reports but cannot modify finance records unless granted
  -- permission" — this is that grant. Off by default and deliberately so:
  -- separation of duties is the point of a finance module.
  allow_super_admin_write   boolean not null default false,
  updated_at                timestamptz not null default now(),
  updated_by                text not null default '',
  constraint finance_shares_sum_100
    check (abs(company_share_pct + branch_share_pct - 100) < 0.005)
);

insert into finance_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- ledger_heads — the chart of accounts.
--
-- `is_system` marks the heads the automatic postings resolve by code. They can
-- be renamed (the ledger snapshots the name onto every entry anyway) but never
-- deactivated or deleted, or the branch-income import has nowhere to post. The
-- trigger below enforces that rather than trusting every future route to check.
-- ---------------------------------------------------------------------------
create table ledger_heads (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  type        ledger_head_type not null,
  description text,
  group_name  text,
  is_active   boolean not null default true,
  is_system   boolean not null default false,
  sort_order  integer not null default 0,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index ledger_heads_type_idx on ledger_heads (type, sort_order, name) where is_active;

create trigger ledger_heads_touch before update on ledger_heads
  for each row execute function app.touch_updated_at();

create or replace function app.protect_system_ledger_heads() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      if old.is_system then
        raise exception 'ledger head % is a system head and cannot be deleted', old.code;
      end if;
      return old;
    end if;

    if old.is_system and new.is_active = false then
      raise exception 'ledger head % is a system head and cannot be deactivated', old.code;
    end if;
    -- The code is what the automatic postings resolve by, and reports group on
    -- it. Renaming the head is fine; re-coding it is not.
    if old.code is distinct from new.code then
      raise exception 'ledger head code is immutable (% -> %); create a new head instead', old.code, new.code;
    end if;
    if old.type is distinct from new.type then
      raise exception 'ledger head type is immutable; income and expense heads are not interchangeable';
    end if;
    return new;
  end;
  $$;

create trigger ledger_heads_protect
  before update or delete on ledger_heads
  for each row execute function app.protect_system_ledger_heads();

-- Any head that has ever been posted to must survive for the ledger to render
-- its own history, so the FK from ledger_entries is ON DELETE RESTRICT (below)
-- and deletion of a used head fails. That is intended: deactivate instead.

-- ---------------------------------------------------------------------------
-- Voucher / document number allocators.
--
-- Same counter-row pattern as migration 24. One counter per document family so
-- the number series read sensibly on paper: FV- vouchers, FTX- manual entries,
-- INC- branch income, SAL- salaries, PEX- partner expenses, EMP- employees.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values
  ('finance_voucher',  0),
  ('finance_txn',      0),
  ('finance_income',   0),
  ('finance_salary',   0),
  ('finance_partner',  0),
  ('finance_employee', 0)
  on conflict (id) do nothing;

create or replace function app.next_finance_number(p_key text, p_prefix text) returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = p_key returning count into next_count;
    if not found then
      raise exception 'counters row "%" is missing — see migration 46; counters is configuration, not data', p_key;
    end if;
    return p_prefix || '-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- ledger_entries — the posted book.
--
-- debit  = money IN  (a receipt; increases the balance)
-- credit = money OUT (a payment)
-- Exactly one of the two is non-zero on every row; the CHECK enforces it, which
-- is what stops a "net" entry that no cash book could ever show.
-- ---------------------------------------------------------------------------
create table ledger_entries (
  id                   uuid primary key default gen_random_uuid(),
  voucher_no           text not null unique,
  seq                  bigserial not null unique,
  entry_date           date not null,
  ledger_head_id       uuid references ledger_heads (id) on delete restrict,
  ledger_head_name     text not null,
  ledger_head_type     ledger_head_type not null,
  branch_id            uuid references branches (id) on delete set null,
  branch_name          text,
  description          text not null,
  debit                numeric(14,2) not null default 0 check (debit  >= 0),
  credit               numeric(14,2) not null default 0 check (credit >= 0),
  balance              numeric(14,2) not null,
  account              finance_account not null,
  payment_method       text,
  status               ledger_entry_status not null default 'posted',
  source_type          finance_ledger_source not null,
  source_id            uuid,
  reverses_entry_id    uuid references ledger_entries (id) on delete restrict,
  reversed_by_entry_id uuid references ledger_entries (id) on delete restrict,
  approved_by          uuid references users (id) on delete set null,
  approved_by_name     text,
  created_by           uuid references users (id) on delete set null,
  created_by_name      text,
  posted_at            timestamptz not null default now(),
  constraint ledger_entry_one_sided
    check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);

create index ledger_entries_date_idx    on ledger_entries (entry_date desc, seq desc);
create index ledger_entries_head_idx    on ledger_entries (ledger_head_id, entry_date desc);
create index ledger_entries_branch_idx  on ledger_entries (branch_id, entry_date desc) where branch_id is not null;
create index ledger_entries_source_idx  on ledger_entries (source_type, source_id);
create index ledger_entries_account_idx on ledger_entries (account, entry_date desc);

-- An entry may be reversed exactly once. Without this, two approvers racing on
-- the same bad voucher would each post a reversal and the book would end up
-- short by the amount — the second reversal looks perfectly legitimate on its
-- own, which is precisely why it has to be impossible.
create unique index ledger_entries_one_reversal_idx
  on ledger_entries (reverses_entry_id) where reverses_entry_id is not null;

-- ---------------------------------------------------------------------------
-- Immutability.
--
-- Application code is not trusted with this. The whole value of a ledger is that
-- nobody — including a future route handler written in a hurry, including the
-- service-role key, which bypasses RLS but NOT triggers — can quietly restate a
-- posted figure.
--
-- The narrow exceptions are the two bookkeeping columns that a reversal has to
-- write back onto the original row (`status`, `reversed_by_entry_id`) and the
-- day-close sweep flipping `posted` to `locked`.
-- ---------------------------------------------------------------------------
create or replace function app.finance_ledger_immutable() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      raise exception
        'ledger entry % cannot be deleted. A posted entry is permanent: correct it '
        'with a reversing or adjustment entry so the original stays visible.', old.voucher_no;
    end if;

    if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
        new.balance, new.account, new.source_type, new.source_id, new.description)
       is distinct from
       (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
        old.balance, old.account, old.source_type, old.source_id, old.description)
    then
      raise exception
        'ledger entry % is immutable. Only status and reversal linkage may change; '
        'post a reversing or adjustment entry instead.', old.voucher_no;
    end if;
    return new;
  end;
  $$;

create trigger ledger_entries_immutable
  before update or delete on ledger_entries
  for each row execute function app.finance_ledger_immutable();

-- ---------------------------------------------------------------------------
-- finance_day_closings — opening/closing per business date.
--
-- Only CLOSED days get a row. An open day's figures are derived on read by
-- finance_day_summary(), so there is never a stored total that can disagree with
-- the entries behind it.
-- ---------------------------------------------------------------------------
create table finance_day_closings (
  business_date    date primary key,
  opening_balance  numeric(14,2) not null,
  opening_cash     numeric(14,2) not null,
  opening_bank     numeric(14,2) not null,
  total_income     numeric(14,2) not null,
  total_expenses   numeric(14,2) not null,
  net_balance      numeric(14,2) not null,
  cash_in_hand     numeric(14,2) not null,
  bank_balance     numeric(14,2) not null,
  closing_balance  numeric(14,2) not null,
  entry_count      integer not null default 0,
  notes            text,
  closed_by        uuid references users (id) on delete set null,
  closed_by_name   text,
  closed_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The posting primitive.
--
-- EVERY rupee that reaches the ledger goes through this function, and it is the
-- only thing that writes `ledger_entries`. PostgREST gives each call its own
-- transaction, so the allocate-number / read-last-balance / insert sequence
-- cannot be made atomic from the app layer — the same reason the POS sale and
-- the stock movements live in SQL functions (see migrations 12 and 33).
--
-- The advisory lock is transaction-scoped and taken on one fixed key, so all
-- postings serialise against each other. That is a real serialisation point, and
-- it is the correct trade: a ledger with a running balance has no meaning
-- without one, and finance posts tens of vouchers a day, not thousands a second.
-- ---------------------------------------------------------------------------
create or replace function post_finance_ledger_entry(
  p_entry_date        date,
  p_ledger_head_id    uuid,
  p_description       text,
  p_debit             numeric,
  p_credit            numeric,
  p_account           finance_account,
  p_source_type       finance_ledger_source,
  p_source_id         uuid          default null,
  p_branch_id         uuid          default null,
  p_branch_name       text          default null,
  p_payment_method    text          default null,
  p_approved_by       uuid          default null,
  p_approved_by_name  text          default null,
  p_created_by        uuid          default null,
  p_created_by_name   text          default null,
  p_reverses_entry_id uuid          default null
) returns ledger_entries
  language plpgsql
  as $$
  declare
    v_head    ledger_heads%rowtype;
    v_prev    numeric(14,2);
    v_entry   ledger_entries%rowtype;
    v_debit   numeric(14,2) := round(coalesce(p_debit, 0), 2);
    v_credit  numeric(14,2) := round(coalesce(p_credit, 0), 2);
  begin
    if (v_debit > 0) = (v_credit > 0) then
      raise exception 'a ledger entry must be exactly one of debit or credit (got debit=%, credit=%)',
        v_debit, v_credit;
    end if;

    select * into v_head from ledger_heads where id = p_ledger_head_id;
    if not found then
      raise exception 'ledger head % does not exist', p_ledger_head_id;
    end if;
    -- An inactive head may still be REVERSED against (the original posting
    -- predates the deactivation), but nothing new may be filed under it.
    if not v_head.is_active and p_reverses_entry_id is null then
      raise exception 'ledger head % (%) is inactive and cannot accept new entries', v_head.code, v_head.name;
    end if;

    if exists (select 1 from finance_day_closings where business_date = p_entry_date) then
      raise exception
        'the finance day % is closed. Post the correction to an open date — a closed '
        'day is locked so its reported closing balance stays the one that was signed off.',
        p_entry_date;
    end if;

    -- Serialise every posting: the running balance below is only meaningful if
    -- no other posting can slip between the read and the insert.
    perform pg_advisory_xact_lock(hashtext('finance_ledger_post'));

    select balance into v_prev from ledger_entries order by seq desc limit 1;
    v_prev := coalesce(v_prev, 0);

    insert into ledger_entries (
      voucher_no, entry_date, ledger_head_id, ledger_head_name, ledger_head_type,
      branch_id, branch_name, description, debit, credit, balance, account,
      payment_method, source_type, source_id, reverses_entry_id,
      approved_by, approved_by_name, created_by, created_by_name
    ) values (
      app.next_finance_number('finance_voucher', 'FV'),
      p_entry_date, v_head.id, v_head.name, v_head.type,
      p_branch_id, p_branch_name, p_description, v_debit, v_credit,
      v_prev + v_debit - v_credit, p_account,
      p_payment_method, p_source_type, p_source_id, p_reverses_entry_id,
      p_approved_by, p_approved_by_name, p_created_by, p_created_by_name
    )
    returning * into v_entry;

    return v_entry;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Reversal / adjustment — the only sanctioned way to change a posted figure.
--
-- Posts a mirror entry (the sides swapped) on `p_entry_date`, which is the
-- CURRENT open business date, not the original's — you cannot post into a closed
-- day, and rewriting a signed-off day is the thing this whole design refuses to
-- do. The original is marked `reversed` and linked, so both rows stay in the
-- book and the trail reads: this was posted, this cancelled it, this replaced it.
--
-- `p_corrected_amount` turns a bare reversal into an adjustment: reverse in
-- full, then re-post at the corrected figure. Two entries, both visible, never
-- an edit.
-- ---------------------------------------------------------------------------
create or replace function reverse_finance_ledger_entry(
  p_entry_id            uuid,
  p_entry_date          date,
  p_reason              text,
  p_actor_id            uuid,
  p_actor_name          text,
  p_corrected_amount    numeric default null,
  p_corrected_description text  default null
) returns setof ledger_entries
  language plpgsql
  as $$
  declare
    v_orig    ledger_entries%rowtype;
    v_rev     ledger_entries%rowtype;
    v_new     ledger_entries%rowtype;
  begin
    select * into v_orig from ledger_entries where id = p_entry_id for update;
    if not found then
      raise exception 'ledger entry % does not exist', p_entry_id;
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % has already been reversed by %',
        v_orig.voucher_no, coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), '?');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is itself a reversing entry and cannot be reversed', v_orig.voucher_no;
    end if;

    -- Mirror: whatever side the original took, this one takes the other.
    --
    -- `select * into` rather than a plain assignment: post_finance_ledger_entry
    -- returns a table rowtype, and expanding it through a SELECT is the form
    -- that reliably lands every column in the record variable.
    select * into v_rev from post_finance_ledger_entry(
      p_entry_date        => p_entry_date,
      p_ledger_head_id    => v_orig.ledger_head_id,
      p_description       => 'Reversal of ' || v_orig.voucher_no || ' — ' || p_reason,
      p_debit             => v_orig.credit,
      p_credit            => v_orig.debit,
      p_account           => v_orig.account,
      p_source_type       => 'adjustment',
      p_source_id         => v_orig.id,
      p_branch_id         => v_orig.branch_id,
      p_branch_name       => v_orig.branch_name,
      p_payment_method    => v_orig.payment_method,
      p_approved_by       => p_actor_id,
      p_approved_by_name  => p_actor_name,
      p_created_by        => p_actor_id,
      p_created_by_name   => p_actor_name,
      p_reverses_entry_id => v_orig.id
    );

    update ledger_entries
       set status = 'reversed', reversed_by_entry_id = v_rev.id
     where id = v_orig.id;

    return next v_rev;

    if p_corrected_amount is not null then
      select * into v_new from post_finance_ledger_entry(
        p_entry_date       => p_entry_date,
        p_ledger_head_id   => v_orig.ledger_head_id,
        p_description      => coalesce(p_corrected_description, v_orig.description)
                                || ' (adjustment for ' || v_orig.voucher_no || ')',
        -- Re-post on the ORIGINAL's side, at the corrected figure.
        p_debit            => case when v_orig.debit  > 0 then round(p_corrected_amount, 2) else 0 end,
        p_credit           => case when v_orig.credit > 0 then round(p_corrected_amount, 2) else 0 end,
        p_account          => v_orig.account,
        p_source_type      => 'adjustment',
        p_source_id        => v_orig.id,
        p_branch_id        => v_orig.branch_id,
        p_branch_name      => v_orig.branch_name,
        p_payment_method   => v_orig.payment_method,
        p_approved_by      => p_actor_id,
        p_approved_by_name => p_actor_name,
        p_created_by       => p_actor_id,
        p_created_by_name  => p_actor_name
      );
      return next v_new;
    end if;

    return;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- finance_day_summary — the Daily Closing figures for one business date.
--
-- Aggregated by `entry_date`, NEVER off the `balance` column: balance is a
-- posting-order artefact (see the header). The opening balance is simply
-- everything posted before this date, which is what makes the carry-forward
-- automatic — yesterday's closing IS today's opening by construction, with no
-- stored total to fall out of step.
--
-- A reversed entry is NOT excluded: its reversing counterpart is a real row that
-- cancels it arithmetically. Filtering the original out as well would
-- double-count the cancellation.
-- ---------------------------------------------------------------------------
create or replace function finance_day_summary(p_business_date date)
  returns table (
    opening_balance numeric,
    opening_cash    numeric,
    opening_bank    numeric,
    total_income    numeric,
    total_expenses  numeric,
    net_balance     numeric,
    cash_in_hand    numeric,
    bank_balance    numeric,
    closing_balance numeric,
    entry_count     integer
  )
  language sql stable
  as $$
    with prior as (
      select
        coalesce(sum(debit - credit), 0)                                          as bal,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)           as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)           as bank
      from ledger_entries where entry_date < p_business_date
    ),
    today as (
      select
        coalesce(sum(debit), 0)                                                    as income,
        coalesce(sum(credit), 0)                                                   as expenses,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)            as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)            as bank,
        count(*)::integer                                                          as n
      from ledger_entries where entry_date = p_business_date
    )
    select
      prior.bal,
      prior.cash,
      prior.bank,
      today.income,
      today.expenses,
      today.income - today.expenses,
      prior.cash + today.cash,
      prior.bank + today.bank,
      prior.bal + today.income - today.expenses,
      today.n
    from prior, today
  $$;

-- ---------------------------------------------------------------------------
-- finance_ledger_totals — exact aggregates for a filtered ledger view.
--
-- Exists because the alternative is wrong in a way that is easy to miss:
-- summing the PAGE gives a footer that disagrees with the report, and summing a
-- second unpaginated PostgREST read silently truncates at the row cap, so the
-- footer is simply short by however much fell off the end. A ledger whose totals
-- quietly under-report is worse than one with no totals at all.
--
-- Every filter is `p is null or col = p`, matching the optional-filter shape of
-- the /api/finance/ledger query exactly, so the footer and the rows can never
-- describe different sets.
-- ---------------------------------------------------------------------------
create or replace function finance_ledger_totals(
  p_from           date                  default null,
  p_to             date                  default null,
  p_branch_id      uuid                  default null,
  p_ledger_head_id uuid                  default null,
  p_type           ledger_head_type      default null,
  p_account        finance_account       default null,
  p_status         ledger_entry_status   default null,
  p_source_type    finance_ledger_source default null,
  p_search         text                  default null,
  p_min_amount     numeric               default null,
  p_max_amount     numeric               default null
)
  returns table (
    entry_count     bigint,
    total_debit     numeric,
    total_credit    numeric,
    opening_balance numeric
  )
  language sql stable
  as $$
    with filtered as (
      select e.debit, e.credit
      from ledger_entries e
      where (p_from           is null or e.entry_date     >= p_from)
        and (p_to             is null or e.entry_date     <= p_to)
        and (p_branch_id      is null or e.branch_id       = p_branch_id)
        and (p_ledger_head_id is null or e.ledger_head_id  = p_ledger_head_id)
        and (p_type           is null or e.ledger_head_type = p_type)
        and (p_account        is null or e.account          = p_account)
        and (p_status         is null or e.status           = p_status)
        and (p_source_type    is null or e.source_type      = p_source_type)
        and (p_min_amount     is null or greatest(e.debit, e.credit) >= p_min_amount)
        and (p_max_amount     is null or greatest(e.debit, e.credit) <= p_max_amount)
        and (
          p_search is null
          or e.voucher_no       ilike '%' || p_search || '%'
          or e.description      ilike '%' || p_search || '%'
          or e.ledger_head_name ilike '%' || p_search || '%'
          or coalesce(e.branch_name, '') ilike '%' || p_search || '%'
        )
    )
    select
      (select count(*) from filtered),
      (select coalesce(sum(debit), 0)  from filtered),
      (select coalesce(sum(credit), 0) from filtered),
      -- Everything posted strictly before the window — the balance the ledger
      -- opened at. Undefined without a `from`, in which case the book starts at 0.
      case
        when p_from is null then 0
        else coalesce((select sum(debit - credit) from ledger_entries where entry_date < p_from), 0)
      end
  $$;

-- ---------------------------------------------------------------------------
-- finance_income_approvals — branch closing income awaiting Finance.
--
--   Branch closing → Admin verifies → Finance approves → posted to the ledger.
--
-- One row per branch per business date (the unique constraint), so re-running
-- the import is idempotent instead of duplicating a day's takings.
--
-- The two share percentages are SNAPSHOT here at approval. Reading them live
-- from finance_settings would silently restate every historical day the moment
-- an owner changed the split, which is the sort of thing that is only noticed
-- during an audit.
-- ---------------------------------------------------------------------------
create table finance_income_approvals (
  id                 uuid primary key default gen_random_uuid(),
  reference_no       text not null unique default app.next_finance_number('finance_income', 'INC'),
  branch_id          uuid not null references branches (id) on delete restrict,
  branch_name        text not null,
  business_date      date not null,

  total_amount       numeric(14,2) not null default 0,
  cash_amount        numeric(14,2) not null default 0,
  easypaisa_amount   numeric(14,2) not null default 0,
  foodpanda_amount   numeric(14,2) not null default 0,
  bank_amount        numeric(14,2) not null default 0,
  other_amount       numeric(14,2) not null default 0,
  branch_expenses    numeric(14,2) not null default 0,
  net_amount         numeric(14,2) not null default 0,

  company_share_pct  numeric(5,2) not null,
  branch_share_pct   numeric(5,2) not null,
  company_share      numeric(14,2) not null default 0,
  branch_share       numeric(14,2) not null default 0,

  status             finance_income_status not null default 'pending_verification',
  verified_by        uuid references users (id) on delete set null,
  verified_by_name   text,
  verified_at        timestamptz,
  approved_by        uuid references users (id) on delete set null,
  approved_by_name   text,
  approved_at        timestamptz,
  rejection_reason   text,
  notes              text,
  posted_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (branch_id, business_date)
);

create index finance_income_status_idx on finance_income_approvals (status, business_date desc);
create index finance_income_date_idx   on finance_income_approvals (business_date desc);

create trigger finance_income_touch before update on finance_income_approvals
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- finance_transactions — manual income / expense documents.
--
-- The ledger entry is the CONSEQUENCE of approving one of these; this row is the
-- decision, and it keeps the whole draft → pending → approved → posted → locked
-- trail that the ledger deliberately does not carry.
-- ---------------------------------------------------------------------------
create table finance_transactions (
  id               uuid primary key default gen_random_uuid(),
  txn_no           text not null unique default app.next_finance_number('finance_txn', 'FTX'),
  txn_type         ledger_head_type not null,
  ledger_head_id   uuid not null references ledger_heads (id) on delete restrict,
  ledger_head_name text not null,
  branch_id        uuid references branches (id) on delete set null,
  branch_name      text,
  description      text not null,
  amount           numeric(14,2) not null check (amount > 0),
  payment_method   text not null,
  account          finance_account not null,
  business_date    date not null,
  status           finance_doc_status not null default 'pending_approval',
  reference_no     text,
  notes            text,
  created_by       uuid references users (id) on delete set null,
  created_by_name  text,
  approved_by      uuid references users (id) on delete set null,
  approved_by_name text,
  approved_at      timestamptz,
  rejection_reason text,
  ledger_entry_id  uuid references ledger_entries (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index finance_txn_status_idx on finance_transactions (status, business_date desc);
create index finance_txn_date_idx   on finance_transactions (business_date desc, created_at desc);
create index finance_txn_head_idx   on finance_transactions (ledger_head_id);

create trigger finance_transactions_touch before update on finance_transactions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- finance_employees — the payroll master.
--
-- Deliberately NOT `users`: `users` is the set of people who can sign in, and
-- most of a bakery's payroll cannot. Tying payroll to auth accounts would mean
-- provisioning a login for every baker just to pay them.
-- ---------------------------------------------------------------------------
create table finance_employees (
  id            uuid primary key default gen_random_uuid(),
  employee_code text not null unique default app.next_finance_number('finance_employee', 'EMP'),
  name          text not null,
  department    text not null,
  designation   text not null,
  branch_id     uuid references branches (id) on delete set null,
  branch_name   text,
  base_salary   numeric(14,2) not null default 0,
  phone         text,
  joined_on     date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index finance_employees_active_idx on finance_employees (department, name) where is_active;

create trigger finance_employees_touch before update on finance_employees
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- salary_payments
--
-- The unique (employee_id, salary_month) is load-bearing, not tidiness: it is
-- what makes paying the same person twice for March impossible. A cancelled
-- payslip is rejected, not deleted, so the constraint still holds — re-issuing
-- means adjusting the rejected row's successor, and the partial index below
-- exempts rejected rows so a genuine re-issue is possible.
-- ---------------------------------------------------------------------------
create table salary_payments (
  id               uuid primary key default gen_random_uuid(),
  salary_no        text not null unique default app.next_finance_number('finance_salary', 'SAL'),
  employee_id      uuid not null references finance_employees (id) on delete restrict,
  employee_name    text not null,
  department       text not null,
  designation      text not null,
  salary_month     text not null check (salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  gross_salary     numeric(14,2) not null check (gross_salary >= 0),
  bonus            numeric(14,2) not null default 0 check (bonus >= 0),
  deductions       numeric(14,2) not null default 0 check (deductions >= 0),
  net_salary       numeric(14,2) not null check (net_salary > 0),
  payment_date     date,
  payment_method   text not null,
  account          finance_account not null,
  status           finance_doc_status not null default 'pending_approval',
  notes            text,
  created_by       uuid references users (id) on delete set null,
  created_by_name  text,
  approved_by      uuid references users (id) on delete set null,
  approved_by_name text,
  approved_at      timestamptz,
  rejection_reason text,
  ledger_entry_id  uuid references ledger_entries (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index salary_payments_employee_month_idx
  on salary_payments (employee_id, salary_month)
  where status <> 'rejected';

create index salary_payments_month_idx  on salary_payments (salary_month desc, employee_name);
create index salary_payments_status_idx on salary_payments (status, created_at desc);

create trigger salary_payments_touch before update on salary_payments
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- partner_expenses
-- ---------------------------------------------------------------------------
create table partner_expenses (
  id                uuid primary key default gen_random_uuid(),
  expense_no        text not null unique default app.next_finance_number('finance_partner', 'PEX'),
  partner_name      text not null,
  ledger_head_id    uuid not null references ledger_heads (id) on delete restrict,
  ledger_head_name  text not null,
  description       text not null,
  amount            numeric(14,2) not null check (amount > 0),
  payment_method    text not null,
  account           finance_account not null,
  business_date     date not null,
  status            finance_doc_status not null default 'pending_approval',
  requested_by      uuid references users (id) on delete set null,
  requested_by_name text not null default '',
  approved_by       uuid references users (id) on delete set null,
  approved_by_name  text,
  approved_at       timestamptz,
  rejection_reason  text,
  notes             text,
  ledger_entry_id   uuid references ledger_entries (id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index partner_expenses_status_idx  on partner_expenses (status, business_date desc);
create index partner_expenses_partner_idx on partner_expenses (partner_name, business_date desc);

create trigger partner_expenses_touch before update on partner_expenses
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- finance_audit_logs
--
-- Separate from `audit_logs` (migration 07) on purpose: that table's `action` is
-- an enum of user-management events and its columns describe a TARGET USER. A
-- finance trail describes a target DOCUMENT, and needs the before/after values,
-- the IP and the device — which is what an auditor asks for first.
--
-- `action` and `entity` are text, not enums: this vocabulary will grow with the
-- module, and a new audit action must never require a migration (and therefore
-- must never be the reason an approval 500s).
-- ---------------------------------------------------------------------------
create table finance_audit_logs (
  id              uuid primary key default gen_random_uuid(),
  entity          text not null,
  entity_id       uuid,
  entity_ref      text,
  action          text not null,
  actor_id        uuid references users (id) on delete set null,
  actor_name      text not null default '',
  actor_role      text,
  previous_values jsonb,
  new_values      jsonb,
  ip_address      text,
  device_info     text,
  created_at      timestamptz not null default now()
);

create index finance_audit_entity_idx  on finance_audit_logs (entity, entity_id, created_at desc);
create index finance_audit_created_idx on finance_audit_logs (created_at desc);
create index finance_audit_actor_idx   on finance_audit_logs (actor_id, created_at desc);

-- The trail is append-only for the same reason the ledger is.
create or replace function app.finance_audit_immutable() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'finance_audit_logs is append-only (% attempted)', tg_op;
  end;
  $$;

create trigger finance_audit_no_change
  before update or delete on finance_audit_logs
  for each row execute function app.finance_audit_immutable();

-- ---------------------------------------------------------------------------
-- Seed the default chart of accounts.
--
-- Everything the brief names, plus the seven system heads the automatic
-- postings resolve by code. `on conflict do nothing` keeps this re-runnable.
-- ---------------------------------------------------------------------------
insert into ledger_heads (code, name, type, group_name, is_system, sort_order) values
  -- ── Income ──
  ('INC-BRANCH-CASH',    'Cash Received from Branch', 'income',  'Branch Collection', true,  10),
  ('INC-COMPANY-SHARE',  'Company Share',             'income',  'Share Split',       true,  20),
  ('INC-BRANCH-SHARE',   'Branch Share',              'income',  'Share Split',       true,  30),
  ('INC-OPENING',        'Opening Balance',           'income',  'Opening',           true,  40),
  ('INC-EASYPAISA',      'Easypaisa Collection',      'income',  'Branch Collection', false, 50),
  ('INC-BANK-DEPOSIT',   'Bank Deposit',              'income',  'Branch Collection', false, 60),
  ('INC-FOODPANDA',      'Foodpanda Collection',      'income',  'Branch Collection', false, 70),
  ('INC-ONLINE',         'Online Payments',           'income',  'Branch Collection', false, 80),
  ('INC-BRANCH-ONLINE',  'Branch Online Collection',  'income',  'Branch Collection', false, 90),
  ('INC-INVESTMENT',     'Investment',                'income',  'Capital',           false, 100),
  ('INC-OTHER',          'Other Income',              'income',  'Other',             false, 110),
  ('INC-MISC',           'Miscellaneous Income',      'income',  'Other',             false, 120),

  -- ── Expense ──
  ('EXP-SALARIES',       'Salaries',                  'expense', 'Payroll',           true,  10),
  ('EXP-PARTNER',        'Partner Withdrawals',       'expense', 'Partners',          true,  20),
  ('EXP-ADJUSTMENT',     'Adjustments',               'expense', 'Corrections',       true,  30),
  ('EXP-COMPANY',        'Company Expenses',          'expense', 'Company',           false, 40),
  ('EXP-OFFICE-RENT',    'Office Rent',               'expense', 'Company',           false, 50),
  ('EXP-OFFICE',         'Office Expenses',           'expense', 'Company',           false, 60),
  ('EXP-ELECTRICITY',    'Electricity',               'expense', 'Utilities',         false, 70),
  ('EXP-GAS',            'Gas',                       'expense', 'Utilities',         false, 80),
  ('EXP-INTERNET',       'Internet',                  'expense', 'Utilities',         false, 90),
  ('EXP-UTILITIES',      'Utilities',                 'expense', 'Utilities',         false, 100),
  ('EXP-MARKETING',      'Marketing',                 'expense', 'Growth',            false, 110),
  ('EXP-EQUIPMENT',      'Equipment',                 'expense', 'Assets',            false, 120),
  ('EXP-VEHICLE',        'Vehicle Expenses',          'expense', 'Logistics',         false, 130),
  ('EXP-FUEL',           'Fuel',                      'expense', 'Logistics',         false, 140),
  ('EXP-MAINTENANCE',    'Maintenance',               'expense', 'Operations',        false, 150),
  ('EXP-PACKAGING',      'Packaging Materials',       'expense', 'Operations',        false, 160),
  ('EXP-RAW-MATERIALS',  'Raw Materials',             'expense', 'Operations',        false, 170),
  ('EXP-PRODUCTION',     'Production Expenses',       'expense', 'Operations',        false, 180),
  ('EXP-MISC',           'Miscellaneous',             'expense', 'Other',             false, 190)
  on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Same two-class model as migration 09: the Express API reaches these tables
-- with the SERVICE-ROLE key, which bypasses RLS entirely, so authorization for
-- the module is enforced in application code (requireFinance / financeCan).
-- These policies are DEFENCE IN DEPTH — they decide what a stray publishable-key
-- client could reach, and the answer is "read-only, finance staff and Super
-- Admin only, nothing else".
--
-- READ-ONLY IS THE POINT. There is no insert/update/delete policy on ANY table
-- here, for anyone. A finance user with a browser session cannot write a single
-- ledger row directly — every write goes through the API, which is where the
-- approval rules, the audit trail and the immutability guarantees live.
--
-- Branch managers, production users and unauthenticated callers match no policy
-- at all, so RLS denies them everything. That is the brief's "Branch and
-- Production users have no access to the Finance Ledger", enforced one layer
-- below the code that also enforces it.
-- ---------------------------------------------------------------------------
alter table finance_settings          enable row level security;
alter table ledger_heads              enable row level security;
alter table ledger_entries            enable row level security;
alter table finance_day_closings      enable row level security;
alter table finance_income_approvals  enable row level security;
alter table finance_transactions      enable row level security;
alter table finance_employees         enable row level security;
alter table salary_payments           enable row level security;
alter table partner_expenses          enable row level security;
alter table finance_audit_logs        enable row level security;

create policy finance_settings_read on finance_settings
  for select to authenticated using (app.can_read_finance());

create policy ledger_heads_read on ledger_heads
  for select to authenticated using (app.can_read_finance());

create policy ledger_entries_read on ledger_entries
  for select to authenticated using (app.can_read_finance());

create policy finance_day_closings_read on finance_day_closings
  for select to authenticated using (app.can_read_finance());

create policy finance_income_read on finance_income_approvals
  for select to authenticated using (app.can_read_finance());

create policy finance_transactions_read on finance_transactions
  for select to authenticated using (app.can_read_finance());

create policy finance_employees_read on finance_employees
  for select to authenticated using (app.can_read_finance());

-- Payroll is narrower than the rest of the module: a Read Only Auditor and the
-- approvers need it, but it is the one table where "everyone in finance" is
-- worth questioning. Kept at can_read_finance() for now — call it out here so a
-- future tightening has an obvious home.
create policy salary_payments_read on salary_payments
  for select to authenticated using (app.can_read_finance());

create policy partner_expenses_read on partner_expenses
  for select to authenticated using (app.can_read_finance());

create policy finance_audit_read on finance_audit_logs
  for select to authenticated using (app.can_read_finance());

-- ---------------------------------------------------------------------------
-- Function grants. These run with the caller's rights and are only ever invoked
-- by the API's service-role client; no browser session has any business calling
-- a posting primitive directly.
-- ---------------------------------------------------------------------------
revoke all on function post_finance_ledger_entry(
  date, uuid, text, numeric, numeric, finance_account, finance_ledger_source,
  uuid, uuid, text, text, uuid, text, uuid, text, uuid
) from public, anon, authenticated;

revoke all on function reverse_finance_ledger_entry(uuid, date, text, uuid, text, numeric, text)
  from public, anon, authenticated;

revoke all on function app.next_finance_number(text, text) from public, anon, authenticated;

-- Re-granted explicitly to the API's role. Revoking from PUBLIC above also
-- removes the grant `service_role` inherits through it, so without these three
-- lines every posting fails with "permission denied for function". The
-- next_finance_number grant matters twice over: it is also called from the
-- column DEFAULTs on finance_income_approvals / finance_transactions /
-- salary_payments / partner_expenses / finance_employees, which run as the
-- INSERTING role.
grant execute on function post_finance_ledger_entry(
  date, uuid, text, numeric, numeric, finance_account, finance_ledger_source,
  uuid, uuid, text, text, uuid, text, uuid, text, uuid
) to service_role;

grant execute on function reverse_finance_ledger_entry(uuid, date, text, uuid, text, numeric, text)
  to service_role;

grant execute on function app.next_finance_number(text, text) to service_role;

grant execute on function finance_day_summary(date) to service_role;

grant execute on function finance_ledger_totals(
  date, date, uuid, uuid, ledger_head_type, finance_account,
  ledger_entry_status, finance_ledger_source, text, numeric, numeric
) to service_role;
