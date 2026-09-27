-- 123: a Cash Deposit books its Total as ONE ledger entry.
--
-- ─── What the owner asked for ────────────────────────────────────────────────
-- Migration 121 booked the Total as one entry per ACCOUNT the money landed in:
-- the Cash part on the cash account, Easypaisa + Bank on the bank account. The
-- owner reads that as Cash, Easypaisa and Bank becoming separate entries in the
-- Finance Ledger, which is wrong for them. Cash / Easypaisa / Bank are payment-
-- channel details of the deposit and stay on the cash_transfers row
-- (cash_amount, easypaisa_amount, bank_amount); the ledger carries the Total.
--
--   Total  → INC-BRANCH-CASH, "Payment received from branch - <branch>",
--            income (debit), amount = cash + easypaisa + bank. ONE entry.
--   Fuel   → INC-FUEL, "Daily delivery charges", income. Unchanged, its own
--            entry, never part of the Total.
--
-- Neither is posted at zero (unchanged).
--
-- ─── The account ─────────────────────────────────────────────────────────────
-- A ledger entry sits on one account, so a mixed deposit can no longer put
-- each part on its own. The entry goes on the account that holds the larger
-- share: cash if cash_amount ≥ easypaisa + bank, else bank. A single-channel
-- deposit — most of them — lands exactly where it did before. The entry's
-- payment_method names every channel used ('cash+easypaisa+bank_account'), so
-- the mix is still visible from the ledger; the exact split is on the deposit.
--
-- Only app.cash_transfer_slices changes. Approval, Help Desk corrections and
-- deletion all read it (121), so they all follow. Deposits approved before this
-- migration keep their vouchers; a later correction of one re-syncs it to the
-- single-entry form (reversing the old pair, posting the one).
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

    -- Total = Cash + Easypaisa + Bank → one entry.
    if v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount > 0 then
      return query select 'INC-BRANCH-CASH'::text, 'Payment received from branch - ' || v_row.branch_name,
                          (v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount)::numeric,
                          case when v_row.cash_amount >= v_row.easypaisa_amount + v_row.bank_amount
                               then 'cash'::finance_account else 'bank'::finance_account end,
                          array_to_string(array_remove(array[
                            case when v_row.cash_amount      > 0 then 'cash'         end,
                            case when v_row.easypaisa_amount > 0 then 'easypaisa'    end,
                            case when v_row.bank_amount      > 0 then 'bank_account' end
                          ], null), '+');
    end if;
    -- Fuel Charges → INC-FUEL, income, its own voucher.
    if v_row.fuel_charges > 0 then
      return query select 'INC-FUEL'::text, 'Daily delivery charges'::text,
                          v_row.fuel_charges::numeric, 'cash'::finance_account, 'cash'::text;
    end if;
  end;
  $$;

revoke all on function app.cash_transfer_slices(uuid) from public, anon, authenticated;
grant execute on function app.cash_transfer_slices(uuid) to service_role;
