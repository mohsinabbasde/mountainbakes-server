-- 121: cash deposits by channel — Cash, Easypaisa and Bank in one deposit, a
-- computed Total, and Fuel Charges booked as their own income.
--
-- ─── What the owner asked for ────────────────────────────────────────────────
-- The Cash Deposit popup stops asking "which payment method?" and asks for
-- three amounts instead — Cash, Easypaisa, Bank — whose sum is the Total
-- Amount, plus a separate Fuel Charges figure (delivery charges the branch
-- collected). Foodpanda is NOT a channel here: the branch keys Foodpanda money
-- into Easypaisa by hand, so a Foodpanda column would count it twice.
--
-- ─── The row ─────────────────────────────────────────────────────────────────
-- `cash_transfers` is extended, not duplicated. `amount` KEEPS its meaning —
-- the money handed over, which the production slip sums as "Payment Received"
-- — and is now held equal to cash + easypaisa + bank by a CHECK, so a client
-- cannot send a Total that disagrees with its parts. `fuel_charges` sits
-- outside that sum on purpose: it is income of its own, not a payment against
-- the branch's balance.
--
-- `payment_method` stays, nullable. Historical rows keep the value they were
-- raised with and are BACKFILLED into the matching channel column, so every
-- old deposit reads the same through the new columns; new rows leave it null.
-- Nothing reads it for money any more — the channel columns are the record.
--
-- A deposit may now be Fuel Charges only (amount = 0). The old
-- `amount > 0` CHECK becomes "something above zero": amount + fuel > 0.
--
-- ─── The ledger ──────────────────────────────────────────────────────────────
-- Approval still posts in ONE transaction (approve_cash_transfer), still under
-- source 'cash_transfer' with the deposit's id as source_id, and never posts a
-- zero:
--
--   Total      → INC-BRANCH-CASH, "Payment received from branch - <branch>",
--                income (debit). One entry per ACCOUNT the money landed in:
--                the Cash part on the cash account, Easypaisa + Bank together
--                on the bank account. The ledger's cash/bank balances (the
--                daily closing, 94) are summed by `account`, so one combined
--                entry would put Easypaisa money in the cash drawer. This is
--                the split Branch Income already makes (splitByAccount in
--                finance-income.service.ts). A cash-only deposit is one entry.
--   Fuel       → INC-FUEL "Fuel" (new, income), "Daily delivery charges", on
--                the cash account. EXP-FUEL — fuel bought for the vehicle —
--                is untouched and stays an expense head; the two never share
--                a head because they never share a type.
--
-- `ledger_entry_id` stays the first voucher (the decision CHECK needs one);
-- `voucher_no` holds every RV- the deposit produced, comma separated, which is
-- what the branch list and the search box show. The full set is always
-- recoverable as source_type 'cash_transfer' + source_id.
--
-- A corrected figure on an approved deposit (Help Desk / Support Center, via
-- amend_finance_record) reverses the voucher of each slice that changed and
-- posts its replacement (app.sync_cash_transfer_entries); a deleted deposit
-- reverses them all. The book is never left holding a stale amount.
--
-- No enum is touched (the 55P04 trap in 118 does not arise). The literal
-- 'cash_transfer' appears only inside plpgsql bodies.
-- ---------------------------------------------------------------------------

-- 1. The channels
alter table cash_transfers
  add column if not exists cash_amount      numeric(14,2) not null default 0,
  add column if not exists easypaisa_amount numeric(14,2) not null default 0,
  add column if not exists bank_amount      numeric(14,2) not null default 0,
  add column if not exists fuel_charges     numeric(14,2) not null default 0,
  add column if not exists updated_by       uuid references users (id) on delete set null,
  add column if not exists updated_by_name  text;

-- Historical deposits: the whole amount went by the one method they named.
update cash_transfers
   set cash_amount      = case when payment_method = 'cash'         then amount else 0 end,
       easypaisa_amount = case when payment_method = 'easypaisa'    then amount else 0 end,
       bank_amount      = case when payment_method = 'bank_account' then amount else 0 end
 where cash_amount = 0 and easypaisa_amount = 0 and bank_amount = 0 and fuel_charges = 0;

alter table cash_transfers alter column payment_method drop not null;

alter table cash_transfers drop constraint if exists cash_transfers_amount_positive;
alter table cash_transfers drop constraint if exists cash_transfers_channels_nonnegative;
alter table cash_transfers drop constraint if exists cash_transfers_total_is_channels;
alter table cash_transfers drop constraint if exists cash_transfers_not_empty;

alter table cash_transfers add constraint cash_transfers_channels_nonnegative
  check (cash_amount >= 0 and easypaisa_amount >= 0 and bank_amount >= 0 and fuel_charges >= 0);
-- The Total is derived, never keyed.
alter table cash_transfers add constraint cash_transfers_total_is_channels
  check (amount = cash_amount + easypaisa_amount + bank_amount);
-- Zero is never a deposit.
alter table cash_transfers add constraint cash_transfers_not_empty
  check (amount + fuel_charges > 0);

comment on column cash_transfers.amount is
  'Total Amount = cash_amount + easypaisa_amount + bank_amount (CHECK). Excludes fuel_charges.';
comment on column cash_transfers.payment_method is
  'Legacy (pre-121): the single method a deposit was raised with. Backfilled into the channel columns; null on new rows.';
comment on column cash_transfers.fuel_charges is
  'Delivery charges handed over with the deposit. Booked as income under INC-FUEL, never part of amount.';

-- 2. The Fuel income head. System: the approval resolves it by code.
insert into ledger_heads (code, name, type, description, group_name, is_system, sort_order) values
  ('INC-FUEL', 'Fuel', 'income',
   'Delivery charges a branch collects and hands over with its cash deposit (migration 121). '
   'Not EXP-FUEL, which is fuel bought for the vehicle.',
   'Branch Collection', true, 75)
on conflict (code) do nothing;

-- 3. The vouchers a deposit SHOULD have, as rows — one place that says how a
--    deposit is booked, read by both the approval and the correction below so
--    the two can never book differently. Zero slices are simply absent.
create or replace function app.cash_transfer_slices(p_id uuid)
  returns table (head_code text, description text, amount numeric, account finance_account, payment_method text)
  language plpgsql
  as $$
  declare
    v_row cash_transfers%rowtype;
  begin
    select * into v_row from cash_transfers where id = p_id;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;

    -- Total, cash part → cash account.
    if v_row.cash_amount > 0 then
      return query select 'INC-BRANCH-CASH'::text, 'Payment received from branch - ' || v_row.branch_name,
                          v_row.cash_amount::numeric, 'cash'::finance_account, 'cash'::text;
    end if;
    -- Total, Easypaisa + Bank part → bank account. One entry, not two: the
    -- owner asked for the Total as the collection entry, and both channels
    -- land in the same account.
    if v_row.easypaisa_amount + v_row.bank_amount > 0 then
      return query select 'INC-BRANCH-CASH'::text, 'Payment received from branch - ' || v_row.branch_name,
                          (v_row.easypaisa_amount + v_row.bank_amount)::numeric, 'bank'::finance_account,
                          case
                            when v_row.easypaisa_amount > 0 and v_row.bank_amount > 0 then 'easypaisa+bank_account'
                            when v_row.easypaisa_amount > 0 then 'easypaisa'
                            else 'bank_account'
                          end;
    end if;
    -- Fuel Charges → INC-FUEL, income, its own voucher.
    if v_row.fuel_charges > 0 then
      return query select 'INC-FUEL'::text, 'Daily delivery charges'::text,
                          v_row.fuel_charges::numeric, 'cash'::finance_account, 'cash'::text;
    end if;
  end;
  $$;

-- 3b. Bring a deposit's vouchers in line with its row: reverse every live
--     voucher that no longer matches a slice, post every slice that has no
--     live voucher. On first approval nothing is live, so everything posts;
--     on a correction only the slice that changed moves — a corrected Bank
--     figure does not churn the cash and fuel vouchers. Returns the reversal
--     numbers, the numbers posted now, and the full live set afterwards.
create or replace function app.sync_cash_transfer_entries(
  p_id          uuid,
  p_entry_date  date,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text
) returns jsonb
  language plpgsql
  as $$
  declare
    v_row      cash_transfers%rowtype;
    v_slice    record;
    v_live     record;
    v_head     ledger_heads%rowtype;
    v_entry    ledger_entries%rowtype;
    v_rev      ledger_entries%rowtype;
    v_kept     uuid[] := '{}';
    v_queue    jsonb  := '[]';
    v_item     record;
    v_revs     text[] := '{}';
    v_posted   text[] := '{}';
    v_first    uuid;
    v_all      text;
  begin
    select * into v_row from cash_transfers where id = p_id;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;

    -- Pair each wanted slice with one live voucher that already books it
    -- exactly; a slice with no such voucher is queued to post.
    for v_slice in select * from app.cash_transfer_slices(p_id) loop
      select e.id into v_live
        from ledger_entries e join ledger_heads h on h.id = e.ledger_head_id
       where e.source_type = 'cash_transfer' and e.source_id = p_id
         and e.status <> 'reversed' and e.reverses_entry_id is null and e.deleted_at is null
         and h.code = v_slice.head_code and e.account = v_slice.account
         and e.debit = v_slice.amount and e.payment_method is not distinct from v_slice.payment_method
         and e.id <> all (v_kept)
       order by e.seq limit 1;
      if found then
        v_kept := v_kept || v_live.id;
      else
        v_queue := v_queue || to_jsonb(v_slice);
      end if;
    end loop;

    -- Reverse every live voucher no slice claimed.
    for v_live in
      select id from ledger_entries
       where source_type = 'cash_transfer' and source_id = p_id
         and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
         and id <> all (v_kept)
       order by seq
    loop
      select * into v_rev from reverse_finance_ledger_entry(
        v_live.id, p_entry_date, p_reason, p_actor_id, p_actor_name, null, null
      ) limit 1;
      v_revs := v_revs || v_rev.voucher_no;
    end loop;

    -- Post the queued slices.
    for v_item in select value from jsonb_array_elements(v_queue) loop
      select * into v_head from ledger_heads where code = v_item.value ->> 'head_code';
      if not found then
        raise exception 'ledger head % is missing (seeded by migration 52 / 121)', v_item.value ->> 'head_code';
      end if;
      v_entry := post_finance_ledger_entry(
        p_entry_date, v_head.id, v_item.value ->> 'description',
        (v_item.value ->> 'amount')::numeric, 0,   -- debit: money in → the RV- series, income
        (v_item.value ->> 'account')::finance_account,
        'cash_transfer', v_row.id, v_row.branch_id, v_row.branch_name, v_item.value ->> 'payment_method',
        p_actor_id, p_actor_name, v_row.created_by, v_row.created_by_name, null
      );
      v_posted := v_posted || v_entry.voucher_no;
    end loop;

    select (array_agg(id order by seq))[1], string_agg(voucher_no, ', ' order by seq)
      into v_first, v_all
      from ledger_entries
     where source_type = 'cash_transfer' and source_id = p_id
       and status <> 'reversed' and reverses_entry_id is null and deleted_at is null;

    if v_first is null then
      raise exception 'Transfer % has no amount above 0 to book.', v_row.transfer_no using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'firstEntryId', v_first,
      'voucherNos',   v_all,
      'reversed',     nullif(array_to_string(v_revs, ', '), ''),
      'posted',       nullif(array_to_string(v_posted, ', '), '')
    );
  end;
  $$;

-- 4. Reverse every live voucher a deposit produced. Returns the reversal nos.
create or replace function app.reverse_cash_transfer_entries(
  p_id          uuid,
  p_entry_date  date,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text
) returns text
  language plpgsql
  as $$
  declare
    v_e    record;
    v_rev  ledger_entries%rowtype;
    v_nos  text[] := '{}';
  begin
    for v_e in
      select id from ledger_entries
       where source_type = 'cash_transfer' and source_id = p_id
         and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
       order by seq
    loop
      select * into v_rev from reverse_finance_ledger_entry(
        v_e.id, p_entry_date, p_reason, p_actor_id, p_actor_name, null, null
      ) limit 1;
      v_nos := v_nos || v_rev.voucher_no;
    end loop;
    return nullif(array_to_string(v_nos, ', '), '');
  end;
  $$;

revoke all on function app.cash_transfer_slices(uuid)                                   from public, anon, authenticated;
revoke all on function app.sync_cash_transfer_entries(uuid, date, text, uuid, text)     from public, anon, authenticated;
revoke all on function app.reverse_cash_transfer_entries(uuid, date, text, uuid, text)  from public, anon, authenticated;
grant execute on function app.cash_transfer_slices(uuid)                                to service_role;
grant execute on function app.sync_cash_transfer_entries(uuid, date, text, uuid, text)  to service_role;
grant execute on function app.reverse_cash_transfer_entries(uuid, date, text, uuid, text) to service_role;

-- 5. approve_cash_transfer — 120's body, posting through the helper above.
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
    v_row     cash_transfers%rowtype;
    v_date    date;
    v_posted  jsonb;
  begin
    select * into v_row from cash_transfers where id = p_id and deleted_at is null for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'pending' then
      raise exception 'Transfer % is already % and cannot be approved again.',
        v_row.transfer_no, v_row.status using errcode = 'P0001';
    end if;

    -- Dated the day the money moved, unless Finance has closed it (118).
    v_date := v_row.business_date;
    if exists (select 1 from finance_day_closings where business_date = v_date) then
      v_date := p_today;
    end if;

    -- Nothing is live yet, so this posts every non-zero slice.
    v_posted := app.sync_cash_transfer_entries(p_id, v_date, null, p_actor_id, p_actor_name);

    update cash_transfers
       set status           = 'approved',
           approved_by      = p_actor_id,
           approved_by_name = p_actor_name,
           approved_at      = now(),
           approval_note    = nullif(btrim(coalesce(p_note, '')), ''),
           ledger_entry_id  = (v_posted ->> 'firstEntryId')::uuid,
           voucher_no       = v_posted ->> 'voucherNos'
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

-- 6. app.repost_cash_transfer_ledger — same signature as 120; now only the
--    slices a correction changed are reversed and re-posted.
create or replace function app.repost_cash_transfer_ledger(
  p_transfer_id uuid,
  p_reason      text,
  p_actor_id    uuid,
  p_actor_name  text,
  p_entry_date  date
) returns jsonb
  language plpgsql
  as $$
  declare
    v_row     cash_transfers%rowtype;
    v_posted  jsonb;
  begin
    select * into v_row from cash_transfers where id = p_transfer_id for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_transfer_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'approved' or v_row.ledger_entry_id is null then
      return jsonb_build_object('ledgerAmended', false);
    end if;

    v_posted := app.sync_cash_transfer_entries(p_transfer_id, p_entry_date, p_reason, p_actor_id, p_actor_name);

    update cash_transfers
       set ledger_entry_id = (v_posted ->> 'firstEntryId')::uuid,
           voucher_no      = v_posted ->> 'voucherNos'
     where id = p_transfer_id;

    return jsonb_build_object(
      'ledgerAmended',      true,
      'reversalVoucherNo',  v_posted ->> 'reversed',
      'correctedVoucherNo', v_posted ->> 'posted',
      'liveVoucherNos',     v_posted ->> 'voucherNos',
      'correctedEntryId',   v_posted ->> 'firstEntryId'
    );
  end;
  $$;

-- 7. amend_finance_record — 120's body, the cash_transfer branch rewritten for channels
create or replace function amend_finance_record(
  p_reference_type text,
  p_reference_id   uuid,
  p_field          text,
  p_new_value      text,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_entry_date     date default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_date     date := coalesce(p_entry_date, (timezone('Asia/Karachi', now()))::date);
    v_old      text;
    v_new      text := btrim(coalesce(p_new_value, ''));
    v_num      numeric;
    v_ref      text;
    v_ledger   jsonb := jsonb_build_object('ledgerAmended', false);
    v_entry    uuid;
    v_status   text;
  begin
    if p_reference_id is null then
      raise exception 'nothing to amend: the query names no finance record';
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;

    -- Numeric fields are parsed once, here, so a malformed figure fails before
    -- anything is written rather than half-way through a multi-column update.
    -- Migration 120: `note` and `paymentMethod` (cash transfers) are text too.
    if p_field not in ('description', 'notes', 'note', 'paymentMethod') then
      begin
        v_num := round(v_new::numeric, 2);
      exception when others then
        raise exception '"%" is not a valid amount for field %', p_new_value, p_field;
      end;
      if v_num < 0 then
        raise exception 'a finance amount cannot be negative (got %)', v_num;
      end if;
    end if;

    case p_reference_type

      -- -------------------------------------------------------------------
      -- ledger_entry — the book itself. There is no in-place edit here at any
      -- price: migration 52's trigger refuses one, and this function does not
      -- open the window that would let it through. An amendment IS the
      -- reversal-and-repost, which is why this branch does nothing else.
      -- -------------------------------------------------------------------
      when 'ledger_entry' then
        select voucher_no,
               case when debit > 0 then debit else credit end::text,
               status
          into v_ref, v_old, v_status
          from ledger_entries where id = p_reference_id and deleted_at is null;
        if v_ref is null then
          raise exception 'ledger entry not found, or it has already been deleted';
        end if;
        if p_field <> 'amount' then
          raise exception
            'a posted voucher may only be amended by amount. Its description, date and head '
            'are part of the entry and cannot be rewritten — post a corrected entry instead.';
        end if;
        v_ledger := app.amend_document_ledger(p_reference_id, v_num, p_reason, p_actor_id, p_actor_name, v_date);

      -- -------------------------------------------------------------------
      when 'finance_transaction' then
        select txn_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from finance_transactions where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'transaction not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text into v_old from finance_transactions where id = p_reference_id;
            update finance_transactions set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update finance_transactions
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'description' then
            select description into v_old from finance_transactions where id = p_reference_id;
            update finance_transactions set description = v_new where id = p_reference_id;
          else
            raise exception 'field "%" is not amendable on a transaction (amount, description)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- salary_payment — net_salary is gross + bonus − deductions, so a
      -- component change restates it. The ledger carries the NET.
      -- -------------------------------------------------------------------
      when 'salary_payment' then
        select salary_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from salary_payments where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'salary payment not found, or already deleted'; end if;

        case p_field
          when 'grossSalary' then
            select gross_salary::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set gross_salary = v_num, net_salary = v_num + bonus - deductions
             where id = p_reference_id;
          when 'bonus' then
            select bonus::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set bonus = v_num, net_salary = gross_salary + v_num - deductions
             where id = p_reference_id;
          when 'deductions' then
            select deductions::text into v_old from salary_payments where id = p_reference_id;
            update salary_payments
               set deductions = v_num, net_salary = gross_salary + bonus - v_num
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on a salary payment (grossSalary, bonus, deductions). '
              'netSalary is derived from the three and cannot be set directly.', p_field;
        end case;

        if v_status in ('posted', 'locked') then
          v_ledger := app.amend_document_ledger(
            v_entry, (select net_salary from salary_payments where id = p_reference_id),
            p_reason, p_actor_id, p_actor_name, v_date);
          update salary_payments
             set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
           where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
        end if;

      -- -------------------------------------------------------------------
      -- employee_advance — total_amount = advance + bonus + loan, enforced by
      -- employee_advances_total_matches, so every component restates it.
      -- -------------------------------------------------------------------
      when 'employee_advance' then
        select advance_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from employee_advances where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'employee advance not found, or already deleted'; end if;

        case p_field
          when 'advanceAmount' then
            select advance_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set advance_amount = v_num, total_amount = v_num + bonus_amount + loan_amount
             where id = p_reference_id;
          when 'bonusAmount' then
            select bonus_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set bonus_amount = v_num, total_amount = advance_amount + v_num + loan_amount
             where id = p_reference_id;
          when 'loanAmount' then
            select loan_amount::text into v_old from employee_advances where id = p_reference_id;
            update employee_advances
               set loan_amount = v_num, total_amount = advance_amount + bonus_amount + v_num
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on an employee advance (advanceAmount, bonusAmount, loanAmount). '
              'totalAmount is their sum and is enforced by a CHECK.', p_field;
        end case;

        if v_status in ('posted', 'locked') then
          v_ledger := app.amend_document_ledger(
            v_entry, (select total_amount from employee_advances where id = p_reference_id),
            p_reason, p_actor_id, p_actor_name, v_date);
          update employee_advances
             set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
           where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
        end if;

      -- -------------------------------------------------------------------
      when 'partner_expense' then
        select expense_no, status::text, ledger_entry_id into v_ref, v_status, v_entry
          from partner_expenses where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'partner expense not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text into v_old from partner_expenses where id = p_reference_id;
            update partner_expenses set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update partner_expenses
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'description' then
            select description into v_old from partner_expenses where id = p_reference_id;
            update partner_expenses set description = v_new where id = p_reference_id;
          else
            raise exception 'field "%" is not amendable on a partner expense (amount, description)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- branch_share_payment — two money columns posting to two DIFFERENT
      -- vouchers (the share and the bonus), so each amends its own.
      -- -------------------------------------------------------------------
      when 'branch_share_payment' then
        select payment_no, status::text into v_ref, v_status
          from branch_share_payments where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'branch share payment not found, or already deleted'; end if;

        case p_field
          when 'amount' then
            select amount::text, ledger_entry_id into v_old, v_entry
              from branch_share_payments where id = p_reference_id;
            update branch_share_payments set amount = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update branch_share_payments
                 set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          when 'bonus' then
            select bonus::text, bonus_ledger_entry_id into v_old, v_entry
              from branch_share_payments where id = p_reference_id;
            update branch_share_payments set bonus = v_num where id = p_reference_id;
            if v_status in ('posted', 'locked') then
              v_ledger := app.amend_document_ledger(v_entry, v_num, p_reason, p_actor_id, p_actor_name, v_date);
              update branch_share_payments
                 set bonus_ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
               where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
            end if;
          else
            raise exception 'field "%" is not amendable on a branch share payment (amount, bonus)', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- income_approval — the one type with no `ledger_entry_id`. Approving a
      -- branch's day posts SEVERAL vouchers (the company share, the branch
      -- share) and the row keeps no handle on them, so there is nothing here to
      -- reverse-and-repost against. Amending a POSTED day would therefore
      -- restate the approval while leaving the book untouched — the exact
      -- disagreement this function exists to prevent.
      --
      -- So it is refused, with the correction that does work: amend the
      -- vouchers themselves, which the raiser can cite by their RV-/PV- numbers.
      -- -------------------------------------------------------------------
      when 'income_approval' then
        select reference_no, status::text into v_ref, v_status
          from finance_income_approvals where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'branch income record not found, or already deleted'; end if;
        -- NOT 'posted': finance_income_status has no such value. Its states are
        -- pending_verification / pending_approval / approved / rejected, and
        -- APPROVAL is the posting step — approveIncome stamps posted_at and
        -- writes the company- and branch-share vouchers in the same breath.
        -- Guarding on 'posted' here would be a condition that never fires, and
        -- an approved day would be quietly restated behind the ledger's back.
        if v_status = 'approved' then
          raise exception
            'branch income % is approved and already posted to the ledger. Its figures cannot be '
            'amended here, because the row keeps no link to the vouchers it produced — amend those '
            'vouchers directly by their RV-/PV- numbers so the book and the approval stay in step.', v_ref;
        end if;

        case p_field
          when 'totalAmount' then
            select total_amount::text into v_old from finance_income_approvals where id = p_reference_id;
            update finance_income_approvals
               set total_amount  = v_num,
                   net_amount    = v_num - branch_expenses,
                   company_share = round((v_num - branch_expenses) * company_share_pct / 100, 2),
                   branch_share  = round((v_num - branch_expenses) * branch_share_pct  / 100, 2)
             where id = p_reference_id;
          when 'branchExpenses' then
            select branch_expenses::text into v_old from finance_income_approvals where id = p_reference_id;
            update finance_income_approvals
               set branch_expenses = v_num,
                   net_amount      = total_amount - v_num,
                   company_share   = round((total_amount - v_num) * company_share_pct / 100, 2),
                   branch_share    = round((total_amount - v_num) * branch_share_pct  / 100, 2)
             where id = p_reference_id;
          else
            raise exception
              'field "%" is not amendable on branch income (totalAmount, branchExpenses). '
              'The net and the two shares are derived from them.', p_field;
        end case;

      -- -------------------------------------------------------------------
      -- cash_transfer (migrations 120, 121) — a branch deposit, CT-000001.
      --
      -- Since 121 the figures are the three channels and Fuel Charges. The
      -- Total (`amount`) is never keyed: it is recomputed from the channels in
      -- the same UPDATE, and the table's CHECK holds it there. A changed figure
      -- on an APPROVED deposit reverses the voucher of the slice that changed
      -- and posts its replacement (app.repost_cash_transfer_ledger),
      -- so the book never keeps a stale amount. A rejected deposit is final; a
      -- pending one is edited in place and Finance approves the corrected row.
      -- -------------------------------------------------------------------
      when 'cash_transfer' then
        select transfer_no, status::text, ledger_entry_id
          into v_ref, v_status, v_entry
          from cash_transfers where id = p_reference_id and deleted_at is null;
        if v_ref is null then raise exception 'cash transfer not found, or already deleted'; end if;
        if v_status = 'rejected' then
          raise exception
            'cash transfer % was rejected and is final. Nothing was booked for it; the branch '
            'records a new transfer instead.', v_ref;
        end if;

        case p_field
          when 'cashAmount', 'easypaisaAmount', 'bankAmount', 'fuelCharges' then
            select (case p_field
                      when 'cashAmount'      then cash_amount
                      when 'easypaisaAmount' then easypaisa_amount
                      when 'bankAmount'      then bank_amount
                      else fuel_charges
                    end)::text
              into v_old from cash_transfers where id = p_reference_id;

            update cash_transfers
               set cash_amount      = case when p_field = 'cashAmount'      then v_num else cash_amount end,
                   easypaisa_amount = case when p_field = 'easypaisaAmount' then v_num else easypaisa_amount end,
                   bank_amount      = case when p_field = 'bankAmount'      then v_num else bank_amount end,
                   fuel_charges     = case when p_field = 'fuelCharges'     then v_num else fuel_charges end,
                   amount           = (case when p_field = 'cashAmount'      then v_num else cash_amount end)
                                    + (case when p_field = 'easypaisaAmount' then v_num else easypaisa_amount end)
                                    + (case when p_field = 'bankAmount'      then v_num else bank_amount end),
                   -- The single legacy method no longer describes a re-split row.
                   payment_method   = null,
                   updated_by       = p_actor_id,
                   updated_by_name  = p_actor_name
             where id = p_reference_id
               and (case when p_field = 'cashAmount'      then v_num else cash_amount end)
                 + (case when p_field = 'easypaisaAmount' then v_num else easypaisa_amount end)
                 + (case when p_field = 'bankAmount'      then v_num else bank_amount end)
                 + (case when p_field = 'fuelCharges'     then v_num else fuel_charges end) > 0;
            if not found then
              raise exception
                'cash deposit % would have every amount at 0. Delete the record instead.', v_ref;
            end if;

            if v_status = 'approved' and v_old::numeric <> v_num then
              v_ledger := app.repost_cash_transfer_ledger(p_reference_id, p_reason, p_actor_id, p_actor_name, v_date);
            end if;

          when 'note' then
            select coalesce(note, '') into v_old from cash_transfers where id = p_reference_id;
            update cash_transfers
               set note = nullif(v_new, ''), updated_by = p_actor_id, updated_by_name = p_actor_name
             where id = p_reference_id;

          when 'amount', 'paymentMethod' then
            raise exception
              'since migration 121 a cash deposit is corrected by its Cash, Easypaisa, Bank and Fuel '
              'Charges figures — the Total follows from them and there is no single method to change';

          else
            raise exception
              'field "%" is not amendable on a cash transfer (cashAmount, easypaisaAmount, bankAmount, fuelCharges, note)',
              p_field;
        end case;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    return jsonb_build_object(
      'referenceType',  p_reference_type,
      'referenceNo',    v_ref,
      'field',          p_field,
      'originalValue',  v_old,
      'newValue',       coalesce(v_num::text, v_new),
      -- Null when either side is not a number — a description change has no
      -- difference, and reporting 0 there would read as "nothing moved".
      'difference',     case when v_num is not null and v_old ~ '^-?[0-9]+(\.[0-9]+)?$'
                             then v_num - v_old::numeric end,
      'ledger',         v_ledger
    );
  end;
  $$;

revoke all on function amend_finance_record(text, uuid, text, text, text, uuid, text, date)
  from public, anon, authenticated;
grant execute on function amend_finance_record(text, uuid, text, text, text, uuid, text, date)
  to service_role;

-- 8. soft_delete_finance_record — 120's body; a deleted deposit reverses every voucher
create or replace function soft_delete_finance_record(
  p_reference_type text,
  p_reference_id   uuid,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_name     text,
  p_query_id       uuid,
  p_query_no       text
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ref       text;
    v_recompute jsonb;
    -- Migration 120: a deleted cash transfer reverses its receipt.
    v_ct_status text;
    v_ct_entry  uuid;
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'the query names no finance record');
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'a deletion must carry a reason';
    end if;

    case p_reference_type

      when 'ledger_entry' then
        update ledger_entries
           set deleted_at       = now(),
               deleted_by       = p_actor_id,
               deleted_by_name  = p_actor_name,
               delete_reason    = p_reason,
               deleted_query_id = p_query_id,
               deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning voucher_no into v_ref;

        -- The chain has a hole in it the moment the stamp lands, and it is
        -- closed inside the same transaction — the book is never observable
        -- with a balance that does not add up. Same advisory lock
        -- post_finance_ledger_entry takes, and re-entrant within a transaction.
        if v_ref is not null then
          v_recompute := recompute_finance_ledger_balances();
        end if;

      when 'income_approval' then
        update finance_income_approvals
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning reference_no into v_ref;

      when 'finance_transaction' then
        update finance_transactions
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning txn_no into v_ref;

      when 'salary_payment' then
        update salary_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning salary_no into v_ref;

      when 'employee_advance' then
        update employee_advances
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning advance_no into v_ref;

      when 'partner_expense' then
        update partner_expenses
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning expense_no into v_ref;

      when 'branch_share_payment' then
        update branch_share_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning payment_no into v_ref;

      -- Migration 120. Unlike the document branches above, this one REVERSES
      -- the receipt an approved transfer produced: a deleted handover that
      -- stays in the book as money received is exactly the double count the
      -- Help Desk exists to remove. The original voucher stays visible, marked
      -- reversed, with the reversal citing the query — nothing is rewritten.
      when 'cash_transfer' then
        update cash_transfers
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning transfer_no, status::text, ledger_entry_id into v_ref, v_ct_status, v_ct_entry;

        -- Migration 121: a deposit may hold several vouchers (cash, bank, fuel);
        -- every live one is reversed.
        if v_ref is not null and v_ct_status = 'approved' and v_ct_entry is not null then
          perform app.reverse_cash_transfer_entries(
            p_reference_id,
            (timezone('Asia/Karachi', now()))::date,
            'cash transfer ' || v_ref || ' deleted under ' || coalesce(p_query_no, 'the Help Desk') || ': ' || p_reason,
            p_actor_id, p_actor_name
          );
        end if;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already deleted, or no longer present');
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;

revoke all on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text)
  to service_role;
