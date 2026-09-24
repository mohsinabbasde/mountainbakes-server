-- 118: cash transfers — money a branch hands over to the company, reviewed by
-- Finance, booked as an RV- receipt the moment it is approved.
--
-- ─── What this is ────────────────────────────────────────────────────────────
-- A branch collects cash at the counter and, every so often, hands it (or an
-- Easypaisa / bank transfer of it) to the company. Until now that handover had
-- no record of its own: Finance saw the takings through Branch Income and saw
-- the money through the bank statement, and nothing tied a physical deposit to
-- a branch, a date, a person and a photograph of the slip.
--
-- `cash_transfers` is that record. A row is a CLAIM BY THE BRANCH that money
-- moved — "DHA handed over 25,000 in cash on the 24th, here is the slip" — and
-- Finance's approval is what turns the claim into a receipt in the book.
--
-- ─── It is a finance document, shaped like branch_discounts ──────────────────
-- Raised by a branch, reviewed by somebody else, three states, denormalised
-- names, a positive-only money column — the discount table's shape, on purpose,
-- so the two branch-side screens read alike. The difference is what approval
-- DOES: a discount approval books nothing (migration 93), whereas approving a
-- transfer posts one debit under INC-BRANCH-CASH through
-- post_finance_ledger_entry, which is where the RV- number comes from. That
-- posting and the status change happen in ONE transaction, in
-- approve_cash_transfer() below — the app-layer claim-then-post that
-- finance-documents.service.ts uses can leave a document approved with no
-- voucher, and a cash handover with no receipt is exactly the state this
-- feature exists to prevent.
--
-- ─── What it does NOT touch ──────────────────────────────────────────────────
-- Nothing here reads or writes production_orders, branch_discounts, orders,
-- expenses or stock. The transfer is its own transaction; the production slip's
-- "Payment Received" line (previous-balance.service.ts) SUMS approved rows in
-- the same window it already uses for discounts and displays the figure beside
-- the existing ones. It does not subtract from Amount to Collect and it rewrites
-- no historical figure — the owner's rule, in their words, is "amount not add
-- and subtract, and record save".
--
-- ─── Three states ────────────────────────────────────────────────────────────
--   pending   — waiting on Finance. Immutable to the branch: a wrong figure is
--               rejected and raised again, because the photo is evidence of one
--               specific handover and an edited amount under the same photo is
--               not evidence of anything.
--   approved  — booked. `ledger_entry_id` and `voucher_no` are set. Final.
--   rejected  — refused, with a reason. Final. The row and its photo stay.
--
-- ─── The enum trap, and how this file avoids it ──────────────────────────────
-- `supabase db push` runs every pending file in ONE transaction, and Postgres
-- refuses to USE an enum value added in that transaction (55P04 — see DEPLOY.md
-- and the header of migration 87). This file adds two values —
-- attachment_entity.cash_transfer and finance_ledger_source.cash_transfer — and
-- names neither anywhere that is evaluated at apply time: no default, no CHECK,
-- no index predicate, no policy, no `language sql` body. The one place
-- 'cash_transfer' appears as a ledger source is inside a plpgsql body, which is
-- resolved on first call, in a later transaction. The status type is CREATED
-- here, so the same transaction may use it freely (as 93 did).
--
-- ADDITIVE. New table, new type, two enum values, two functions, one counter
-- row. Nothing existing is altered. The two notification_type values this
-- feature sends go in migration 119, by the migration 92 convention.
-- ---------------------------------------------------------------------------

-- The photo of the handover. Falls in the finance half of attachments_read's
-- CASE (migration 87 made finance the default), so it is protected at the RLS
-- floor the moment the value exists; the branch reads its own photo through the
-- API on the service-role key, as it does every other row it owns.
alter type attachment_entity add value if not exists 'cash_transfer';

-- One debit per approved transfer. Its own source value rather than reusing
-- 'branch_income' so the General Ledger can tell "takings approved from the
-- closing report" from "cash that physically arrived", and so the photo behind
-- the voucher resolves back to THIS table (finance-ledger.service.ts).
alter type finance_ledger_source add value if not exists 'cash_transfer';

-- CT-000001, CT-000002, … `counters` is configuration, not data: the row must
-- exist before the first insert or app.next_finance_number raises (see 52).
insert into counters (id, count) values ('cash_transfer', 0)
  on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'cash_transfer_status') then
    create type cash_transfer_status as enum ('pending', 'approved', 'rejected');
  end if;
end
$$;

create table if not exists cash_transfers (
  id                uuid primary key default gen_random_uuid(),
  -- The branch's own reference, issued at insert. Distinct from the RV- number,
  -- which does not exist until Finance approves and is a property of the
  -- ledger row, not of the claim.
  transfer_no       text not null unique default app.next_finance_number('cash_transfer', 'CT'),
  branch_id         uuid not null references branches (id) on delete restrict,
  -- Denormalised at insert, as on branch_discounts: a renamed branch must not
  -- rewrite what a settled receipt said at the time.
  branch_name       text not null,
  -- Money, numeric(14,2), positive only. A negative transfer is a refund, which
  -- this table does not model and must not be made to by a sign flip.
  amount            numeric(14,2) not null,
  -- 'cash' | 'easypaisa' | 'bank_account' — the same three values the daily
  -- sale record lets a branch key by hand (DAILY_SALE_MANUAL_METHODS). Text
  -- with a CHECK rather than the `payment_method` enum, because that enum also
  -- carries 'foodpanda' and 'staff', neither of which is a way to hand money
  -- to the company.
  payment_method    text not null,
  note              text,
  business_date     date not null,
  status            cash_transfer_status not null default 'pending',
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  -- Stamped on approve AND reject — the finance-document convention (52, 87):
  -- one reviewer, one timestamp, and `status` says which decision it was.
  approved_by       uuid references users (id) on delete set null,
  approved_by_name  text,
  approved_at       timestamptz,
  approval_note     text,
  rejection_reason  text,
  -- The receipt this transfer became. `restrict`: a voucher with a transfer
  -- behind it is not deletable (and the ledger refuses deletes anyway).
  ledger_entry_id   uuid references ledger_entries (id) on delete restrict,
  -- Snapshot of the RV- number, so the branch list and the search box need no
  -- join into the ledger.
  voucher_no        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint cash_transfers_amount_positive check (amount > 0),
  constraint cash_transfers_method_check
    check (payment_method in ('cash', 'easypaisa', 'bank_account')),
  -- The three states, each with exactly the columns it implies. An approved
  -- row without a voucher, or a rejected row without a reason, cannot exist.
  constraint cash_transfers_decision_check check (
    (status = 'pending'  and ledger_entry_id is null     and approved_at is null) or
    (status = 'approved' and ledger_entry_id is not null and approved_at is not null) or
    (status = 'rejected' and ledger_entry_id is null     and approved_at is not null
                         and rejection_reason is not null)
  )
);

create trigger cash_transfers_touch before update on cash_transfers
  for each row execute function app.touch_updated_at();

-- The reads this table gets: a branch's own list (branch + date), Finance's
-- board (date), the pending count, and the production slip's window
-- (branch + created_at over approved rows only).
create index if not exists cash_transfers_branch_idx on cash_transfers (branch_id, business_date desc);
create index if not exists cash_transfers_date_idx   on cash_transfers (business_date desc);
create index if not exists cash_transfers_status_idx on cash_transfers (status) where status = 'pending';
create index if not exists cash_transfers_window_idx on cash_transfers (branch_id, created_at)
  where status = 'approved';

comment on table cash_transfers is
  'Cash / Easypaisa / bank money a branch handed to the company, with a photo of the slip. Finance approval posts one RV- receipt under INC-BRANCH-CASH in the same transaction (approve_cash_transfer). Never adds to or subtracts from any other record.';

-- RLS on, as a floor under a direct client read. The API reaches this table on
-- the service-role key, which bypasses RLS and re-decides every request in
-- application code (scopeBranch / requireFinance) — that is the authorisation.
alter table cash_transfers enable row level security;

drop policy if exists cash_transfers_select on cash_transfers;
create policy cash_transfers_select on cash_transfers
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id() or app.can_read_finance());

-- ---------------------------------------------------------------------------
-- approve_cash_transfer — the one atomic step.
--
--   lock the row → require pending → post the receipt → mark approved
--
-- Any failure (a closed finance day inside post_finance_ledger_entry, a missing
-- head, a lost race) raises and unwinds the whole thing, so the row is either
-- approved WITH its voucher or still pending WITHOUT one. `for update` is what
-- makes two Finance users clicking at once safe: the second waits, sees
-- 'approved', and gets the P0001 the API turns into a 409.
--
-- ENTRY DATE. The receipt is dated the day the branch says the money moved
-- (business_date) — unless Finance has already closed that day, in which case
-- it is dated p_today (the caller's current business date). A closed day is
-- locked so its signed-off balance stays true (52); re-dating to today is the
-- only way a late approval can still be booked, and the transfer keeps its own
-- business_date so nothing about the handover itself is restated.
--
-- The `'cash_transfer'` literal below is the ledger source added at the top of
-- this file. It is resolved when the function first RUNS, never at apply time —
-- which is what keeps this file safe in a single push. Do not move it into a
-- `language sql` body or a column default.
-- ---------------------------------------------------------------------------
create or replace function approve_cash_transfer(
  p_id          uuid,
  p_actor_id    uuid,
  p_actor_name  text,
  p_today       date,
  p_note        text default null
) returns cash_transfers
  language plpgsql
  as $$
  declare
    v_row    cash_transfers%rowtype;
    v_head   ledger_heads%rowtype;
    v_entry  ledger_entries%rowtype;
    v_date   date;
  begin
    select * into v_row from cash_transfers where id = p_id for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'pending' then
      raise exception 'Transfer % is already % and cannot be approved again.',
        v_row.transfer_no, v_row.status using errcode = 'P0001';
    end if;

    -- The system head the automatic postings resolve by code (52). It may be
    -- hidden from the pickers (107) — post_finance_ledger_entry accepts an
    -- inactive head for every source but 'manual' — but it cannot be deleted.
    select * into v_head from ledger_heads where code = 'INC-BRANCH-CASH';
    if not found then
      raise exception 'ledger head INC-BRANCH-CASH is missing (seeded by migration 52)';
    end if;

    v_date := v_row.business_date;
    if exists (select 1 from finance_day_closings where business_date = v_date) then
      v_date := p_today;
    end if;

    v_entry := post_finance_ledger_entry(
      v_date,
      v_head.id,
      'Payment received from branch - ' || v_row.branch_name,
      v_row.amount,   -- debit: money in → the RV- series
      0,
      case when v_row.payment_method = 'cash' then 'cash'::finance_account else 'bank'::finance_account end,
      'cash_transfer',
      v_row.id,
      v_row.branch_id,
      v_row.branch_name,
      v_row.payment_method,
      p_actor_id,
      p_actor_name,
      v_row.created_by,
      v_row.created_by_name,
      null
    );

    update cash_transfers
       set status           = 'approved',
           approved_by      = p_actor_id,
           approved_by_name = p_actor_name,
           approved_at      = now(),
           approval_note    = nullif(btrim(coalesce(p_note, '')), ''),
           ledger_entry_id  = v_entry.id,
           voucher_no       = v_entry.voucher_no
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- reject_cash_transfer — refuse a pending claim, with a reason, keeping the row.
-- ---------------------------------------------------------------------------
create or replace function reject_cash_transfer(
  p_id          uuid,
  p_actor_id    uuid,
  p_actor_name  text,
  p_reason      text
) returns cash_transfers
  language plpgsql
  as $$
  declare
    v_row cash_transfers%rowtype;
  begin
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'A reason is required to reject a transfer.' using errcode = 'P0001';
    end if;

    select * into v_row from cash_transfers where id = p_id for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'pending' then
      raise exception 'Transfer % is already % and cannot be rejected.',
        v_row.transfer_no, v_row.status using errcode = 'P0001';
    end if;

    update cash_transfers
       set status           = 'rejected',
           approved_by      = p_actor_id,
           approved_by_name = p_actor_name,
           approved_at      = now(),
           rejection_reason = btrim(p_reason)
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

-- Service role only, as for every function that writes money (52). Revoking
-- from public also removes what service_role inherits, so the grant is explicit.
revoke all on function approve_cash_transfer(uuid, uuid, text, date, text) from public, anon, authenticated;
revoke all on function reject_cash_transfer(uuid, uuid, text, text)        from public, anon, authenticated;
grant execute on function approve_cash_transfer(uuid, uuid, text, date, text) to service_role;
grant execute on function reject_cash_transfer(uuid, uuid, text, text)        to service_role;

comment on function approve_cash_transfer(uuid, uuid, text, date, text) is
  'Atomically approve a pending cash transfer: posts one RV- receipt under INC-BRANCH-CASH via post_finance_ledger_entry and links it. P0001 if already decided or the finance day is closed; P0002 if missing.';
comment on function reject_cash_transfer(uuid, uuid, text, text) is
  'Refuse a pending cash transfer with a reason. The row and its photo are kept. P0001 if already decided; P0002 if missing.';
