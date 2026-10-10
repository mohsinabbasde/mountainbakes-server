-- 127: a Cash Deposit's Total posts under Company Share.
--
-- The owner: the Cash Deposit ledger head is no longer "Cash Received from
-- Branch" (INC-BRANCH-CASH) but "Company Share" (INC-COMPANY-SHARE, seeded by
-- migration 52). Only the head changes. The Total is still Cash + Easypaisa +
-- Bank as ONE income entry (123), on the same account, with the same
-- description and payment_method; Fuel Charges stay on INC-FUEL.
--
-- Only app.cash_transfer_slices changes, so approval, Help Desk corrections and
-- deletion all follow. Entries already posted keep their head — a posted entry's
-- head is immutable (migration 52's trigger); a later correction of such a
-- deposit re-syncs it to Company Share (reversing the old entry, posting the new).
-- ---------------------------------------------------------------------------

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

    -- Total = Cash + Easypaisa + Bank → one entry, under Company Share (127).
    if v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount > 0 then
      return query select 'INC-COMPANY-SHARE'::text, 'Payment received from branch - ' || v_row.branch_name,
                          (v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount)::numeric,
                          case when v_row.cash_amount >= v_row.easypaisa_amount + v_row.bank_amount
                               then 'cash'::finance_account else 'bank'::finance_account end,
                          array_to_string(array_remove(array[
                            case when v_row.cash_amount      > 0 then 'cash'         end,
                            case when v_row.easypaisa_amount > 0 then 'easypaisa'    end,
                            case when v_row.bank_amount      > 0 then 'bank_account' end
                          ], null), '+');
    end if;
    -- Fuel Charges → INC-FUEL, income, its own voucher (unchanged).
    if v_row.fuel_charges > 0 then
      return query select 'INC-FUEL'::text, 'Daily delivery charges'::text,
                          v_row.fuel_charges::numeric, 'cash'::finance_account, 'cash'::text;
    end if;
  end;
  $$;

revoke all on function app.cash_transfer_slices(uuid) from public, anon, authenticated;
grant execute on function app.cash_transfer_slices(uuid) to service_role;
