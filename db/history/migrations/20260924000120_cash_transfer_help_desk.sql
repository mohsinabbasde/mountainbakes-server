-- 120: cash transfers on the Finance Help Desk — CT- numbers as a query
-- reference, and Admin's correct / delete on the record behind one.
--
-- Migration 118 gave a branch handover its own record (cash_transfers) and
-- 94 gave Finance one desk for disputing any finance record by its number.
-- This joins the two: a Finance user types CT-000001 into the query box, the
-- query lands with the Admin like every other, and the Admin's Correct record
-- and Delete record work on it.
--
-- ─── What changes ────────────────────────────────────────────────────────────
--   1. cash_transfers gains the six soft-delete columns every other finance
--      document carries (94 §4), and the partial index over live rows.
--   2. finance_tickets_reference_type_check admits 'cash_transfer' (the text
--      CHECK migration 96 last redefined — not an enum, so no 55P04 concern).
--   3. app.repost_cash_transfer_ledger(): reverse a transfer's receipt and post
--      a fresh one from the corrected row. Used by amend, below.
--   4. amend_finance_record() and soft_delete_finance_record() are redefined in
--      full (create or replace replaces the whole body) — the 94 text verbatim
--      plus one branch each, and the numeric-parse guard widened for the two
--      text fields a cash transfer has. Same signatures, so the grants carry.
--   5. approve_cash_transfer() / reject_cash_transfer() refuse a deleted row.
--
-- ─── Two decisions worth stating ─────────────────────────────────────────────
-- A DELETED APPROVED TRANSFER REVERSES ITS RECEIPT. The other document branches
-- of soft_delete_finance_record stamp the row and leave the voucher live; for a
-- handover that would leave "money received" in the book for money the desk
-- has just ruled never arrived. The reversal is a real voucher citing the
-- query; the original stays, marked reversed. Restoring a deleted record is
-- not something the desk offers for any type (restore / recreate act on the
-- QUERY), so this is a one-way door, as it is everywhere else.
--
-- A CORRECTED AMOUNT OR METHOD RE-POSTS AS source 'cash_transfer', not as an
-- 'adjustment' of the old voucher, so the branch's photo still resolves from
-- the new RV- (finance-ledger.service.ts) and a method change moves the money
-- between the cash and bank accounts, which an in-place amendment cannot.
--
-- ADDITIVE. No row is deleted, no voucher rewritten, no enum touched.
-- ---------------------------------------------------------------------------

-- 1. Soft delete, as on every other finance document (94 §4)
alter table cash_transfers
  add column if not exists deleted_at       timestamptz,
  add column if not exists deleted_by       uuid references users (id) on delete set null,
  add column if not exists deleted_by_name  text,
  add column if not exists delete_reason    text,
  add column if not exists deleted_query_id uuid,
  add column if not exists deleted_query_no text;

create index if not exists cash_transfers_live_idx on cash_transfers (deleted_at) where deleted_at is null;

-- 2. The desk may name a transfer
alter table finance_tickets drop constraint if exists finance_tickets_reference_type_check;
alter table finance_tickets add constraint finance_tickets_reference_type_check
  check (reference_type in (
    'ledger_entry', 'income_approval', 'finance_transaction',
    'salary_payment', 'employee_advance', 'partner_expense',
    'branch_share_payment', 'order', 'cash_transfer'
  ));

-- 3. Reverse the receipt an approved transfer produced and post a fresh one
--    from the row as it now stands. Same posting as approve_cash_transfer.
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
    v_row   cash_transfers%rowtype;
    v_head  ledger_heads%rowtype;
    v_rev   ledger_entries%rowtype;
    v_new   ledger_entries%rowtype;
  begin
    select * into v_row from cash_transfers where id = p_transfer_id for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_transfer_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'approved' or v_row.ledger_entry_id is null then
      return jsonb_build_object('ledgerAmended', false);
    end if;

    select * into v_head from ledger_heads where code = 'INC-BRANCH-CASH';
    if not found then
      raise exception 'ledger head INC-BRANCH-CASH is missing (seeded by migration 52)';
    end if;

    select * into v_rev from reverse_finance_ledger_entry(
      v_row.ledger_entry_id, p_entry_date, p_reason, p_actor_id, p_actor_name, null, null
    ) limit 1;

    select * into v_new from post_finance_ledger_entry(
      p_entry_date,
      v_head.id,
      'Payment received from branch - ' || v_row.branch_name,
      v_row.amount,
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
       set ledger_entry_id = v_new.id, voucher_no = v_new.voucher_no
     where id = p_transfer_id;

    return jsonb_build_object(
      'ledgerAmended',      true,
      'reversalVoucherNo',  v_rev.voucher_no,
      'correctedVoucherNo', v_new.voucher_no,
      'correctedEntryId',   v_new.id
    );
  end;
  $$;

revoke all on function app.repost_cash_transfer_ledger(uuid, text, uuid, text, date) from public, anon, authenticated;
grant execute on function app.repost_cash_transfer_ledger(uuid, text, uuid, text, date) to service_role;

-- 4. amend_finance_record — migration 94's body plus the cash_transfer branch
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
      -- cash_transfer (migration 120) — a branch handover, CT-000001.
      --
      -- Three fields. `amount` and `paymentMethod` MOVE THE LEDGER when the
      -- transfer is approved: not through app.amend_document_ledger, which
      -- re-posts on the original's account and as source 'adjustment' — a
      -- method change moves the money between the cash and bank accounts, and
      -- an 'adjustment' source would lose the branch's photo behind the voucher
      -- (finance-ledger.service.ts resolves it by source). So the original
      -- receipt is reversed and a FRESH receipt posted from the corrected row,
      -- exactly as approve_cash_transfer posts it: app.repost_cash_transfer_ledger.
      --
      -- A rejected transfer is final and never had a receipt; the branch
      -- records a new one. A pending transfer is edited in place — nothing is
      -- booked yet — and Finance approves the corrected figure.
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
          when 'amount' then
            if v_num <= 0 then
              raise exception 'a cash transfer amount must be more than 0 (got %)', v_num;
            end if;
            select amount::text into v_old from cash_transfers where id = p_reference_id;
            update cash_transfers set amount = v_num where id = p_reference_id;
            if v_status = 'approved' and v_old::numeric <> v_num then
              v_ledger := app.repost_cash_transfer_ledger(p_reference_id, p_reason, p_actor_id, p_actor_name, v_date);
            end if;

          when 'paymentMethod' then
            if v_new not in ('cash', 'easypaisa', 'bank_account') then
              raise exception '"%" is not a payment method (cash, easypaisa, bank_account)', v_new;
            end if;
            select payment_method into v_old from cash_transfers where id = p_reference_id;
            update cash_transfers set payment_method = v_new where id = p_reference_id;
            if v_status = 'approved' and v_old is distinct from v_new then
              v_ledger := app.repost_cash_transfer_ledger(p_reference_id, p_reason, p_actor_id, p_actor_name, v_date);
            end if;

          when 'note' then
            select coalesce(note, '') into v_old from cash_transfers where id = p_reference_id;
            update cash_transfers set note = nullif(v_new, '') where id = p_reference_id;

          else
            raise exception 'field "%" is not amendable on a cash transfer (amount, paymentMethod, note)', p_field;
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

-- 4b. soft_delete_finance_record — migration 94's body plus the cash_transfer branch
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

        if v_ref is not null and v_ct_status = 'approved' and v_ct_entry is not null then
          perform reverse_finance_ledger_entry(
            v_ct_entry,
            (timezone('Asia/Karachi', now()))::date,
            'cash transfer ' || v_ref || ' deleted under ' || coalesce(p_query_no, 'the Help Desk') || ': ' || p_reason,
            p_actor_id, p_actor_name, null, null
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

-- 5. A deleted transfer cannot be approved or rejected (118's bodies otherwise)
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
    -- Migration 120: a soft-deleted transfer is not decidable.
    select * into v_row from cash_transfers where id = p_id and deleted_at is null for update;
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

    -- Migration 120: a soft-deleted transfer is not decidable.
    select * into v_row from cash_transfers where id = p_id and deleted_at is null for update;
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
