-- 71: split the single FV- voucher series into RV- (receipts) and PV- (payments).
--
-- Migration 52 numbered every ledger entry from one counter, so an income
-- document and an expense document came off the same FV- run and the number told
-- you nothing about which it was. Finance wants the two series a cash book
-- normally keeps: a Receipt Voucher for money in and a Payment Voucher for money
-- out, each counting independently from 000001.
--
-- KEYED OFF THE DEBIT/CREDIT SIDE, NOT THE HEAD TYPE. For an ordinary posting the
-- two agree — finance-ledger.service.ts maps headType 'income' → debit and
-- 'expense' → credit, so an income document gets RV and an expense document gets
-- PV, which is what was asked for. They diverge in exactly two places, and the
-- side is right in both:
--
--   * A REVERSAL mirrors the original (see reverse_finance_ledger_entry), so
--     cancelling a receipt posts a credit — money leaving. That belongs in the PV
--     series; numbering it RV would put an outgoing figure in the receipt run.
--   * The opening-balance adjustment in finance-settings.service.ts posts a bare
--     delta with no head type to read, and only has a side.
--
-- EXISTING FV- NUMBERS ARE LEFT ALONE. They are what the signed-off day reports,
-- the audit trail and the help-desk tickets already refer to; renumbering them
-- would rewrite history this module is built to refuse. FV- simply stops being
-- issued, and the ledger reads FV- up to today and RV-/PV- after it.
--
-- The `finance_voucher` counter row is deliberately NOT deleted: next_finance_number
-- raises if a counter row is missing, and leaving it costs nothing while making a
-- rollback to the old function a one-liner.

insert into counters (id, count) values
  ('finance_receipt_voucher', 0),
  ('finance_payment_voucher', 0)
  on conflict (id) do nothing;

-- Replaced wholesale from migration 52 with one line changed (the voucher_no
-- expression). Same signature, so the grants at the foot of 52 carry over —
-- `create or replace` preserves the ACL.
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
      -- The one change from migration 52. Exactly one side is non-zero (the CHECK
      -- at the top of this function guarantees it), so this never falls through
      -- to the wrong series: debit is money in, everything else is money out.
      case when v_debit > 0
        then app.next_finance_number('finance_receipt_voucher', 'RV')
        else app.next_finance_number('finance_payment_voucher', 'PV')
      end,
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
