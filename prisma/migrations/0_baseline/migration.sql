-- The schema of the database at the moment it went into service, written by
-- `pnpm db:baseline`. Already applied to that database: mark it so with
-- `prisma migrate resolve --applied 0_baseline`. Do not edit — changes are new
-- migrations. Building a database from nothing: bootstrap.sql, this, post-restore.sql.

--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: app_theme; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_theme AS ENUM (
    'light',
    'dark'
);


--
-- Name: attachment_entity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.attachment_entity AS ENUM (
    'finance_transaction',
    'partner_expense',
    'branch_share_payment',
    'salary_payment',
    'finance_income_approval',
    'production_order_demand',
    'production_order_verification',
    'production_order_special_item',
    'employee_advance',
    'finance_ticket',
    'finance_ticket_message',
    'cash_transfer',
    'special_order_verification',
    'branch_return'
);


--
-- Name: branch_discount_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.branch_discount_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'returned'
);


--
-- Name: branch_production_order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.branch_production_order_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'awaiting_verification',
    'verified',
    'cancelled'
);


--
-- Name: cash_transfer_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cash_transfer_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);


--
-- Name: closing_report_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.closing_report_scope AS ENUM (
    'branch',
    'production',
    'company'
);


--
-- Name: closure_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.closure_status AS ENUM (
    'running',
    'success',
    'failed'
);


--
-- Name: closure_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.closure_trigger AS ENUM (
    'scheduler',
    'manual'
);


--
-- Name: daily_sale_audit_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.daily_sale_audit_action AS ENUM (
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


--
-- Name: daily_sale_record_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.daily_sale_record_status AS ENUM (
    'open',
    'pending_verification',
    'verified',
    'locked',
    'amended'
);


--
-- Name: event_calendar_system; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_calendar_system AS ENUM (
    'gregorian',
    'hijri',
    'gregorian_nth_weekday',
    'hijri_last_weekday'
);


--
-- Name: event_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_category AS ENUM (
    'islamic',
    'national',
    'international',
    'company',
    'ahlul_bayt'
);


--
-- Name: event_demand_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_demand_status AS ENUM (
    'draft',
    'submitted',
    'approved',
    'rejected',
    'fulfilled'
);


--
-- Name: event_notification_audience; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_notification_audience AS ENUM (
    'branch',
    'production',
    'admin'
);


--
-- Name: event_notification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_notification_status AS ENUM (
    'pending',
    'sending',
    'sent',
    'failed',
    'skipped',
    'cancelled'
);


--
-- Name: event_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_priority AS ENUM (
    'low',
    'normal',
    'high',
    'critical'
);


--
-- Name: event_production_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_production_stage AS ENUM (
    'raw_materials',
    'packing_materials',
    'finished_products',
    'staff_assigned'
);


--
-- Name: event_reminder_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_reminder_kind AS ENUM (
    'event_countdown',
    'demand_due',
    'preparation_start'
);


--
-- Name: event_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_status AS ENUM (
    'upcoming',
    'active',
    'completed',
    'cancelled'
);


--
-- Name: expense_payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.expense_payment_method AS ENUM (
    'cash',
    'easypaisa'
);


--
-- Name: finance_account; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.finance_account AS ENUM (
    'cash',
    'bank'
);


--
-- Name: finance_doc_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.finance_doc_status AS ENUM (
    'draft',
    'pending_approval',
    'approved',
    'posted',
    'locked',
    'rejected'
);


--
-- Name: finance_income_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.finance_income_status AS ENUM (
    'pending_verification',
    'pending_approval',
    'approved',
    'rejected'
);


--
-- Name: finance_ledger_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.finance_ledger_source AS ENUM (
    'opening',
    'manual',
    'branch_income',
    'company_share',
    'branch_share',
    'salary',
    'partner_expense',
    'adjustment',
    'branch_share_payout',
    'branch_share_bonus',
    'employee_advance',
    'cash_transfer'
);


--
-- Name: ledger_entry_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_entry_status AS ENUM (
    'posted',
    'locked',
    'reversed'
);


--
-- Name: ledger_head_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_head_type AS ENUM (
    'income',
    'expense'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'whatsapp',
    'sms',
    'both'
);


--
-- Name: notification_delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_delivery_status AS ENUM (
    'pending',
    'sent',
    'failed'
);


--
-- Name: notification_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_type AS ENUM (
    'order_created',
    'order_ready',
    'order_cancelled',
    'low_stock',
    'new_user',
    'branch_added',
    'price_changed',
    'production_demand',
    'production_reviewed',
    'production_return',
    'password_reset',
    'ticket_created',
    'ticket_replied',
    'ticket_resolved',
    'ticket_reopened',
    'ticket_status_changed',
    'support_query',
    'support_resolved',
    'event_created',
    'event_reminder',
    'event_demand_due',
    'event_demand_submitted',
    'event_demand_reviewed',
    'event_production_updated',
    'production_order_verified',
    'finance_query',
    'finance_query_resolved',
    'branch_user_requested',
    'branch_user_reviewed',
    'production_demand_cancelled',
    'branch_discount',
    'branch_discount_reviewed',
    'finance_query_updated',
    'finance_query_message',
    'finance_query_amended',
    'security_alert',
    'cash_transfer',
    'cash_transfer_reviewed'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'preparing',
    'ready',
    'delivered',
    'cancelled'
);


--
-- Name: payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method AS ENUM (
    'cash',
    'easypaisa',
    'foodpanda',
    'bank_account',
    'staff'
);


--
-- Name: price_change_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.price_change_source AS ENUM (
    'manual',
    'import'
);


--
-- Name: price_change_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.price_change_status AS ENUM (
    'scheduled',
    'active',
    'superseded'
);


--
-- Name: production_expense_payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.production_expense_payment_method AS ENUM (
    'cash',
    'easypaisa',
    'bank_account'
);


--
-- Name: production_return_disposition; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.production_return_disposition AS ENUM (
    'saleable',
    'damaged',
    'expired'
);


--
-- Name: production_return_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.production_return_status AS ENUM (
    'pending',
    'accepted',
    'rejected',
    'returned'
);


--
-- Name: production_stock_movement_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.production_stock_movement_type AS ENUM (
    'prepare',
    'transfer_out',
    'return_in',
    'sale',
    'adjustment',
    'return_transfer'
);


--
-- Name: return_stock_movement_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.return_stock_movement_type AS ENUM (
    'return_in',
    'transfer_out'
);


--
-- Name: stock_movement_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.stock_movement_type AS ENUM (
    'sale',
    'production',
    'return',
    'adjustment'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'super_admin',
    'branch_manager',
    'production_user',
    'finance_admin',
    'finance_manager',
    'accountant',
    'finance_auditor',
    'branch_user'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'inactive',
    'suspended'
);


--
-- Name: amend_document_ledger(uuid, numeric, text, uuid, text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.amend_document_ledger(p_entry_id uuid, p_new_amount numeric, p_reason text, p_actor_id uuid, p_actor_name text, p_entry_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;
    return app.edit_ledger_entry(
      p_entry_id, jsonb_build_object('amount', round(p_new_amount, 2)), p_actor_id, p_actor_name, p_entry_date);
  end;
  $$;


--
-- Name: attachments_immutable(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.attachments_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if tg_op = 'DELETE' then
      if old.entity_id is null then
        return old;
      end if;
      raise exception
        'attachment % cannot be deleted. A document''s supporting photo is part of '
        'its audit trail.', old.id;
    end if;

    if old.entity_id is not null then
      raise exception
        'attachment % is already bound to %/% and is immutable.',
        old.id, old.entity, old.entity_id;
    end if;

    if (new.entity, new.storage_path, new.mime_type, new.size_bytes, new.uploaded_by)
       is distinct from
       (old.entity, old.storage_path, old.mime_type, old.size_bytes, old.uploaded_by)
    then
      raise exception
        'attachment % may only have entity_id and bound_at set; the file itself is '
        'immutable.', old.id;
    end if;

    return new;
  end;
  $$;


--
-- Name: business_date(timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.business_date(ts timestamp with time zone) RETURNS date
    LANGUAGE sql STABLE
    AS $$ select ((ts + interval '5 hours' - interval '2 hours') at time zone 'UTC')::date $$;


--
-- Name: FUNCTION business_date(ts timestamp with time zone); Type: COMMENT; Schema: app; Owner: -
--

COMMENT ON FUNCTION app.business_date(ts timestamp with time zone) IS 'Business date (Asia/Karachi, 02:00 rollover) for an instant. Mirrors businessDateStr() in shared/utils/timezone.ts.';


--
-- Name: cash_transfer_ledger_chain(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.cash_transfer_ledger_chain(p_id uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE
    AS $$
    with recursive chain(id) as (
      select id from ledger_entries
       where source_type = 'cash_transfer' and source_id = p_id
      union
      -- reverse_finance_ledger_entry posts its reversal (and any corrected
      -- re-post) as source_type 'adjustment', source_id = the original.
      select e.id from ledger_entries e join chain c
        on (e.source_type = 'adjustment' and e.source_id = c.id) or e.reverses_entry_id = c.id
    )
    select id from chain
  $$;


--
-- Name: cash_transfer_slices(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.cash_transfer_slices(p_id uuid) RETURNS TABLE(head_code text, description text, amount numeric, account public.finance_account, payment_method text)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: data_engine_condition(text, jsonb); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_engine_condition(p_table text, p_node jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
  declare
    v_parts text[] := '{}';
    v_child jsonb;
    v_column text;
    v_op text;
    v_value jsonb;
    v_ident text;
    v_list text[];
    v_item jsonb;
  begin
    if p_node is null or p_node = 'null'::jsonb then
      return 'true';
    end if;

    if p_node ? 'and' then
      for v_child in select * from jsonb_array_elements(p_node -> 'and') loop
        v_parts := array_append(v_parts, app.data_engine_condition(p_table, v_child));
      end loop;
      if coalesce(array_length(v_parts, 1), 0) = 0 then return 'true'; end if;
      return '(' || array_to_string(v_parts, ' and ') || ')';
    end if;

    if p_node ? 'or' then
      for v_child in select * from jsonb_array_elements(p_node -> 'or') loop
        v_parts := array_append(v_parts, app.data_engine_condition(p_table, v_child));
      end loop;
      if coalesce(array_length(v_parts, 1), 0) = 0 then return 'false'; end if;
      return '(' || array_to_string(v_parts, ' or ') || ')';
    end if;

    v_column := p_node ->> 'column';
    v_op := p_node ->> 'op';
    v_value := p_node -> 'value';

    if v_column is null or v_op is null then
      raise exception 'data_engine: malformed condition %', p_node using errcode = '22023';
    end if;

    -- The column must exist on the table. This is the check that makes
    -- format('%I') safe: an identifier is quoted, but it is also REAL.
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_column
    ) then
      raise exception 'data_engine: unknown column % on %', v_column, p_table using errcode = '42703';
    end if;

    v_ident := format('%I', v_column);

    case v_op
      when 'null'    then return v_ident || ' is null';
      when 'notnull' then return v_ident || ' is not null';
      when 'eq'      then return v_ident || ' = '  || app.data_engine_literal(v_value);
      when 'neq'     then return v_ident || ' <> ' || app.data_engine_literal(v_value);
      when 'gt'      then return v_ident || ' > '  || app.data_engine_literal(v_value);
      when 'gte'     then return v_ident || ' >= ' || app.data_engine_literal(v_value);
      when 'lt'      then return v_ident || ' < '  || app.data_engine_literal(v_value);
      when 'lte'     then return v_ident || ' <= ' || app.data_engine_literal(v_value);
      when 'ilike'   then return v_ident || ' ilike ' || app.data_engine_literal(v_value);
      when 'in', 'nin' then
        if jsonb_typeof(v_value) <> 'array' then
          raise exception 'data_engine: % needs an array', v_op using errcode = '22023';
        end if;
        v_list := '{}';
        for v_item in select * from jsonb_array_elements(v_value) loop
          v_list := array_append(v_list, app.data_engine_literal(v_item));
        end loop;
        if coalesce(array_length(v_list, 1), 0) = 0 then
          -- IN () is a syntax error in SQL; the honest answer to "in nothing"
          -- is no rows (and "not in nothing" is every row).
          return case when v_op = 'in' then 'false' else 'true' end;
        end if;
        return v_ident || case when v_op = 'in' then ' in (' else ' not in (' end
               || array_to_string(v_list, ', ') || ')';
      else
        raise exception 'data_engine: unsupported operator %', v_op using errcode = '22023';
    end case;
  end;
  $$;


--
-- Name: data_engine_literal(jsonb); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_engine_literal(p_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    select case jsonb_typeof(p_value)
      when 'string'  then quote_literal(p_value #>> '{}')
      when 'number'  then (p_value #>> '{}')
      when 'boolean' then (p_value #>> '{}')
      when 'null'    then 'null'
      else quote_literal(p_value::text)
    end;
  $$;


--
-- Name: delete_cash_transfer_entries(uuid, text, uuid, text, uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_cash_transfer_entries(p_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_query_id uuid, p_query_no text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
  declare
    v_nos        text;
    v_recompute  jsonb;
  begin
    with removed as (
      update ledger_entries
         set deleted_at       = now(),
             deleted_by       = p_actor_id,
             deleted_by_name  = p_actor_name,
             delete_reason    = p_reason,
             deleted_query_id = p_query_id,
             deleted_query_no = p_query_no
       where id in (select app.cash_transfer_ledger_chain(p_id)) and deleted_at is null
      returning voucher_no, seq
    )
    select string_agg(voucher_no, ', ' order by seq) into v_nos from removed;

    if v_nos is not null then
      v_recompute := recompute_finance_ledger_balances();
    end if;

    return jsonb_build_object('voucherNos', v_nos, 'recompute', v_recompute);
  end;
  $$;


--
-- Name: edit_ledger_entry(uuid, jsonb, uuid, text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.edit_ledger_entry(p_entry_id uuid, p_set jsonb, p_actor_id uuid, p_actor_name text, p_today date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_orig        ledger_entries%rowtype;
    v_head        ledger_heads%rowtype;
    v_old_amount  numeric(14,2);
    v_amount      numeric(14,2);
    v_head_id     uuid;
    v_head_name   text;
    v_branch_id   uuid;
    v_branch_name text;
    v_date        date;
    v_method      text;
    v_account     finance_account;
    v_desc        text;
    v_closed      date;
  begin
    if p_entry_id is null then
      return jsonb_build_object('ledgerAmended', false, 'reason', 'document is not posted');
    end if;

    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry not found, or it has already been deleted';
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % was reversed by % and is no longer part of the book. Correct the entry that replaced it.',
        v_orig.voucher_no,
        coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), 'another entry');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is a reversing entry and cannot be corrected', v_orig.voucher_no;
    end if;

    v_old_amount := greatest(v_orig.debit, v_orig.credit);
    v_amount := case when p_set ? 'amount' then round((p_set ->> 'amount')::numeric, 2) else v_old_amount end;
    if v_amount <= 0 then
      raise exception 'the amount of voucher % must be greater than 0. Delete the record instead.', v_orig.voucher_no;
    end if;

    v_head_id   := v_orig.ledger_head_id;
    v_head_name := v_orig.ledger_head_name;
    if p_set ? 'ledgerHeadId' and (p_set ->> 'ledgerHeadId')::uuid is distinct from v_orig.ledger_head_id then
      select * into v_head from ledger_heads where id = (p_set ->> 'ledgerHeadId')::uuid;
      if not found then
        raise exception 'that category does not exist';
      end if;
      if not v_head.is_active then
        raise exception 'category "%" is inactive and cannot accept entries', v_head.name;
      end if;
      if v_head.type <> v_orig.ledger_head_type then
        raise exception
          'voucher % is % and "%" is an % category. Choose another % category, or delete the record and enter it again.',
          v_orig.voucher_no, v_orig.ledger_head_type, v_head.name, v_head.type, v_orig.ledger_head_type;
      end if;
      v_head_id := v_head.id;
      v_head_name := v_head.name;
    end if;

    if p_set ? 'branchId' then
      if nullif(btrim(p_set ->> 'branchId'), '') is null then
        v_branch_id := null;
        v_branch_name := null;
      else
        select id, name into v_branch_id, v_branch_name from branches where id = (p_set ->> 'branchId')::uuid;
        if v_branch_id is null then
          raise exception 'that branch does not exist';
        end if;
      end if;
    else
      v_branch_id := v_orig.branch_id;
      v_branch_name := v_orig.branch_name;
    end if;

    v_date := case when p_set ? 'entryDate' then (p_set ->> 'entryDate')::date else v_orig.entry_date end;
    if v_date <> v_orig.entry_date and v_date > p_today then
      raise exception 'the date of a voucher cannot be in the future';
    end if;

    v_method  := case when p_set ? 'paymentMethod' then nullif(btrim(p_set ->> 'paymentMethod'), '') else v_orig.payment_method end;
    v_account := case when p_set ? 'account' then (p_set ->> 'account')::finance_account else v_orig.account end;
    v_desc    := case when p_set ? 'description' then btrim(p_set ->> 'description') else v_orig.description end;
    if length(v_desc) = 0 then
      raise exception 'the description of a voucher cannot be empty';
    end if;

    -- A closed day is signed off: nothing on it changes and nothing lands on it.
    select business_date into v_closed
      from finance_day_closings
     where business_date in (v_orig.entry_date, v_date)
     order by business_date limit 1;
    if v_closed is not null then
      raise exception
        'the finance day % is closed, so voucher % cannot be changed on it or moved onto it. Reopen the day first.',
        to_char(v_closed, 'DD-Mon-YYYY'), v_orig.voucher_no;
    end if;

    perform set_config('app.allow_ledger_edit', 'on', true);
    update ledger_entries
       set entry_date       = v_date,
           ledger_head_id   = v_head_id,
           ledger_head_name = v_head_name,
           branch_id        = v_branch_id,
           branch_name      = v_branch_name,
           description      = v_desc,
           debit            = case when v_orig.debit  > 0 then v_amount else 0 end,
           credit           = case when v_orig.credit > 0 then v_amount else 0 end,
           account          = v_account,
           payment_method   = v_method,
           updated_at       = now(),
           updated_by       = p_actor_id,
           updated_by_name  = p_actor_name
     where id = v_orig.id;
    perform set_config('app.allow_ledger_edit', 'off', true);

    -- The balance chain runs in posting order, so only a changed figure moves it.
    if v_amount <> v_old_amount then
      perform recompute_finance_ledger_balances();
    end if;

    -- `ledgerAmended` stays false: nothing was reversed and no new voucher was
    -- posted, so there is no reversal or corrected voucher number to report and
    -- no document needs relinking — its ledger_entry_id still names this row.
    return jsonb_build_object(
      'ledgerAmended',    false,
      'editedInPlace',    true,
      'voucherNo',        v_orig.voucher_no,
      'correctedEntryId', v_orig.id
    );
  end;
  $$;


--
-- Name: finance_amendments_append_only(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_amendments_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'finance_amendments is append-only; a correction record cannot be % once written',
      case when tg_op = 'DELETE' then 'deleted' else 'altered' end;
  end;
  $$;


--
-- Name: finance_audit_immutable(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'finance_audit_logs is append-only (% attempted)', tg_op;
  end;
  $$;


--
-- Name: finance_ledger_immutable(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if tg_op = 'DELETE' then
      if coalesce(current_setting('app.allow_ledger_delete', true), 'off') = 'on' then
        return old;
      end if;
      raise exception
        'ledger entry % cannot be deleted. A posted entry is permanent: correct it '
        'with a reversing or adjustment entry, or soft-delete it through a Help Desk '
        'query so the row stays readable to an auditor.', old.voucher_no;
    end if;

    -- Balance-only repair window. Note `balance` is absent from both tuples
    -- below and every other money-bearing column is still present.
    if coalesce(current_setting('app.allow_balance_recompute', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
          new.account, new.source_type, new.source_id, new.description)
         is distinct from
         (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
          old.account, old.source_type, old.source_id, old.description)
      then
        raise exception
          'ledger entry %: the balance-recompute window permits changing `balance` and '
          'nothing else, but this update also alters another column.', old.voucher_no;
      end if;
      return new;
    end if;

    -- Re-date window (migration 132). A branch deposit keyed against the wrong
    -- day has its receipts moved to the right one. `entry_date` is absent from
    -- both tuples below and every other money-bearing column, the balance
    -- included, is still present — the window moves a voucher between days and
    -- can do nothing else to it.
    if coalesce(current_setting('app.allow_ledger_redate', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.ledger_head_id, new.debit, new.credit, new.balance,
          new.account, new.source_type, new.source_id, new.description)
         is distinct from
         (old.voucher_no, old.seq, old.ledger_head_id, old.debit, old.credit, old.balance,
          old.account, old.source_type, old.source_id, old.description)
      then
        raise exception
          'ledger entry %: the re-date window permits changing `entry_date` and '
          'nothing else, but this update also alters another column.', old.voucher_no;
      end if;
      return new;
    end if;

    -- Edit window (migration 133). A correction changes the voucher itself —
    -- its figure, date, category, account or description — and keeps its number.
    -- What may NOT move even here: the voucher number, its place in the posting
    -- order, what it was posted from, and the running balance (which only
    -- recompute_finance_ledger_balances may write, under its own window).
    if coalesce(current_setting('app.allow_ledger_edit', true), 'off') = 'on' then
      if (new.voucher_no, new.seq, new.balance, new.source_type, new.source_id)
         is distinct from
         (old.voucher_no, old.seq, old.balance, old.source_type, old.source_id)
      then
        raise exception
          'ledger entry %: a correction may not change the voucher number, its posting '
          'order, its source or its balance.', old.voucher_no;
      end if;
      if (new.debit > 0) is distinct from (old.debit > 0) then
        raise exception 'ledger entry %: a correction may not move a voucher to the other side of the book.', old.voucher_no;
      end if;
      return new;
    end if;

    -- The money-bearing columns. Unchanged from migration 62 — the soft-delete
    -- columns are deliberately NOT in this tuple, which is what permits the
    -- stamp; everything that describes the transaction still is, which is what
    -- stops the stamp being used to smuggle an edit alongside it.
    if (new.voucher_no, new.seq, new.entry_date, new.ledger_head_id, new.debit, new.credit,
        new.balance, new.account, new.source_type, new.source_id, new.description)
       is distinct from
       (old.voucher_no, old.seq, old.entry_date, old.ledger_head_id, old.debit, old.credit,
        old.balance, old.account, old.source_type, old.source_id, old.description)
    then
      raise exception
        'ledger entry % is immutable. Only status, reversal linkage and the soft-delete '
        'stamp may change; post a reversing or adjustment entry instead.', old.voucher_no;
    end if;

    -- Un-deleting is not an operation this system offers. A stamped row is the
    -- record that a deletion happened; clearing it would erase that fact and
    -- leave the balance chain, which was recomputed without the row, wrong.
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception
        'ledger entry % was deleted under query % and cannot be restored. Post a fresh '
        'entry if the amount belongs in the book.',
        old.voucher_no, coalesce(old.deleted_query_no, '?');
    end if;

    return new;
  end;
  $$;


--
-- Name: finance_order_values(date, date, uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_order_values(p_from date, p_to date, p_branch_id uuid) RETURNS TABLE(order_id uuid, demand_number text, business_date date, branch_id uuid, branch_name text, status text, demand numeric, share_pct numeric, company_share numeric, line_count integer, unpriced_lines integer, created_by_name text, approved_by_name text, verified_by_name text)
    LANGUAGE sql STABLE
    AS $$
    with def as (
      select case when fs.company_share_pct between 0 and 100 then fs.company_share_pct else 75 end as pct
      from (select (select company_share_pct from finance_settings limit 1) as company_share_pct) fs
    )
    select
      o.id, o.demand_number, o.business_date, o.branch_id,
      coalesce(b.name, o.branch_name), o.status::text,
      round(v.demand, 2),
      p.pct,
      round(v.demand * p.pct / 100, 2),
      v.lines, v.unpriced,
      o.created_by_name, o.approved_by_name, o.verified_by_name
    from production_orders o
    left join branches b on b.id = o.branch_id
    cross join def
    cross join lateral (
      select round(case when b.company_share_pct between 0 and 100 then b.company_share_pct else def.pct end, 2) as pct
    ) p
    cross join lateral (
      select
        coalesce(sum(coalesce(i.approved_qty, 0) * coalesce(pr.price, 0)), 0) as demand,
        count(*)::int as lines,
        count(*) filter (where coalesce(i.approved_qty, 0) > 0 and coalesce(pr.price, 0) = 0)::int as unpriced
      from production_order_items i
      left join products pr on pr.id = i.product_id
      where i.production_order_id = o.id
    ) v
    -- Reviewed and dispatched by Production. `pending` has shipped nothing,
    -- `rejected` / `cancelled` never will.
    where o.status::text in ('awaiting_verification', 'verified', 'approved')
      and o.business_date between p_from and p_to
      and (p_branch_id is null or o.branch_id = p_branch_id);
  $$;


--
-- Name: finance_received_head_ids(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_received_head_ids() RETURNS uuid[]
    LANGUAGE sql STABLE
    AS $$
    select coalesce(array_agg(id), '{}') from ledger_heads where code in ('INC-COMPANY-SHARE', 'INC-FUEL');
  $$;


--
-- Name: finance_ticket_messages_append_only(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_ticket_messages_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception
      'a Help Desk message is permanent. It cannot be % — post a follow-up message instead.',
      case when tg_op = 'DELETE' then 'deleted' else 'edited' end;
  end;
  $$;


--
-- Name: finance_ticket_versions_append_only(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.finance_ticket_versions_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'finance_ticket_versions is append-only (% attempted)', tg_op;
  end;
  $$;


--
-- Name: forbid_counter_removal(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.forbid_counter_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception
      'counters rows must never be removed (% attempted). counters is CONFIGURATION, not '
      'transactional data: it is the gapless allocator behind MB-/EXP-/DMD-/PRC-/STK-/EVT- '
      'numbers. Exclude it from any data purge, or every numbered insert fails with '
      '"counters row ... is missing".', tg_op;
  end;
  $$;


--
-- Name: karachi_business_date(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.karachi_business_date() RETURNS date
    LANGUAGE sql STABLE
    AS $$
  select ((now() at time zone 'Asia/Karachi') - interval '2 hours')::date;
$$;


--
-- Name: next_finance_number(text, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.next_finance_number(p_key text, p_prefix text) RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = p_key returning count into next_count;
    if not found then
      raise exception 'counters row "%" is missing — see migration 46; counters is configuration, not data', p_key;
    end if;
    return p_prefix || '-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_finance_query_no(date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.next_finance_query_no(p_day date DEFAULT NULL::date) RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare
    v_year  integer := extract(year from coalesce(p_day, (timezone('Asia/Karachi', now()))::date))::integer;
    v_count integer;
  begin
    insert into finance_query_year_counters (year, count)
         values (v_year, 1)
    on conflict (year) do update set count = finance_query_year_counters.count + 1
      returning count into v_count;

    return 'FIN-QRY-' || v_year::text || '-' || lpad(v_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_production_stock_txn_no(date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.next_production_stock_txn_no(p_business_date date) RETURNS text
    LANGUAGE sql
    AS $$
  select 'STK-' || to_char(coalesce(p_business_date, current_date), 'YYYYMMDD')
      || '-' || lpad(nextval('production_stock_txn_seq')::text, 6, '0');
$$;


--
-- Name: payment_method_default_locked(public.payment_method); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.payment_method_default_locked(m public.payment_method) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$ select m not in ('cash', 'easypaisa', 'bank_account') $$;


--
-- Name: protect_system_ledger_heads(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.protect_system_ledger_heads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if tg_op = 'DELETE' then
      if old.is_system then
        raise exception 'ledger head % is a system head and cannot be deleted', old.code;
      end if;
      return old;
    end if;

    -- The code is what the automatic postings resolve by, and reports group on
    -- it. Renaming or hiding the head is fine; re-coding it is not.
    if old.code is distinct from new.code then
      raise exception 'ledger head code is immutable (% -> %); create a new head instead', old.code, new.code;
    end if;
    if old.type is distinct from new.type then
      raise exception 'ledger head type is immutable; income and expense heads are not interchangeable';
    end if;
    return new;
  end;
  $$;


--
-- Name: refuse_special_demand_line(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.refuse_special_demand_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.is_special then
    raise exception 'A Special Order is not a demand line. Create it through special_orders.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;


--
-- Name: repost_cash_transfer_ledger(uuid, text, uuid, text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.repost_cash_transfer_ledger(p_transfer_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_entry_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: repost_ledger_entry(uuid, jsonb, text, uuid, text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.repost_ledger_entry(p_entry_id uuid, p_set jsonb, p_reason text, p_actor_id uuid, p_actor_name text, p_today date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
  begin
    return app.edit_ledger_entry(p_entry_id, p_set, p_actor_id, p_actor_name, p_today);
  end;
  $$;


--
-- Name: restriction_events_no_change(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.restriction_events_no_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'restriction_events is append-only';
  end;
  $$;


--
-- Name: salary_revisions_immutable(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.salary_revisions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'salary_revisions is append-only (% attempted)', tg_op;
  end;
  $$;


--
-- Name: seed_event_production_stages(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.seed_event_production_stages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    insert into event_production_status (event_id, stage)
    select new.id, s
    from unnest(enum_range(null::event_production_stage)) as s
    on conflict (event_id, stage) do nothing;
    return new;
  end;
  $$;


--
-- Name: split_return_stock(date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.split_return_stock(p_business_date date DEFAULT ((now() AT TIME ZONE 'Asia/Karachi'::text))::date) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  r       record;
  v_moved integer := 0;
begin
  for r in
    select pr.id, pr.product_id, pr.product_name, pr.qty, pr.branch_id, pr.reason, pr.business_date
      from production_returns pr
     where pr.status = 'accepted'
       and pr.disposition = 'saleable'
       and exists (
         select 1 from production_stock_history h
          where h.ref_id = pr.id::text and h.product_id = pr.product_id and h.type = 'return_in')
       and not exists (
         select 1 from return_stock_history rh
          where rh.ref_id = pr.id::text and rh.product_id = pr.product_id and rh.type = 'return_in')
     order by pr.business_date, pr.created_at, pr.id
  loop
    perform public.apply_production_stock_movement(
      r.product_id, r.product_name, -abs(r.qty), 'adjustment',
      'return_split_' || r.id::text, p_business_date,
      r.branch_id, null, 'migration 139',
      'Return stock separated from production stock'
    );
    perform public.apply_return_stock_movement(
      r.product_id, r.product_name, abs(r.qty), 'return_in',
      r.id::text, r.business_date,
      r.branch_id, r.id, null, 'migration 139', r.reason,
      'Moved out of production stock by migration 139'
    );
    v_moved := v_moved + 1;
  end loop;
  return v_moved;
end;
$$;


--
-- Name: stamp_production_stock_txn_no(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.stamp_production_stock_txn_no() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.transaction_no is null then
    new.transaction_no := app.next_production_stock_txn_no(new.business_date);
  end if;
  return new;
end;
$$;


--
-- Name: sync_cash_transfer_entries(uuid, date, text, uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.sync_cash_transfer_entries(p_id uuid, p_entry_date date, p_reason text, p_actor_id uuid, p_actor_name text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
  declare
    v_row      cash_transfers%rowtype;
    v_slice    record;
    v_live     ledger_entries%rowtype;
    v_head     ledger_heads%rowtype;
    v_entry    ledger_entries%rowtype;
    v_kept     uuid[] := '{}';
    v_queue    jsonb  := '[]';
    v_item     record;
    v_posted   text[] := '{}';
    v_edited   text[] := '{}';
    v_removed  text;
    v_first    uuid;
    v_all      text;
  begin
    select * into v_row from cash_transfers where id = p_id;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;

    for v_slice in select * from app.cash_transfer_slices(p_id) loop
      select e.* into v_live
        from ledger_entries e join ledger_heads h on h.id = e.ledger_head_id
       where e.source_type = 'cash_transfer' and e.source_id = p_id
         and e.status <> 'reversed' and e.reverses_entry_id is null and e.deleted_at is null
         and h.code = v_slice.head_code
         and e.id <> all (v_kept)
       order by e.seq limit 1;
      if found then
        v_kept := v_kept || v_live.id;
        if v_live.debit <> v_slice.amount
           or v_live.account <> v_slice.account
           or v_live.payment_method is distinct from v_slice.payment_method then
          perform app.edit_ledger_entry(
            v_live.id,
            jsonb_build_object(
              'amount', v_slice.amount,
              'account', v_slice.account::text,
              'paymentMethod', coalesce(v_slice.payment_method, '')),
            p_actor_id, p_actor_name, p_entry_date);
          v_edited := v_edited || v_live.voucher_no;
        end if;
      else
        v_queue := v_queue || to_jsonb(v_slice);
      end if;
    end loop;

    -- Remove every live voucher no slice claimed. Removed, not reversed.
    with removed as (
      update ledger_entries
         set deleted_at      = now(),
             deleted_by      = p_actor_id,
             deleted_by_name = p_actor_name,
             delete_reason   = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'cash deposit ' || v_row.transfer_no || ' corrected')
       where source_type = 'cash_transfer' and source_id = p_id
         and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
         and id <> all (v_kept)
      returning voucher_no, seq
    )
    select string_agg(voucher_no, ', ' order by seq) into v_removed from removed;
    if v_removed is not null then
      perform recompute_finance_ledger_balances();
    end if;

    -- Post the slices that have no voucher yet.
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

    -- `reversed` stays in the shape for the callers that read it, and is always
    -- null now: nothing is reversed.
    return jsonb_build_object(
      'firstEntryId', v_first,
      'voucherNos',   v_all,
      'reversed',     null,
      'posted',       nullif(array_to_string(v_posted, ', '), ''),
      'edited',       nullif(array_to_string(v_edited, ', '), ''),
      'removed',      v_removed
    );
  end;
  $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;


--
-- Name: accept_production_return(uuid, public.production_return_disposition, text, uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_production_return(p_return_id uuid, p_disposition public.production_return_disposition, p_disposition_note text, p_reviewed_by uuid, p_reviewed_by_name text, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_ret     production_returns%rowtype;
  v_balance numeric;
begin
  -- The `status = 'pending'` predicate is what makes a double review a no-op.
  update production_returns
     set status           = 'accepted',
         disposition      = coalesce(p_disposition, 'saleable'),
         disposition_note = coalesce(nullif(btrim(p_disposition_note), ''), disposition_note),
         reviewed_by      = p_reviewed_by,
         reviewed_by_name = p_reviewed_by_name,
         reviewed_at      = now()
   where id = p_return_id and status = 'pending'
  returning * into v_ret;

  if not found then
    return jsonb_build_object('status', 'conflict');
  end if;

  v_balance := public.apply_return_stock_movement(
    v_ret.product_id, v_ret.product_name, abs(v_ret.qty), 'return_in',
    v_ret.id::text, p_business_date,
    v_ret.branch_id, v_ret.id, p_reviewed_by, p_reviewed_by_name, v_ret.reason, null
  );

  return jsonb_build_object(
    'status', 'ok',
    'branchId', v_ret.branch_id,
    'productId', v_ret.product_id,
    'productName', v_ret.product_name,
    'qty', v_ret.qty,
    'reason', v_ret.reason,
    'source', v_ret.source,
    'returnStockBalance', v_balance
  );
end;
$$;


--
-- Name: activate_due_prices(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_due_prices(p_today date) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_activated integer := 0;
  v_cur_price numeric;
  r           record;
begin
  for r in
    select h.id, h.product_id, h.new_price
      from product_price_history h
     where h.status = 'scheduled'
       and h.effective_date <= p_today
     order by h.product_id
  loop
    -- Lock the product for the same reason apply_price_change does: a manual
    -- change landing mid-job must not interleave with this read-then-write.
    select price into v_cur_price from products where id = r.product_id for update;

    if found then
      update products set price = r.new_price where id = r.product_id;
      update product_price_history
         set status = 'active', activated_on = now(), old_price = v_cur_price
       where id = r.id;
      v_activated := v_activated + 1;
    else
      -- Defensive only: product_id is FK ON DELETE CASCADE, so a missing
      -- product would have taken this history row with it.
      update product_price_history set status = 'superseded' where id = r.id;
    end if;
  end loop;

  return v_activated;
end;
$$;


--
-- Name: amend_cash_transfer_date(uuid, date, text, uuid, text, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.amend_cash_transfer_date(p_transfer_id uuid, p_new_date date, p_reason text, p_actor_id uuid, p_actor_name text, p_today date, p_max_per_day integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_row    cash_transfers%rowtype;
    v_others integer;
    v_closed date;
    v_moved  text;
  begin
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;

    select * into v_row from cash_transfers where id = p_transfer_id and deleted_at is null for update;
    if not found then
      raise exception 'cash transfer not found, or already deleted';
    end if;
    if v_row.status = 'rejected' then
      raise exception
        'cash transfer % was rejected and is final. Nothing was booked for it; the branch records a new transfer instead.',
        v_row.transfer_no;
    end if;
    if p_new_date is null or p_new_date = v_row.business_date then
      raise exception 'cash deposit % is already dated %', v_row.transfer_no, to_char(v_row.business_date, 'DD-Mon-YYYY');
    end if;
    if p_new_date > p_today then
      raise exception 'the date of a cash deposit cannot be in the future';
    end if;

    select count(*) into v_others
      from cash_transfers
     where branch_id = v_row.branch_id and business_date = p_new_date
       and status <> 'rejected' and deleted_at is null and id <> v_row.id;
    if v_others >= p_max_per_day then
      raise exception '% already has % cash deposits on % — the limit is % a day.',
        v_row.branch_name, v_others, to_char(p_new_date, 'DD-Mon-YYYY'), p_max_per_day;
    end if;

    if v_row.status = 'approved' then
      -- A closed day is signed off: nothing leaves it and nothing lands on it.
      select c.business_date into v_closed
        from finance_day_closings c
       where c.business_date = p_new_date
          or c.business_date in (
               select e.entry_date from ledger_entries e
                where e.source_type = 'cash_transfer' and e.source_id = v_row.id
                  and e.status <> 'reversed' and e.reverses_entry_id is null and e.deleted_at is null)
       order by c.business_date limit 1;
      if v_closed is not null then
        raise exception
          'the finance day % is closed, so the receipts of % cannot be moved off it or onto it. Reopen the day first.',
          to_char(v_closed, 'DD-Mon-YYYY'), v_row.transfer_no;
      end if;
    end if;

    update cash_transfers
       set business_date   = p_new_date,
           updated_by      = p_actor_id,
           updated_by_name = p_actor_name
     where id = v_row.id;

    if v_row.status = 'approved' then
      perform set_config('app.allow_ledger_redate', 'on', true);
      with moved as (
        update ledger_entries
           set entry_date = p_new_date
         where source_type = 'cash_transfer' and source_id = v_row.id
           and status <> 'reversed' and reverses_entry_id is null and deleted_at is null
           and entry_date <> p_new_date
        returning voucher_no, seq
      )
      select string_agg(voucher_no, ', ' order by seq) into v_moved from moved;
      perform set_config('app.allow_ledger_redate', 'off', true);
    end if;

    return jsonb_build_object(
      'referenceType', 'cash_transfer', 'referenceNo', v_row.transfer_no, 'field', 'businessDate',
      'originalValue', v_row.business_date::text, 'newValue', p_new_date::text, 'difference', null,
      -- Nothing was reversed or posted: the receipts moved. `redatedVoucherNos`
      -- names them for the note the Support Center writes.
      'ledger', jsonb_build_object('ledgerAmended', false, 'redatedVoucherNos', v_moved));
  end;
  $$;


--
-- Name: amend_daily_sale_record(uuid, text, numeric, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.amend_daily_sale_record(p_id uuid, p_field text, p_amount numeric, p_reason text, p_actor_id uuid, p_actor_name text, p_actor_role text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: amend_finance_record(text, uuid, text, text, text, uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.amend_finance_record(p_reference_type text, p_reference_id uuid, p_field text, p_new_value text, p_reason text, p_actor_id uuid, p_actor_name text, p_entry_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $_$
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
  $_$;


--
-- Name: amend_finance_record_fields(text, uuid, jsonb, text, uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.amend_finance_record_fields(p_reference_type text, p_reference_id uuid, p_edits jsonb, p_reason text, p_actor_id uuid, p_actor_name text, p_entry_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_today       date := coalesce(p_entry_date, (timezone('Asia/Karachi', now()))::date);
    v_is_txn      boolean := p_reference_type = 'finance_transaction';
    v_date_field  text := case when p_reference_type = 'finance_transaction' then 'businessDate' else 'entryDate' end;
    v_le          ledger_entries%rowtype;
    v_tx          finance_transactions%rowtype;
    v_ref         text;
    v_status      text;
    -- the record as it stands
    c_amount      numeric(14,2);
    c_date        date;
    c_head_id     uuid;
    c_head_name   text;
    c_head_type   ledger_head_type;
    c_branch_id   uuid;
    c_branch_name text;
    c_method      text;
    c_account     finance_account;
    c_desc        text;
    -- the record as corrected
    n_amount      numeric(14,2);
    n_date        date;
    n_head_id     uuid;
    n_head_name   text;
    n_branch_id   uuid;
    n_branch_name text;
    n_method      text;
    n_account     finance_account;
    n_desc        text;
    v_head        ledger_heads%rowtype;
    v_edit        jsonb;
    v_field       text;
    v_val         text;
    v_set         jsonb := '{}'::jsonb;
    v_out         jsonb := '[]'::jsonb;
    v_ledger      jsonb := jsonb_build_object('ledgerAmended', false);
    v_seen        text[] := '{}';
  begin
    if p_reference_type not in ('ledger_entry', 'finance_transaction') then
      raise exception 'amend_finance_record_fields does not handle "%"', p_reference_type;
    end if;
    if p_reference_id is null then
      raise exception 'nothing to amend: the query names no finance record';
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'an amendment must carry a reason';
    end if;
    if jsonb_typeof(p_edits) is distinct from 'array' or jsonb_array_length(p_edits) = 0 then
      raise exception 'No changes detected.';
    end if;

    if v_is_txn then
      select * into v_tx from finance_transactions where id = p_reference_id and deleted_at is null for update;
      if not found then raise exception 'transaction not found, or already deleted'; end if;
      v_ref := v_tx.txn_no;            v_status := v_tx.status::text;
      c_amount := v_tx.amount;         c_date := v_tx.business_date;
      c_head_id := v_tx.ledger_head_id; c_head_name := v_tx.ledger_head_name; c_head_type := v_tx.txn_type;
      c_branch_id := v_tx.branch_id;   c_branch_name := v_tx.branch_name;
      c_method := v_tx.payment_method; c_account := v_tx.account; c_desc := v_tx.description;
      if v_status = 'rejected' then
        raise exception 'transaction % was rejected and is final. Nothing was booked for it.', v_ref;
      end if;
    else
      select * into v_le from ledger_entries where id = p_reference_id and deleted_at is null for update;
      if not found then raise exception 'ledger entry not found, or it has already been deleted'; end if;
      v_ref := v_le.voucher_no;        v_status := v_le.status::text;
      c_amount := greatest(v_le.debit, v_le.credit); c_date := v_le.entry_date;
      c_head_id := v_le.ledger_head_id; c_head_name := v_le.ledger_head_name; c_head_type := v_le.ledger_head_type;
      c_branch_id := v_le.branch_id;   c_branch_name := v_le.branch_name;
      c_method := v_le.payment_method; c_account := v_le.account; c_desc := v_le.description;
    end if;

    n_amount := c_amount;       n_date := c_date;
    n_head_id := c_head_id;     n_head_name := c_head_name;
    n_branch_id := c_branch_id; n_branch_name := c_branch_name;
    n_method := c_method;       n_account := c_account;  n_desc := c_desc;

    for v_edit in select value from jsonb_array_elements(p_edits) loop
      v_field := v_edit ->> 'field';
      v_val   := btrim(coalesce(v_edit ->> 'value', ''));
      if v_field = any(v_seen) then
        raise exception 'field "%" appears twice in one correction', v_field;
      end if;
      v_seen := v_seen || v_field;

      if v_field = 'amount' then
        begin
          n_amount := round(v_val::numeric, 2);
        exception when others then
          raise exception '"%" is not a valid amount', v_val;
        end;
        if n_amount <= 0 then
          raise exception 'the amount must be greater than 0. Delete the record instead.';
        end if;
        v_set := v_set || jsonb_build_object('amount', n_amount);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_amount::text, 'newValue', n_amount::text,
          'originalText', c_amount::text, 'newText', n_amount::text, 'difference', n_amount - c_amount));

      elsif v_field = v_date_field then
        begin
          n_date := v_val::date;
        exception when others then
          raise exception '"%" is not a valid date', v_val;
        end;
        if n_date > v_today then
          raise exception 'the date cannot be in the future';
        end if;
        if exists (select 1 from finance_day_closings where business_date = n_date) then
          raise exception 'the finance day % is closed. Choose an open date.', n_date;
        end if;
        v_set := v_set || jsonb_build_object('entryDate', n_date);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_date::text, 'newValue', n_date::text,
          'originalText', to_char(c_date, 'DD-Mon-YYYY'), 'newText', to_char(n_date, 'DD-Mon-YYYY'), 'difference', null));

      elsif v_field = 'ledgerHeadId' then
        begin
          select * into v_head from ledger_heads where id = v_val::uuid;
        exception when others then
          raise exception 'that category does not exist';
        end;
        if v_head.id is null then raise exception 'that category does not exist'; end if;
        if not v_head.is_active then
          raise exception 'category "%" is inactive and cannot accept new entries', v_head.name;
        end if;
        if v_head.type <> c_head_type then
          raise exception
            '% is % and "%" is an % category. Choose another % category, or delete the record and enter it again.',
            v_ref, c_head_type, v_head.name, v_head.type, c_head_type;
        end if;
        n_head_id := v_head.id; n_head_name := v_head.name;
        v_set := v_set || jsonb_build_object('ledgerHeadId', n_head_id);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_head_id::text, ''), 'newValue', n_head_id::text,
          'originalText', c_head_name, 'newText', n_head_name, 'difference', null));

      elsif v_field = 'branchId' then
        if v_val = '' then
          n_branch_id := null; n_branch_name := null;
        else
          begin
            select id, name into n_branch_id, n_branch_name from branches where id = v_val::uuid;
          exception when others then
            raise exception 'that branch does not exist';
          end;
          if n_branch_id is null then raise exception 'that branch does not exist'; end if;
        end if;
        v_set := v_set || jsonb_build_object('branchId', coalesce(n_branch_id::text, ''));
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_branch_id::text, ''), 'newValue', coalesce(n_branch_id::text, ''),
          'originalText', coalesce(c_branch_name, 'Company-wide'), 'newText', coalesce(n_branch_name, 'Company-wide'),
          'difference', null));

      elsif v_field = 'paymentMethod' then
        if v_val = '' and v_is_txn then
          raise exception 'a transaction needs a payment method';
        end if;
        n_method := nullif(v_val, '');
        v_set := v_set || jsonb_build_object('paymentMethod', coalesce(n_method, ''));
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', coalesce(c_method, ''), 'newValue', coalesce(n_method, ''),
          'originalText', coalesce(c_method, ''), 'newText', coalesce(n_method, ''), 'difference', null));

      elsif v_field = 'account' then
        if v_val not in ('cash', 'bank') then
          raise exception 'the account must be cash or bank';
        end if;
        n_account := v_val::finance_account;
        v_set := v_set || jsonb_build_object('account', v_val);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_account::text, 'newValue', v_val,
          'originalText', c_account::text, 'newText', v_val, 'difference', null));

      elsif v_field = 'description' then
        if v_val = '' then
          raise exception 'the description cannot be empty';
        end if;
        n_desc := v_val;
        v_set := v_set || jsonb_build_object('description', n_desc);
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'field', v_field, 'originalValue', c_desc, 'newValue', n_desc,
          'originalText', c_desc, 'newText', n_desc, 'difference', null));

      else
        raise exception 'field "%" cannot be corrected on %', v_field, v_ref;
      end if;
    end loop;

    if v_is_txn then
      update finance_transactions
         set amount           = n_amount,
             business_date    = n_date,
             ledger_head_id   = n_head_id,
             ledger_head_name = n_head_name,
             branch_id        = n_branch_id,
             branch_name      = n_branch_name,
             payment_method   = n_method,
             account          = n_account,
             description      = n_desc
       where id = p_reference_id;

      -- A posted transaction's voucher follows it, in one reversal and one
      -- corrected entry. An unposted one has no voucher yet: it is corrected in
      -- place and posts the corrected values when it is approved.
      if v_status in ('posted', 'locked') and v_tx.ledger_entry_id is not null then
        v_ledger := app.repost_ledger_entry(v_tx.ledger_entry_id, v_set, p_reason, p_actor_id, p_actor_name, v_today);
        update finance_transactions
           set ledger_entry_id = (v_ledger ->> 'correctedEntryId')::uuid
         where id = p_reference_id and (v_ledger ->> 'ledgerAmended')::boolean;
      end if;
    else
      v_ledger := app.repost_ledger_entry(p_reference_id, v_set, p_reason, p_actor_id, p_actor_name, v_today);
    end if;

    return (
      select jsonb_agg(
               e || jsonb_build_object('referenceType', p_reference_type, 'referenceNo', v_ref, 'ledger', v_ledger)
               order by ord)
        from jsonb_array_elements(v_out) with ordinality as t(e, ord)
    );
  end;
  $$;


--
-- Name: apply_price_change(uuid, numeric, date, text, public.price_change_source, uuid, text, uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_price_change(p_product_id uuid, p_new_price numeric, p_effective_date date, p_reason text, p_source public.price_change_source, p_changed_by uuid, p_changed_by_name text, p_batch_id uuid, p_today date) RETURNS TABLE(status text, skip_reason text, history_id uuid, version_number integer, product_name text, old_price numeric, new_price numeric)
    LANGUAGE plpgsql
    AS $$
declare
  v_product      products%rowtype;
  v_immediate    boolean;
  v_next_version integer;
  v_history_id   uuid;
  v_now          timestamptz := now();
begin
  select * into v_product from products where id = p_product_id for update;
  if not found then
    -- Mapped to a 404 by the caller. P0002 = no_data_found.
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  v_immediate := p_effective_date <= p_today;

  -- No-op: an immediate change to the price it already holds.
  if v_immediate and coalesce(v_product.price, 0) = p_new_price then
    return query select
      'skipped'::text, 'unchanged'::text, null::uuid, null::integer,
      v_product.name, v_product.price, p_new_price;
    return;
  end if;

  select coalesce(max(h.version_number), 0) + 1
    into v_next_version
    from product_price_history h
   where h.product_id = p_product_id;

  -- The table MUST be aliased here. This function is `returns table (status ...)`,
  -- which puts `status` in scope as a PL/pgSQL variable, so an unqualified
  -- `status` in the WHERE is ambiguous and Postgres refuses it outright
  -- ("column reference \"status\" is ambiguous"). Qualifying via the alias
  -- resolves it to the column. The SET target stays unqualified — Postgres does
  -- not accept a table-qualified name on the left of SET.
  update product_price_history h
     set status = 'superseded'
   where h.product_id = p_product_id
     and h.status = 'scheduled';

  insert into product_price_history (
    product_id, product_code, product_name, category_name,
    old_price, new_price, effective_date, reason, source, status,
    version_number, changed_by, changed_by_name, changed_on, activated_on, batch_id
  ) values (
    p_product_id, v_product.sku, v_product.name, v_product.category_name,
    v_product.price, p_new_price, p_effective_date, p_reason, p_source,
    (case when v_immediate then 'active' else 'scheduled' end)::price_change_status,
    v_next_version, p_changed_by, p_changed_by_name, v_now,
    (case when v_immediate then v_now else null end), p_batch_id
  )
  returning id into v_history_id;

  -- updated_at is maintained by the products_touch trigger — do not set it here.
  if v_immediate then
    update products set price = p_new_price where id = p_product_id;
  end if;

  return query select
    (case when v_immediate then 'active' else 'scheduled' end)::text,
    null::text, v_history_id, v_next_version,
    v_product.name, v_product.price, p_new_price;
end;
$$;


--
-- Name: apply_production_stock_adjustment(uuid, text, numeric, text, text, date, uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_production_stock_adjustment(p_product_id uuid, p_product_name text, p_delta numeric, p_reason text, p_ref_id text, p_business_date date, p_created_by uuid DEFAULT NULL::uuid, p_created_by_name text DEFAULT NULL::text, p_remarks text DEFAULT NULL::text, p_metadata jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_before   numeric;
  v_after    numeric;
  v_inserted integer;
begin
  if p_delta is null or p_delta = 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'Adjustment quantity must not be zero.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'invalid', 'error', 'A reason is required for every stock adjustment.');
  end if;

  -- Lock the pool row so the before/after pair reported to the audit trail is the
  -- one this movement actually spanned, not a figure a concurrent sale moved
  -- underneath us.
  select balance into v_before from production_stock
   where product_id = p_product_id
   for update;
  if not found then v_before := 0; end if;

  insert into production_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    created_by, created_by_name, reason, remarks, metadata
  )
  values (
    p_product_id, p_product_name, 'adjustment', p_delta, 0, p_ref_id, p_business_date,
    p_created_by, p_created_by_name, btrim(p_reason), p_remarks, p_metadata
  )
  on conflict (ref_id, product_id, type) do nothing;

  -- Same rule as every other movement: no ledger row inserted means no balance
  -- change. GET DIAGNOSTICS rather than FOUND, matching migration 15 — a retry
  -- reusing the ref_id must be a true no-op, not a second adjustment.
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('status', 'duplicate', 'before', v_before, 'after', v_before);
  end if;

  insert into production_stock (product_id, product_name, balance)
  values (p_product_id, p_product_name, p_delta)
  on conflict (product_id) do update
     set balance = production_stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, production_stock.product_name)
  returning balance into v_after;

  update production_stock_history
     set balance_after = v_after
   where ref_id = p_ref_id and product_id = p_product_id and type = 'adjustment';

  return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_after, 'delta', p_delta);
end;
$$;


--
-- Name: apply_production_stock_correction(uuid, text, jsonb, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_production_stock_correction(p_product_id uuid, p_product_name text, p_targets jsonb, p_ticket_id text, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_balance    numeric;          -- live pool balance (locked)
  v_prepared   numeric := 0;     -- live derived figures for p_business_date
  v_approved   numeric := 0;
  v_returned   numeric := 0;
  v_sold       numeric := 0;
  v_adjust     numeric := 0;
  v_d_prepared numeric := 0;     -- signed corrections to apply
  v_d_approved numeric := 0;
  v_d_returned numeric := 0;
  v_d_sold     numeric := 0;
  v_d_adjust   numeric := 0;
  v_implied    numeric;          -- balance after the four figure corrections
  v_final      numeric;
  v_after      numeric;
  v_ref        text;
  v_movements  jsonb := '[]'::jsonb;
  v_target     numeric;
begin
  -- ── Read the live figures under the row lock ────────────────────────────────
  select balance into v_balance from production_stock
   where product_id = p_product_id
   for update;
  if not found then v_balance := 0; end if;

  select coalesce(sum(delta)  filter (where type = 'prepare'),      0),
         coalesce(-sum(delta) filter (where type = 'transfer_out'), 0),
         coalesce(sum(delta)  filter (where type = 'return_in'),    0),
         coalesce(-sum(delta) filter (where type = 'sale'),         0),
         coalesce(sum(delta)  filter (where type = 'adjustment'),   0)
    into v_prepared, v_approved, v_returned, v_sold, v_adjust
    from production_stock_history
   where product_id = p_product_id
     and business_date = p_business_date;

  -- ── Size each correction from its target ───────────────────────────────────
  v_target := nullif(p_targets->>'preparedToday', '')::numeric;
  if v_target is not null then v_d_prepared := v_target - v_prepared; end if;

  v_target := nullif(p_targets->>'approvedQty', '')::numeric;
  if v_target is not null then v_d_approved := v_target - v_approved; end if;

  v_target := nullif(p_targets->>'returned', '')::numeric;
  if v_target is not null then v_d_returned := v_target - v_returned; end if;

  v_target := nullif(p_targets->>'soldToday', '')::numeric;
  if v_target is not null then v_d_sold := v_target - v_sold; end if;

  -- Balance last: it absorbs whatever the four above did not account for.
  -- Prepared and returned add to the pool; approved and sold take from it.
  v_implied := v_balance + v_d_prepared - v_d_approved + v_d_returned - v_d_sold;
  v_target  := nullif(p_targets->>'balance', '')::numeric;
  if v_target is not null then v_d_adjust := v_target - v_implied; end if;

  v_final := v_implied + v_d_adjust;

  if v_d_prepared = 0 and v_d_approved = 0 and v_d_returned = 0
     and v_d_sold = 0 and v_d_adjust = 0 then
    return jsonb_build_object(
      'status', 'ok', 'applied', false, 'refId', null,
      'before', jsonb_build_object(
        'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
        'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
        'totalStock', v_balance + v_approved + v_sold),
      'after', jsonb_build_object(
        'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
        'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
        'totalStock', v_balance + v_approved + v_sold),
      'movements', v_movements
    );
  end if;

  v_ref := p_ticket_id || ':prodstock:' || gen_random_uuid()::text;

  -- ── Append the movements, chaining balance_after through each ──────────────
  -- Each insert mirrors the sign convention the pool already stores in:
  -- prepare / return_in positive, transfer_out / sale negative.
  if v_d_prepared <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_prepared)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_prepared,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'prepare', v_d_prepared, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'prepare', 'delta', v_d_prepared);
  end if;

  if v_d_approved <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, -v_d_approved)
    on conflict (product_id) do update
       set balance = production_stock.balance - v_d_approved,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'transfer_out', -v_d_approved, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'transfer_out', 'delta', -v_d_approved);
  end if;

  if v_d_returned <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_returned)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_returned,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'return_in', v_d_returned, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'return_in', 'delta', v_d_returned);
  end if;

  if v_d_sold <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, -v_d_sold)
    on conflict (product_id) do update
       set balance = production_stock.balance - v_d_sold,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'sale', -v_d_sold, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'sale', 'delta', -v_d_sold);
  end if;

  if v_d_adjust <> 0 then
    insert into production_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, v_d_adjust)
    on conflict (product_id) do update
       set balance = production_stock.balance + v_d_adjust,
           product_name = coalesce(excluded.product_name, production_stock.product_name)
    returning balance into v_after;

    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_product_id, p_product_name, 'adjustment', v_d_adjust, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_adjust);
  end if;

  return jsonb_build_object(
    'status', 'ok', 'applied', true, 'refId', v_ref,
    'before', jsonb_build_object(
      'preparedToday', v_prepared, 'approvedQty', v_approved, 'returned', v_returned,
      'soldToday', v_sold, 'adjustment', v_adjust, 'balance', v_balance,
      'totalStock', v_balance + v_approved + v_sold),
    'after', jsonb_build_object(
      'preparedToday', v_prepared + v_d_prepared,
      'approvedQty',   v_approved + v_d_approved,
      'returned',      v_returned + v_d_returned,
      'soldToday',     v_sold     + v_d_sold,
      'adjustment',    v_adjust   + v_d_adjust,
      'balance',       v_final,
      'totalStock',    v_final + (v_approved + v_d_approved) + (v_sold + v_d_sold)),
    'movements', v_movements
  );
end;
$$;


--
-- Name: apply_production_stock_movement(uuid, text, numeric, public.production_stock_movement_type, text, date, uuid, uuid, text, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_production_stock_movement(p_product_id uuid, p_product_name text, p_delta numeric, p_type public.production_stock_movement_type, p_ref_id text, p_business_date date, p_branch_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid, p_created_by_name text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_production_order_id uuid DEFAULT NULL::uuid, p_remarks text DEFAULT NULL::text) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first; balance_after is backfilled below.
  insert into production_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    branch_id, created_by, created_by_name, reason, production_order_id, remarks
  )
  values (
    p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date,
    p_branch_id, p_created_by, p_created_by_name, p_reason, p_production_order_id, p_remarks
  )
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from production_stock where product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  insert into production_stock (product_id, product_name, balance)
  values (p_product_id, p_product_name, p_delta)
  on conflict (product_id) do update
     set balance = production_stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, production_stock.product_name)
  returning balance into v_balance;

  update production_stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;


--
-- Name: apply_return_stock_movement(uuid, text, numeric, public.return_stock_movement_type, text, date, uuid, uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_return_stock_movement(p_product_id uuid, p_product_name text, p_delta numeric, p_type public.return_stock_movement_type, p_ref_id text, p_business_date date, p_branch_id uuid DEFAULT NULL::uuid, p_production_return_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid, p_created_by_name text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_remarks text DEFAULT NULL::text) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first; balance_after is backfilled below.
  insert into return_stock_history (
    product_id, product_name, type, delta, balance_after, ref_id, business_date,
    branch_id, production_return_id, created_by, created_by_name, reason, remarks
  )
  values (
    p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date,
    p_branch_id, p_production_return_id, p_created_by, p_created_by_name, p_reason, p_remarks
  )
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from return_stock where product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  -- UPDATE first, INSERT only for a product's first movement. The production
  -- function upserts in one statement, but that cannot be copied here: the
  -- non-negative CHECK is evaluated on the row proposed for INSERT before the
  -- conflict is resolved, so a transfer_out (negative delta) would be refused
  -- even when the existing balance covers it.
  update return_stock
     set balance = balance + p_delta,
         product_name = coalesce(p_product_name, product_name)
   where product_id = p_product_id
  returning balance into v_balance;

  if not found then
    insert into return_stock (product_id, product_name, balance)
    values (p_product_id, p_product_name, p_delta)
    on conflict (product_id) do update
       set balance = return_stock.balance + excluded.balance
    returning balance into v_balance;
  end if;

  update return_stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;


--
-- Name: apply_stock_correction(uuid, uuid, text, jsonb, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_stock_correction(p_branch_id uuid, p_product_id uuid, p_product_name text, p_targets jsonb, p_ticket_id text, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_balance    numeric;          -- live balance (locked)
  v_new        numeric := 0;     -- live derived figures for p_business_date
  v_sold       numeric := 0;
  v_returned   numeric := 0;
  v_adjust     numeric := 0;
  v_opening    numeric;
  v_d_new      numeric := 0;     -- signed corrections to apply
  v_d_sold     numeric := 0;
  v_d_returned numeric := 0;
  v_d_adjust   numeric := 0;
  v_d_open     numeric := 0;     -- correction to OPENING (migration 79)
  v_prev_date  date;
  v_closed     boolean := false;
  v_implied    numeric;          -- balance after new/sold/returned corrections
  v_final      numeric;
  v_after      numeric;
  v_ref        text;
  v_ref_open   text;         -- distinct ref for the previous-day row (migration 80)
  v_movements  jsonb := '[]'::jsonb;
  v_target     numeric;
  v_target_adj numeric;          -- the Adjustment target (migration 78)
begin
  -- ── Read the live figures under the row lock ────────────────────────────────
  select balance into v_balance from stock
   where branch_id = p_branch_id and product_id = p_product_id
   for update;
  if not found then v_balance := 0; end if;

  select coalesce(sum(delta) filter (where type = 'production'),  0),
         coalesce(-sum(delta) filter (where type = 'sale'),       0),
         coalesce(-sum(delta) filter (where type = 'return'),     0),
         coalesce(sum(delta) filter (where type = 'adjustment'),  0)
    into v_new, v_sold, v_returned, v_adjust
    from stock_history
   where branch_id = p_branch_id
     and product_id = p_product_id
     and business_date = p_business_date;

  -- Same definition computeStockRows uses, so the admin sees what the branch sees.
  v_opening := v_balance - (v_new - v_sold - v_returned + v_adjust);

  -- ── Size each correction from its target ───────────────────────────────────
  v_target := nullif(p_targets->>'newQty', '')::numeric;
  if v_target is not null then v_d_new := v_target - v_new; end if;

  v_target := nullif(p_targets->>'sold', '')::numeric;
  if v_target is not null then v_d_sold := v_target - v_sold; end if;

  v_target := nullif(p_targets->>'returned', '')::numeric;
  if v_target is not null then v_d_returned := v_target - v_returned; end if;

  -- Opening: the only target whose movement is dated to a DIFFERENT day. See the
  -- header — a movement on p_business_date cannot shift opening at all.
  v_prev_date := p_business_date - 1;
  v_target    := nullif(p_targets->>'opening', '')::numeric;
  if v_target is not null and v_target <> v_opening then
    select exists (
             select 1 from business_day_closures
              where business_date = v_prev_date
           )
      into v_closed;
    if v_closed then
      return jsonb_build_object('status', 'day_closed', 'businessDate', v_prev_date);
    end if;
    v_d_open := v_target - v_opening;
  end if;

  -- Balance last: it absorbs whatever the others did not account for. The opening
  -- correction is already inside v_implied, so a balance target is measured
  -- against the SHIFTED baseline — "the day started here and ended there".
  v_implied    := v_balance + v_d_open + v_d_new - v_d_sold - v_d_returned;
  v_target     := nullif(p_targets->>'balance', '')::numeric;
  v_target_adj := nullif(p_targets->>'adjustment', '')::numeric;

  -- One degree of freedom, two names for it. Refuse rather than pick. (Opening is
  -- NOT part of this pair — it is a different day's figure.)
  if v_target is not null and v_target_adj is not null then
    return jsonb_build_object('status', 'overdetermined');
  end if;

  if v_target is not null then
    v_d_adjust := v_target - v_implied;
  elsif v_target_adj is not null then
    v_d_adjust := v_target_adj - v_adjust;
  end if;

  v_final := v_implied + v_d_adjust;

  -- ── Validate before ANY write ──────────────────────────────────────────────
  if v_final < 0 then
    return jsonb_build_object('status', 'negative_balance', 'balance', v_final);
  end if;

  if v_d_new = 0 and v_d_sold = 0 and v_d_returned = 0 and v_d_adjust = 0 and v_d_open = 0 then
    return jsonb_build_object(
      'status', 'ok', 'applied', false, 'refId', null,
      'before', jsonb_build_object(
        'opening', v_opening, 'newQty', v_new, 'sold', v_sold,
        'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
      'after', jsonb_build_object(
        'opening', v_opening, 'newQty', v_new, 'sold', v_sold,
        'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
      'movements', v_movements
    );
  end if;

  v_ref := p_ticket_id || ':stock:' || gen_random_uuid()::text;
  -- Same correction, its own idempotency key. The unique index is
  -- (ref_id, product_id, type) and does NOT include business_date, so the
  -- previous-day 'adjustment' row and today's 'adjustment' row would collide
  -- under one ref. Suffixed rather than randomised so it still reads as part of
  -- the same correction.
  v_ref_open := v_ref || ':open';

  -- ── The opening correction, dated to the PREVIOUS business day ─────────────
  -- First, so the balance it establishes is the one the day's movements below
  -- chain their balance_after from.
  if v_d_open <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_open)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_open,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'adjustment', v_d_open, v_after, v_ref_open, v_prev_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_open, 'businessDate', v_prev_date, 'refId', v_ref_open);
  end if;

  -- ── Append the day's movements, chaining balance_after through each ────────
  -- Sold and returned are stored NEGATIVE (migration 04); a target that lowers
  -- them therefore appends a positive delta, giving units back.
  if v_d_new <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_new)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_new,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'production', v_d_new, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'production', 'delta', v_d_new);
  end if;

  if v_d_sold <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, -v_d_sold)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance - v_d_sold,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'sale', -v_d_sold, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'sale', 'delta', -v_d_sold);
  end if;

  if v_d_returned <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, -v_d_returned)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance - v_d_returned,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'return', -v_d_returned, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'return', 'delta', -v_d_returned);
  end if;

  if v_d_adjust <> 0 then
    insert into stock (branch_id, product_id, product_name, balance)
    values (p_branch_id, p_product_id, p_product_name, v_d_adjust)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_d_adjust,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, p_product_id, p_product_name, 'adjustment', v_d_adjust, v_after, v_ref, p_business_date);

    v_movements := v_movements || jsonb_build_object('type', 'adjustment', 'delta', v_d_adjust);
  end if;

  return jsonb_build_object(
    'status', 'ok', 'applied', true, 'refId', v_ref,
    'before', jsonb_build_object(
      'opening',  v_opening, 'newQty', v_new, 'sold', v_sold,
      'returned', v_returned, 'adjustment', v_adjust, 'balance', v_balance),
    'after', jsonb_build_object(
      -- opening now moves too, by exactly the previous-day correction.
      'opening',  v_opening  + v_d_open,
      'newQty',   v_new      + v_d_new,
      'sold',     v_sold     + v_d_sold,
      'returned', v_returned + v_d_returned,
      'adjustment', v_adjust + v_d_adjust,
      'balance',  v_final),
    'movements', v_movements
  );
end;
$$;


--
-- Name: apply_stock_movement(uuid, uuid, text, numeric, public.stock_movement_type, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_stock_movement(p_branch_id uuid, p_product_id uuid, p_product_name text, p_delta numeric, p_type public.stock_movement_type, p_ref_id text, p_business_date date) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first. balance_after is backfilled below once
  -- the real post-write balance is known.
  insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
  values (p_branch_id, p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date)
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from stock
     where branch_id = p_branch_id and product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  insert into stock (branch_id, product_id, product_name, balance)
  values (p_branch_id, p_product_id, p_product_name, p_delta)
  on conflict (branch_id, product_id) do update
     set balance = stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, stock.product_name)
  returning balance into v_balance;

  update stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cash_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transfer_no text DEFAULT app.next_finance_number('cash_transfer'::text, 'CT'::text) NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_method text,
    note text,
    business_date date NOT NULL,
    status public.cash_transfer_status DEFAULT 'pending'::public.cash_transfer_status NOT NULL,
    created_by uuid,
    created_by_name text,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    approval_note text,
    rejection_reason text,
    ledger_entry_id uuid,
    voucher_no text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    cash_amount numeric(14,2) DEFAULT 0 NOT NULL,
    easypaisa_amount numeric(14,2) DEFAULT 0 NOT NULL,
    bank_amount numeric(14,2) DEFAULT 0 NOT NULL,
    fuel_charges numeric(14,2) DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_by_name text,
    CONSTRAINT cash_transfers_channels_nonnegative CHECK (((cash_amount >= (0)::numeric) AND (easypaisa_amount >= (0)::numeric) AND (bank_amount >= (0)::numeric) AND (fuel_charges >= (0)::numeric))),
    CONSTRAINT cash_transfers_decision_check CHECK ((((status = 'pending'::public.cash_transfer_status) AND (ledger_entry_id IS NULL) AND (approved_at IS NULL)) OR ((status = 'approved'::public.cash_transfer_status) AND (ledger_entry_id IS NOT NULL) AND (approved_at IS NOT NULL)) OR ((status = 'rejected'::public.cash_transfer_status) AND (ledger_entry_id IS NULL) AND (approved_at IS NOT NULL) AND (rejection_reason IS NOT NULL)))),
    CONSTRAINT cash_transfers_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'easypaisa'::text, 'bank_account'::text]))),
    CONSTRAINT cash_transfers_not_empty CHECK (((amount + fuel_charges) > (0)::numeric)),
    CONSTRAINT cash_transfers_total_is_channels CHECK ((amount = ((cash_amount + easypaisa_amount) + bank_amount)))
);


--
-- Name: TABLE cash_transfers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cash_transfers IS 'Cash / Easypaisa / bank money a branch handed to the company, with a photo of the slip. Finance approval posts one RV- receipt under INC-BRANCH-CASH in the same transaction (approve_cash_transfer). Never adds to or subtracts from any other record.';


--
-- Name: COLUMN cash_transfers.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_transfers.amount IS 'Total Amount = cash_amount + easypaisa_amount + bank_amount (CHECK). Excludes fuel_charges.';


--
-- Name: COLUMN cash_transfers.payment_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_transfers.payment_method IS 'Legacy (pre-121): the single method a deposit was raised with. Backfilled into the channel columns; null on new rows.';


--
-- Name: COLUMN cash_transfers.fuel_charges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cash_transfers.fuel_charges IS 'Delivery charges handed over with the deposit. Booked as income under INC-FUEL, never part of amount.';


--
-- Name: approve_cash_transfer(uuid, uuid, text, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_today date, p_note text DEFAULT NULL::text) RETURNS public.cash_transfers
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION approve_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_today date, p_note text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.approve_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_today date, p_note text) IS 'Atomically approve a pending cash transfer: posts one RV- receipt under INC-BRANCH-CASH via post_finance_ledger_entry and links it. P0001 if already decided or the finance day is closed; P0002 if missing.';


--
-- Name: approve_special_order(uuid, uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_special_order(p_order_id uuid, p_by uuid, p_by_name text, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_ref         text;
  v_note        text;
  v_move_id     uuid;
  v_txn         text;
  v_meta        jsonb;
  v_moves       jsonb := '[]'::jsonb;
  r             record;
begin
  update special_orders
     set status = 'approved', approved_by = p_by, approved_by_name = p_by_name,
         approved_at = now(), stock_added_at = now()
   where id = p_order_id and status = 'verified'
  returning branch_id, branch_name, order_number into v_branch, v_branch_name, v_number;

  if not found then
    select status into v_status from special_orders where id = p_order_id;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  v_note := 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '');

  -- product_id order: migration 04's lock-ordering invariant for pool rows.
  for r in
    select id, product_id, item_name, qty, line_no
      from special_order_items
     where special_order_id = p_order_id
     order by product_id, line_no
  loop
    v_ref  := v_number || '/' || r.line_no;
    v_meta := jsonb_build_object(
      'source',             'special_order',
      'specialOrderId',     p_order_id,
      'specialOrderNumber', v_number,
      'specialOrderItemId', r.id);

    -- 1. Made: into Production Stock.
    perform public.apply_production_stock_movement(
      p_product_id      => r.product_id,
      p_product_name    => r.item_name,
      p_delta           => r.qty,
      p_type            => 'prepare',
      p_ref_id          => v_ref,
      p_business_date   => p_business_date,
      p_branch_id       => v_branch,
      p_created_by      => p_by,
      p_created_by_name => p_by_name,
      p_reason          => 'Special Order ' || v_number,
      p_remarks         => v_note
    );

    -- 2. Delivered: out of Production Stock, to the branch that ordered it.
    perform public.apply_production_stock_movement(
      p_product_id      => r.product_id,
      p_product_name    => r.item_name,
      p_delta           => -r.qty,
      p_type            => 'transfer_out',
      p_ref_id          => v_ref,
      p_business_date   => p_business_date,
      p_branch_id       => v_branch,
      p_created_by      => p_by,
      p_created_by_name => p_by_name,
      p_reason          => 'Special Order ' || v_number,
      p_remarks         => v_note
    );

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta
     where ref_id = v_ref and product_id = r.product_id and type in ('prepare', 'transfer_out');

    -- The 'prepare' row is the one the item points at: it is the stock ADDITION.
    select id, transaction_no into v_move_id, v_txn
      from production_stock_history
     where ref_id = v_ref and product_id = r.product_id and type = 'prepare';

    -- 3. Received: into the ordering branch's stock.
    perform public.apply_stock_movement(
      p_branch_id     => v_branch,
      p_product_id    => r.product_id,
      p_product_name  => r.item_name,
      p_delta         => r.qty,
      p_type          => 'production',
      p_ref_id        => v_ref,
      p_business_date => p_business_date
    );

    update special_order_items
       set stock_movement_id = v_move_id, stock_transaction_no = v_txn
     where id = r.id;

    v_moves := v_moves || jsonb_build_object(
      'itemId', r.id, 'productId', r.product_id, 'itemName', r.item_name,
      'qty', r.qty, 'stockMovementId', v_move_id, 'stockTransactionNo', v_txn);
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch, 'orderNumber', v_number, 'movements', v_moves);
end;
$$;


--
-- Name: backup_database_info(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backup_database_info() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    select jsonb_build_object(
      'server_version', current_setting('server_version'),
      'database_name',  current_database(),
      'size_bytes',     pg_database_size(current_database()),
      'public_table_count', (
        select count(*) from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
      )
    );
  $$;


--
-- Name: FUNCTION backup_database_info(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.backup_database_info() IS 'Server version, database name, size and public table count for backup manifests and the Database Backup screen. Service role only.';


--
-- Name: claim_backup_job(text, text, text, uuid, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_backup_job(p_backup_id text, p_backup_type text, p_trigger text, p_triggered_by uuid, p_triggered_by_name text, p_s3_bucket text, p_environment text, p_stale_ms integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare
    existing public.backup_jobs%rowtype;
    running  public.backup_jobs%rowtype;
  begin
    perform pg_advisory_xact_lock(hashtext('backup_jobs:' || p_backup_type));

    select * into existing
      from public.backup_jobs
      where backup_id = p_backup_id
      for update;

    if found and existing.status in ('success', 'verified') then
      return 'already_completed';
    end if;

    select * into running
      from public.backup_jobs
      where backup_type = p_backup_type
        and status = 'running'
      for update;

    if found then
      if running.started_at > now() - make_interval(secs => p_stale_ms / 1000.0) then
        return 'in_progress';
      end if;
      update public.backup_jobs
         set status         = 'stale',
             error_category = 'stale',
             error_message  = 'superseded by a newer claim after exceeding the stale window',
             completed_at   = now()
       where id = running.id;
    end if;

    insert into public.backup_jobs (
      backup_id, backup_type, status, trigger, triggered_by, triggered_by_name,
      s3_bucket, environment, started_at, attempts
    ) values (
      p_backup_id, p_backup_type, 'running', p_trigger, p_triggered_by, p_triggered_by_name,
      p_s3_bucket, p_environment, now(), 1
    )
    on conflict (backup_id) do update set
      status               = 'running',
      trigger              = excluded.trigger,
      triggered_by         = excluded.triggered_by,
      triggered_by_name    = excluded.triggered_by_name,
      s3_bucket            = excluded.s3_bucket,
      environment          = excluded.environment,
      started_at           = now(),
      completed_at         = null,
      duration_ms          = null,
      dump_ms              = null,
      upload_ms            = null,
      error_category       = null,
      error_message        = null,
      attempts             = public.backup_jobs.attempts + 1;

    return 'claimed';
  end;
  $$;


--
-- Name: FUNCTION claim_backup_job(p_backup_id text, p_backup_type text, p_trigger text, p_triggered_by uuid, p_triggered_by_name text, p_s3_bucket text, p_environment text, p_stale_ms integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_backup_job(p_backup_id text, p_backup_type text, p_trigger text, p_triggered_by uuid, p_triggered_by_name text, p_s3_bucket text, p_environment text, p_stale_ms integer) IS 'Atomically claims the per-type backup lock. Returns claimed | already_completed | in_progress. Service role only.';


--
-- Name: claim_business_day_closure(date, public.closure_trigger, text, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_business_day_closure(p_business_date date, p_trigger public.closure_trigger, p_closed_by text, p_auto_stock_closing boolean, p_stale_ms integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare
    existing business_day_closures%rowtype;
  begin
    -- Serialise concurrent claims for this date (a manual run overlapping the
    -- scheduler tick). FOR UPDATE on the existing row; the ON CONFLICT below
    -- covers the first-ever claim where no row exists yet.
    select * into existing
      from business_day_closures
      where business_date = p_business_date
      for update;

    if found then
      if existing.status = 'success' then
        return 'already_closed';
      end if;
      if existing.status = 'running'
         and existing.started_at > now() - make_interval(secs => p_stale_ms / 1000.0) then
        return 'in_progress';
      end if;
    end if;

    insert into business_day_closures (
      business_date, status, trigger, closed_by, auto_stock_closing, started_at
    ) values (
      p_business_date, 'running', p_trigger, p_closed_by, p_auto_stock_closing, now()
    )
    on conflict (business_date) do update set
      status                     = 'running',
      trigger                    = excluded.trigger,
      closed_by                  = excluded.closed_by,
      auto_stock_closing         = excluded.auto_stock_closing,
      started_at                 = now(),
      sales_summary              = null,
      expense_summary            = null,
      production_expense_summary = null,
      production_summary         = null,
      stock_snapshot             = null,
      error                      = null,
      closed_at                  = null,
      duration_ms                = null;

    return 'claimed';
  end;
  $$;


--
-- Name: claim_idempotency_key(uuid, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_idempotency_key(p_user_id uuid, p_key text, p_endpoint text, p_fingerprint text, p_stale_seconds integer DEFAULT 300) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  r record;
begin
  insert into idempotency_keys (user_id, key, endpoint, fingerprint)
  values (p_user_id, p_key, p_endpoint, p_fingerprint)
  on conflict (user_id, key) do nothing;

  -- FOUND is true only when the insert actually wrote a row, which is precisely
  -- "this caller owns the claim".
  if found then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  select * into r from idempotency_keys where user_id = p_user_id and key = p_key;
  if not found then
    -- The row was purged between the insert and the read. Vanishingly rare, and
    -- reported rather than guessed at: the caller retries and claims cleanly.
    return jsonb_build_object('outcome', 'in_progress', 'stale', false);
  end if;

  if r.endpoint is distinct from p_endpoint or r.fingerprint is distinct from p_fingerprint then
    return jsonb_build_object('outcome', 'mismatch');
  end if;

  if r.status = 'completed' then
    return jsonb_build_object(
      'outcome',        'replay',
      'responseStatus', r.response_status,
      'responseBody',   r.response_body
    );
  end if;

  return jsonb_build_object(
    'outcome', 'in_progress',
    'stale',   r.created_at < now() - make_interval(secs => p_stale_seconds)
  );
end;
$$;


--
-- Name: FUNCTION claim_idempotency_key(p_user_id uuid, p_key text, p_endpoint text, p_fingerprint text, p_stale_seconds integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_idempotency_key(p_user_id uuid, p_key text, p_endpoint text, p_fingerprint text, p_stale_seconds integer) IS 'Claim an Idempotency-Key or describe the earlier request that holds it: claimed | replay (with the stored response) | in_progress (with staleness) | mismatch (same key, different body).';


--
-- Name: claim_price_activation(date, public.closure_trigger); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_price_activation(p_date date, p_trigger public.closure_trigger) RETURNS boolean
    LANGUAGE sql
    AS $$
  insert into price_activation_locks (business_date, status, trigger, started_at, activated, closed_at, error)
  values (p_date, 'running', p_trigger, now(), 0, null, null)
  on conflict (business_date) do update
     set status     = 'running',
         trigger    = p_trigger,
         started_at = now(),
         activated  = 0,
         closed_at  = null,
         error      = null
   where price_activation_locks.status <> 'success'
     and (price_activation_locks.status <> 'running'
          or price_activation_locks.started_at < now() - interval '10 minutes')
  returning true;
$$;


--
-- Name: close_price_activation(date, public.closure_status, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_price_activation(p_date date, p_status public.closure_status, p_activated integer, p_error text) RETURNS void
    LANGUAGE sql
    AS $$
  update price_activation_locks
     set status    = p_status,
         activated = p_activated,
         closed_at = now(),
         error     = p_error
   where business_date = p_date;
$$;


--
-- Name: commit_branch_return(uuid, uuid, text, numeric, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_branch_return(p_branch_id uuid, p_product_id uuid, p_product_name text, p_qty numeric, p_ref_id text, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_before   numeric := 0;
  v_after    numeric;
  v_inserted integer;
begin
  select balance into v_before from stock
   where branch_id = p_branch_id and product_id = p_product_id
   for update;
  if not found then v_before := 0; end if;

  -- Idempotency: if this return was already applied, report the current balance
  -- unchanged rather than decrementing twice.
  if exists (
    select 1 from stock_history
     where ref_id = p_ref_id and product_id = p_product_id and type = 'return'
  ) then
    return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_before);
  end if;

  if p_qty > v_before then
    return jsonb_build_object('status', 'insufficient', 'requested', p_qty, 'available', v_before);
  end if;

  insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
  values (p_branch_id, p_product_id, p_product_name, 'return', -p_qty, 0, p_ref_id, p_business_date)
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    -- Lost a race with a concurrent identical return; treat as already applied.
    return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_before);
  end if;

  insert into stock (branch_id, product_id, product_name, balance)
  values (p_branch_id, p_product_id, p_product_name, -p_qty)
  on conflict (branch_id, product_id) do update
     set balance = stock.balance - p_qty,
         product_name = coalesce(excluded.product_name, stock.product_name)
  returning balance into v_after;

  update stock_history
     set balance_after = v_after
   where ref_id = p_ref_id and product_id = p_product_id and type = 'return';

  return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_after);
end;
$$;


--
-- Name: commit_production_sale(jsonb, jsonb, uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_production_sale(p_order jsonb, p_items jsonb, p_branch_id uuid, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_order_id    uuid;
  v_before      numeric;
  v_after       numeric;
  v_befores     jsonb := '{}'::jsonb;
  v_shortfalls  jsonb := '[]'::jsonb;
  v_balances    jsonb := '{}'::jsonb;
  v_inserted    integer;
  r             record;
begin
  -- ── Pass 1: lock every pool row in product_id order, then validate ─────────
  -- The lock is taken on production_stock (product_id is its primary key, and
  -- migration 04's invariant 2 orders it to avoid deadlock). Taking it BEFORE
  -- reading is what makes the check safe: a concurrent sale cannot move the
  -- balance between this read and Pass 2's write.
  --
  -- Outstanding demand is read under the same lock. It can still move — a branch
  -- can submit a demand while this transaction runs — but that direction is safe:
  -- a new reservation appearing after the check does not un-sell goods that have
  -- already left the counter, and the branch sees the shortfall on its own screen.
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    select balance into v_before from production_stock
     where product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    v_before := v_before - public.production_outstanding_demand(r.product_id, null);

    v_befores := v_befores || jsonb_build_object(r.product_id::text, v_before);

    if r.qty > v_before then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.qty,
        'available',   v_before
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Writes ────────────────────────────────────────────────────────────────
  insert into orders (
    order_number, branch_id, branch_name, customer_id, customer_name,
    customer_phone, customer_address, subtotal, discount_total, delivery_charges,
    tax_rate, tax_amount, grand_total, payment_method, status, notes,
    received_cash, cash_returned, created_by, created_by_name, business_date
  )
  select
    p_order->>'orderNumber',
    p_branch_id,
    p_order->>'branchName',
    nullif(p_order->>'customerId', '')::uuid,
    p_order->>'customerName',
    p_order->>'customerPhone',
    p_order->>'customerAddress',
    (p_order->>'subtotal')::numeric,
    coalesce((p_order->>'discountTotal')::numeric, 0),
    coalesce((p_order->>'deliveryCharges')::numeric, 0),
    coalesce((p_order->>'taxRate')::numeric, 0),
    coalesce((p_order->>'taxAmount')::numeric, 0),
    (p_order->>'grandTotal')::numeric,
    (p_order->>'paymentMethod')::payment_method,
    coalesce((p_order->>'status')::order_status, 'pending'),
    p_order->>'notes',
    nullif(p_order->>'receivedCash', '')::numeric,
    nullif(p_order->>'cashReturned', '')::numeric,
    nullif(p_order->>'createdBy', '')::uuid,
    p_order->>'createdByName',
    p_business_date
  returning id into v_order_id;

  -- Line items keep their original rows (duplicates included) and ordering.
  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    v_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'lineTotal')::numeric,
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Pass 2: apply the aggregated pool movements ────────────────────────────
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (r.product_id, r.product_name, 'sale', -r.qty, 0, v_order_id::text, p_business_date)
    on conflict (ref_id, product_id, type) do nothing;

    get diagnostics v_inserted = row_count;

    -- v_order_id is freshly generated, so a conflict here is not reachable in
    -- practice. The guard is kept so this path obeys the same rule as every
    -- other movement: no ledger row inserted means no balance change.
    if v_inserted > 0 then
      insert into production_stock (product_id, product_name, balance)
      values (r.product_id, r.product_name, -r.qty)
      on conflict (product_id) do update
         set balance = production_stock.balance - r.qty,
             product_name = coalesce(excluded.product_name, production_stock.product_name)
      returning balance into v_after;

      update production_stock_history
         set balance_after = v_after
       where ref_id = v_order_id::text and product_id = r.product_id and type = 'sale';

      -- before/after are AVAILABLE, matching what the till was shown. v_after
      -- above is the raw ledger balance and is used only for balance_after.
      v_balances := v_balances || jsonb_build_object(
        r.product_id::text,
        jsonb_build_object(
          'productName', r.product_name,
          'before',      (v_befores->>r.product_id::text)::numeric,
          'after',       (v_befores->>r.product_id::text)::numeric - r.qty
        )
      );
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'orderId', v_order_id, 'balances', v_balances);
end;
$$;


--
-- Name: commit_sale(jsonb, jsonb, uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_sale(p_order jsonb, p_items jsonb, p_branch_id uuid, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_order_id    uuid;
  v_before      numeric;
  v_after       numeric;
  v_befores     jsonb := '{}'::jsonb;
  v_shortfalls  jsonb := '[]'::jsonb;
  v_balances    jsonb := '{}'::jsonb;
  v_inserted    integer;
  r             record;
begin
  -- ── Pass 1: lock every product row in product_id order, then validate ──────
  -- The ORDER BY is the deadlock guard (migration 04, invariant 2). Locks taken
  -- here are held for the rest of this function's transaction.
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    select balance into v_before from stock
     where branch_id = p_branch_id and product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    v_befores := v_befores || jsonb_build_object(r.product_id::text, v_before);

    if r.qty > v_before then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.qty,
        'available',   v_before
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Writes ────────────────────────────────────────────────────────────────
  insert into orders (
    order_number, branch_id, branch_name, customer_id, customer_name,
    customer_phone, customer_address, subtotal, discount_total, delivery_charges,
    tax_rate, tax_amount, grand_total, payment_method, status, notes,
    received_cash, cash_returned, created_by, created_by_name, business_date
  )
  select
    p_order->>'orderNumber',
    p_branch_id,
    p_order->>'branchName',
    nullif(p_order->>'customerId', '')::uuid,
    p_order->>'customerName',
    p_order->>'customerPhone',
    p_order->>'customerAddress',
    (p_order->>'subtotal')::numeric,
    coalesce((p_order->>'discountTotal')::numeric, 0),
    coalesce((p_order->>'deliveryCharges')::numeric, 0),
    coalesce((p_order->>'taxRate')::numeric, 0),
    coalesce((p_order->>'taxAmount')::numeric, 0),
    (p_order->>'grandTotal')::numeric,
    (p_order->>'paymentMethod')::payment_method,
    coalesce((p_order->>'status')::order_status, 'pending'),
    p_order->>'notes',
    nullif(p_order->>'receivedCash', '')::numeric,
    nullif(p_order->>'cashReturned', '')::numeric,
    nullif(p_order->>'createdBy', '')::uuid,
    p_order->>'createdByName',
    p_business_date
  returning id into v_order_id;

  -- Line items keep their original rows (duplicates included) and ordering.
  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    v_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'lineTotal')::numeric,
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Pass 2: apply the aggregated stock movements ──────────────────────────
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, r.product_id, r.product_name, 'sale', -r.qty, 0, v_order_id::text, p_business_date)
    on conflict (ref_id, product_id, type) do nothing;

    get diagnostics v_inserted = row_count;

    -- v_order_id is freshly generated, so a conflict here is not reachable in
    -- practice. The guard is kept so this path obeys the same rule as every
    -- other movement: no ledger row inserted means no balance change.
    if v_inserted > 0 then
      insert into stock (branch_id, product_id, product_name, balance)
      values (p_branch_id, r.product_id, r.product_name, -r.qty)
      on conflict (branch_id, product_id) do update
         set balance = stock.balance - r.qty,
             product_name = coalesce(excluded.product_name, stock.product_name)
      returning balance into v_after;

      update stock_history
         set balance_after = v_after
       where ref_id = v_order_id::text and product_id = r.product_id and type = 'sale';

      v_balances := v_balances || jsonb_build_object(
        r.product_id::text,
        jsonb_build_object(
          'productName', r.product_name,
          'before',      (v_befores->>r.product_id::text)::numeric,
          'after',       v_after
        )
      );
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'orderId', v_order_id, 'balances', v_balances);
end;
$$;


--
-- Name: complete_idempotency_key(uuid, text, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_idempotency_key(p_user_id uuid, p_key text, p_status integer, p_body jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  update idempotency_keys
     set status          = 'completed',
         response_status = p_status,
         response_body   = p_body,
         completed_at    = now()
   where user_id = p_user_id
     and key     = p_key;
end;
$$;


--
-- Name: correct_finance_record_for_query(uuid, integer, jsonb, text, text, boolean, text, jsonb, uuid, text, text, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correct_finance_record_for_query(p_ticket_id uuid, p_expected_version integer, p_edits jsonb, p_reason text, p_action text, p_resolve boolean, p_admin_response text, p_labels jsonb, p_actor_id uuid, p_actor_name text, p_actor_role text, p_ip_address text, p_entry_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $_$
  declare
    v_ticket   finance_tickets%rowtype;
    v_after    finance_tickets%rowtype;
    v_edit     jsonb;
    v_result   jsonb;
    v_results  jsonb := '[]'::jsonb;
    v_idx      integer := 0;
    v_field    text;
    v_label    text;
    v_money    boolean;
    v_old      text;
    v_new      text;
    v_old_text text;
    v_new_text text;
    v_expected text;
    v_ref_no   text;
    v_applied  jsonb := '[]'::jsonb;
    v_changes  jsonb := '[]'::jsonb;
    v_response text := nullif(btrim(coalesce(p_admin_response, '')), '');
    v_next     integer;
  begin
    select * into v_ticket from finance_tickets where id = p_ticket_id for update;
    if not found then
      raise exception 'Query not found.' using errcode = 'MBNFD';
    end if;
    if v_ticket.deleted_at is not null then
      raise exception 'Query % has been deleted. Restore it before correcting its record.', v_ticket.query_no;
    end if;
    if v_ticket.status = 'draft' then
      raise exception 'Query % is still a draft.', v_ticket.query_no;
    end if;
    if v_ticket.version <> p_expected_version then
      raise exception 'Query % was changed by another user while you were working on it. Reload it and try again.',
        v_ticket.query_no using errcode = 'MBCON';
    end if;
    if v_ticket.reference_type is null or v_ticket.reference_id is null then
      raise exception 'Query % names no finance record, so there is nothing to correct.', v_ticket.query_no;
    end if;
    if p_resolve and v_ticket.status not in ('open', 'under_review', 'waiting_for_finance', 'amended', 'reopened') then
      raise exception 'Query % is already %, so it cannot be resolved again. Apply the correction without resolving.',
        v_ticket.query_no, replace(v_ticket.status, '_', ' ');
    end if;
    if p_action not in ('amend', 'overwrite') then
      raise exception 'unknown correction action "%"', p_action;
    end if;
    if jsonb_typeof(p_edits) is distinct from 'array' or jsonb_array_length(p_edits) = 0 then
      raise exception 'No changes detected.';
    end if;
    if p_resolve and v_response is null and length(btrim(coalesce(v_ticket.admin_response, ''))) = 0 then
      raise exception 'Resolving % needs a response saying what was done.', v_ticket.query_no;
    end if;

    -- The writes. One result per edit, in the order the edits were given.
    if v_ticket.reference_type in ('ledger_entry', 'finance_transaction') then
      v_results := amend_finance_record_fields(
        v_ticket.reference_type, v_ticket.reference_id, p_edits,
        p_reason, p_actor_id, p_actor_name, p_entry_date);
    else
      for v_edit in select value from jsonb_array_elements(p_edits) loop
        v_results := v_results || jsonb_build_array(amend_finance_record(
          v_ticket.reference_type, v_ticket.reference_id, v_edit ->> 'field', v_edit ->> 'value',
          p_reason, p_actor_id, p_actor_name, p_entry_date));
      end loop;
    end if;

    for v_edit in select value from jsonb_array_elements(p_edits) loop
      v_result   := v_results -> v_idx;
      v_idx      := v_idx + 1;
      v_field    := v_edit ->> 'field';
      v_money    := coalesce((v_edit ->> 'money')::boolean, false);
      v_label    := coalesce(nullif(v_edit ->> 'label', ''), v_field);
      v_expected := v_edit ->> 'expected';

      v_old      := v_result ->> 'originalValue';
      v_new      := v_result ->> 'newValue';
      -- What a person reads: a category or a branch by name, not by id.
      v_old_text := coalesce(v_result ->> 'originalText', v_old);
      v_new_text := coalesce(v_result ->> 'newText', v_new);
      v_ref_no   := coalesce(v_result ->> 'referenceNo', v_ticket.reference_no);

      -- The optimistic check: `v_old` was read from the row inside this
      -- transaction, under its lock, so it is the value the change replaced.
      if v_money then
        if round(coalesce(nullif(btrim(v_old), '')::numeric, 0), 2)
           <> round(coalesce(nullif(btrim(v_expected), '')::numeric, 0), 2) then
          raise exception
            'This record was changed by another user (% is now %). Please reload the latest version before applying your correction.',
            v_label, coalesce(v_old, '—') using errcode = 'MBCON';
        end if;
      elsif btrim(coalesce(v_old, '')) <> btrim(coalesce(v_expected, '')) then
        raise exception
          'This record was changed by another user (% changed). Please reload the latest version before applying your correction.',
          v_label using errcode = 'MBCON';
      end if;

      insert into finance_amendments (
        ticket_id, query_no, reference_type, reference_id, reference_no, action, field,
        original_value, new_value, difference, reason, admin_id, admin_name, ip_address
      ) values (
        v_ticket.id, v_ticket.query_no, v_ticket.reference_type, v_ticket.reference_id, v_ref_no,
        p_action, v_field, v_old_text, v_new_text, (v_result ->> 'difference')::numeric,
        p_reason, p_actor_id, coalesce(p_actor_name, ''), p_ip_address
      );

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'record.' || v_field,
        'label', v_ref_no || ' · ' || v_label,
        'old', case when v_money and v_old ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_old::numeric, 'FM999,999,999,990.00')
                    else nullif(v_old_text, '') end,
        'new', case when v_money and v_new ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_new::numeric, 'FM999,999,999,990.00')
                    else nullif(v_new_text, '') end
      ));
      v_applied := v_applied || jsonb_build_array(v_result || jsonb_build_object('label', v_label));
    end loop;

    v_next := v_ticket.version + 1;

    if p_resolve then
      update finance_tickets
         set status            = 'resolved',
             resolution_type   = 'fixed',
             admin_response    = coalesce(v_response, admin_response),
             responded_by      = case when v_response is not null then p_actor_id else responded_by end,
             responded_by_name = case when v_response is not null then p_actor_name else responded_by_name end,
             responded_at      = case when v_response is not null then now() else responded_at end,
             resolved_by       = p_actor_id,
             resolved_by_name  = p_actor_name,
             resolved_at       = now(),
             version           = v_next
       where id = v_ticket.id
       returning * into v_after;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'status', 'label', 'Status',
        'old', coalesce(p_labels ->> 'statusFrom', v_ticket.status),
        'new', coalesce(p_labels ->> 'statusTo', 'resolved')));
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'resolutionType', 'label', 'Resolution type',
        'old', null, 'new', coalesce(p_labels ->> 'resolutionType', 'fixed')));
      if v_response is not null and v_response is distinct from v_ticket.admin_response then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'field', 'adminResponse', 'label', 'Admin response',
          'old', nullif(v_ticket.admin_response, ''), 'new', v_response));
      end if;
    else
      update finance_tickets set version = v_next where id = v_ticket.id returning * into v_after;
    end if;

    insert into finance_ticket_versions (
      ticket_id, query_no, version, action, changed_by, changed_by_name, changed_by_role,
      reason, changes, snapshot
    ) values (
      v_after.id, v_after.query_no, v_next, 'record_corrected', p_actor_id, coalesce(p_actor_name, ''),
      p_actor_role, p_reason, v_changes, to_jsonb(v_after)
    );

    return jsonb_build_object(
      'applied',    v_applied,
      'statusFrom', v_ticket.status,
      'ticket',     to_jsonb(v_after)
    );
  end;
  $_$;


--
-- Name: correct_production_order(uuid, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correct_production_order(p_order_id uuid, p_lines jsonb, p_reason text, p_actor_name text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch_id    uuid;
  v_branch_name  text;
  v_status       branch_production_order_status;
  v_stock_moved  boolean;
  v_max_line     integer;
  v_before       jsonb;
  v_after        jsonb;
  v_deltas       jsonb;
begin
  -- Lock the order for the whole correction: a concurrent review or verification
  -- of the same order would otherwise interleave with the rewrite below.
  select branch_id, branch_name, status
    into v_branch_id, v_branch_name, v_status
    from production_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A rejected or cancelled demand was never a commitment to anything and moved
  -- no stock. Editing its lines would produce a document that claims otherwise.
  if v_status in ('rejected', 'cancelled') then
    return jsonb_build_object('status', 'not_correctable', 'orderStatus', v_status);
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('status', 'empty');
  end if;

  select exists (
           select 1 from stock_history
            where ref_id = p_order_id::text
              and type   = 'production'
         )
    into v_stock_moved;

  select coalesce(jsonb_agg(jsonb_build_object(
           'productId',   product_id,
           'productName', product_name,
           'qty',         qty,
           'approvedQty', coalesce(approved_qty, 0)
         ) order by line_no), '[]'::jsonb)
    into v_before
    from production_order_items
   where production_order_id = p_order_id;

  -- ── The per-product change in APPROVED quantity ───────────────────────────
  -- A full outer join so a line only in p_lines (added) and a line only on the
  -- order (removed) both produce a delta. Zero-deltas are filtered out so the
  -- caller moves nothing for an untouched line.
  with newl as (
    select (l->>'productId')::uuid                    as product_id,
           nullif(trim(l->>'productName'), '')        as product_name,
           coalesce((l->>'qty')::numeric, 0)          as qty,
           coalesce((l->>'approvedQty')::numeric, 0)  as approved_qty
      from jsonb_array_elements(p_lines) l
  ),
  oldl as (
    select product_id, product_name, coalesce(approved_qty, 0) as approved_qty
      from production_order_items
     where production_order_id = p_order_id
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'productId',   coalesce(n.product_id, o.product_id),
             'productName', coalesce(n.product_name, o.product_name),
             'delta',       coalesce(n.approved_qty, 0) - coalesce(o.approved_qty, 0)
           )) filter (where coalesce(n.approved_qty, 0) - coalesce(o.approved_qty, 0) <> 0),
           '[]'::jsonb)
    into v_deltas
    from newl n
    full outer join oldl o on o.product_id = n.product_id;

  -- ── Rewrite the lines: remove, update, add ────────────────────────────────
  delete from production_order_items i
   where i.production_order_id = p_order_id
     and not exists (
           select 1 from jsonb_array_elements(p_lines) l
            where (l->>'productId')::uuid = i.product_id
         );

  update production_order_items i
     set qty                   = n.qty,
         product_name          = coalesce(n.product_name, i.product_name),
         -- Migration 74's invariants, restated on every corrected line so a
         -- correction can never reintroduce a carry-forward.
         previous_balance_qty  = 0,
         total_required_qty    = n.qty,
         approved_qty          = n.approved_qty,
         remaining_balance_qty = 0
    from (
      select (l->>'productId')::uuid                   as product_id,
             nullif(trim(l->>'productName'), '')       as product_name,
             coalesce((l->>'qty')::numeric, 0)         as qty,
             coalesce((l->>'approvedQty')::numeric, 0) as approved_qty
        from jsonb_array_elements(p_lines) l
    ) n
   where i.production_order_id = p_order_id
     and i.product_id = n.product_id;

  select coalesce(max(line_no), 0) into v_max_line
    from production_order_items where production_order_id = p_order_id;

  insert into production_order_items (
    production_order_id, product_id, product_name, qty, remarks,
    previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
  )
  select p_order_id,
         n.product_id,
         coalesce(n.product_name, 'Unknown product'),
         n.qty,
         'Added by Support Center',
         0, n.qty, n.approved_qty, 0,
         v_max_line + row_number() over (order by n.product_name, n.product_id)
    from (
      select (l->>'productId')::uuid                   as product_id,
             nullif(trim(l->>'productName'), '')       as product_name,
             coalesce((l->>'qty')::numeric, 0)         as qty,
             coalesce((l->>'approvedQty')::numeric, 0) as approved_qty
        from jsonb_array_elements(p_lines) l
    ) n
   where not exists (
           select 1 from production_order_items i
            where i.production_order_id = p_order_id
              and i.product_id = n.product_id
         );

  update production_orders
     set was_changed   = true,
         change_reason = left(
           coalesce(nullif(trim(p_reason), ''), 'Corrected from the Support Center')
           || ' (Support Center' || coalesce(' — ' || nullif(trim(p_actor_name), ''), '') || ')',
           1000)
   where id = p_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'productId',   product_id,
           'productName', product_name,
           'qty',         qty,
           'approvedQty', coalesce(approved_qty, 0)
         ) order by line_no), '[]'::jsonb)
    into v_after
    from production_order_items
   where production_order_id = p_order_id;

  return jsonb_build_object(
    'status',      'ok',
    'branchId',    v_branch_id,
    'branchName',  v_branch_name,
    'orderStatus', v_status,
    -- The caller moves stock only when this is true. See the header.
    'stockMoved',  v_stock_moved,
    'deltas',      case when v_stock_moved then v_deltas else '[]'::jsonb end,
    'before',      v_before,
    'after',       v_after
  );
end;
$$;


--
-- Name: create_special_order(uuid, text, date, uuid, text, jsonb, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_special_order(p_branch_id uuid, p_branch_name text, p_business_date date, p_created_by uuid, p_created_by_name text, p_items jsonb, p_required_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_id      uuid;
  v_number  text;
  v_name    text;
  v_qty     numeric;
  v_amount  numeric;
  v_product uuid;
  v_item_id uuid;
  v_items   jsonb := '[]'::jsonb;
  r         record;
begin
  if p_branch_id is null then
    return jsonb_build_object('status', 'invalid', 'error', 'No branch assigned to this account');
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'A Special Order needs at least one item.');
  end if;

  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) loop
    if btrim(coalesce(r.o->>'name', '')) = '' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the item name.');
    end if;
    if jsonb_typeof(r.o->'qty') is distinct from 'number' or (r.o->>'qty')::numeric <= 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter quantity.');
    end if;
    if jsonb_typeof(r.o->'amount') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid', 'error', 'Please enter the Special Order amount.');
    end if;
    if (r.o->>'amount')::numeric < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'The Special Order amount cannot be negative.');
    end if;
  end loop;

  insert into special_orders (branch_id, branch_name, business_date, required_date, status, created_by, created_by_name)
  values (p_branch_id, p_branch_name, p_business_date, p_required_date, 'pending', p_created_by, p_created_by_name)
  returning id, order_number into v_id, v_number;

  for r in select o, ord from jsonb_array_elements(p_items) with ordinality as t(o, ord) order by ord loop
    v_name   := btrim(r.o->>'name');
    v_qty    := (r.o->>'qty')::numeric;
    v_amount := (r.o->>'amount')::numeric;

    insert into products (name, price, is_active, is_special)
    values (v_name || ' — ' || v_number || '/' || r.ord, round(v_amount / v_qty, 2), true, true)
    returning id into v_product;

    insert into special_order_items (special_order_id, product_id, item_name, qty, amount, description, line_no)
    values (v_id, v_product, v_name, v_qty, v_amount, btrim(coalesce(r.o->>'description', '')), r.ord::integer)
    returning id into v_item_id;

    v_items := v_items || jsonb_build_object('id', v_item_id, 'lineNo', r.ord::integer);
  end loop;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'orderNumber', v_number, 'items', v_items);
end;
$$;


--
-- Name: daily_sale_figures(date, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.daily_sale_figures(p_from date, p_to date, p_branch_id uuid) RETURNS TABLE(branch_id uuid, business_date date, total_sale numeric, cash numeric, easypaisa numeric, foodpanda numeric, bank numeric, other numeric, staff_total numeric, discount numeric, order_count integer, cash_expense numeric, expense_total numeric)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: FUNCTION daily_sale_figures(p_from date, p_to date, p_branch_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.daily_sale_figures(p_from date, p_to date, p_branch_id uuid) IS 'AUTO reconciliation figures per branch per business day. Mirrors buildBranchReport() exactly — change both together.';


--
-- Name: data_engine_aggregate(text, jsonb, jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.data_engine_aggregate(p_table text, p_where jsonb, p_metrics jsonb, p_group_by text[] DEFAULT '{}'::text[]) RETURNS SETOF jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'app'
    AS $$
  declare
    -- Mirrors src/data-engine/registry.ts. Keep in step by hand.
    v_allowed constant text[] := array[
      'orders', 'production_orders', 'production_stock_history', 'stock_history',
      'stock_audit_log', 'daily_closing_reports', 'daily_sale_records', 'expenses',
      'finance_income_approvals', 'ledger_entries', 'finance_transactions',
      'finance_tickets', 'finance_audit_logs', 'products', 'customers', 'users',
      'login_sessions', 'login_attempts', 'support_tickets', 'audit_logs'
    ];
    v_select text[] := '{}';
    v_group text[] := '{}';
    v_metric jsonb;
    v_fn text;
    v_col text;
    v_key text;
    v_sql text;
  begin
    if not (p_table = any (v_allowed)) then
      raise exception 'data_engine: table % is not published', p_table using errcode = '42501';
    end if;

    foreach v_col in array coalesce(p_group_by, '{}') loop
      if not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_col
      ) then
        raise exception 'data_engine: unknown group column % on %', v_col, p_table using errcode = '42703';
      end if;
      v_group := array_append(v_group, format('%I', v_col));
      v_select := array_append(v_select, format('%I', v_col));
    end loop;

    if p_metrics is null or jsonb_typeof(p_metrics) <> 'array' or jsonb_array_length(p_metrics) = 0 then
      raise exception 'data_engine: at least one metric is required' using errcode = '22023';
    end if;

    for v_metric in select * from jsonb_array_elements(p_metrics) loop
      v_fn := v_metric ->> 'metric';
      v_col := v_metric ->> 'column';
      if v_fn = 'count' then
        -- array_append, not ||: an untyped literal on the right of || is read
        -- as an array literal and fails on the quotes.
        v_select := array_append(v_select, 'count(*)::bigint as "count"');
        continue;
      end if;
      if v_fn not in ('sum', 'avg', 'min', 'max') then
        raise exception 'data_engine: unsupported metric %', v_fn using errcode = '22023';
      end if;
      if v_col is null or not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_col
      ) then
        raise exception 'data_engine: unknown metric column % on %', v_col, p_table using errcode = '42703';
      end if;
      -- Keyed "sum:column" so the API can hand the row straight back.
      v_key := v_fn || ':' || v_col;
      v_select := array_append(v_select, format('%s(%I) as %I', v_fn, v_col, v_key));
    end loop;

    v_sql := format(
      'select to_jsonb(t) from (select %s from public.%I where %s%s) t',
      array_to_string(v_select, ', '),
      p_table,
      app.data_engine_condition(p_table, p_where),
      case when coalesce(array_length(v_group, 1), 0) > 0
           then ' group by ' || array_to_string(v_group, ', ') || ' order by ' || array_to_string(v_group, ', ')
           else '' end
    );

    return query execute v_sql;
  end;
  $$;


--
-- Name: FUNCTION data_engine_aggregate(p_table text, p_where jsonb, p_metrics jsonb, p_group_by text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.data_engine_aggregate(p_table text, p_where jsonb, p_metrics jsonb, p_group_by text[]) IS 'Data Engine aggregation. Called by the API service role only; browsers are revoked below.';


--
-- Name: decide_daily_sale_record(uuid, text, text, uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decide_daily_sale_record(p_id uuid, p_action text, p_reason text, p_actor_id uuid, p_actor_name text, p_actor_role text, p_is_admin boolean) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: restriction_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restriction_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_no text DEFAULT app.next_finance_number('restriction_request'::text, 'REQ'::text) NOT NULL,
    type text NOT NULL,
    binding_key text NOT NULL,
    branch_id uuid,
    branch_name text,
    requested_date date NOT NULL,
    current_business_date date NOT NULL,
    amount numeric(14,2),
    description text,
    entry_label text,
    reason text NOT NULL,
    requested_by uuid,
    requested_by_name text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approval_no text,
    decided_by uuid,
    decided_by_name text,
    decided_at timestamp with time zone,
    admin_reason text,
    consumed_at timestamp with time zone,
    consumed_ref text,
    CONSTRAINT restriction_requests_consumed_check CHECK (((consumed_at IS NULL) OR (status = 'approved'::text))),
    CONSTRAINT restriction_requests_decision_check CHECK ((((status = 'pending'::text) AND (decided_at IS NULL) AND (approval_no IS NULL)) OR ((status = 'approved'::text) AND (decided_at IS NOT NULL) AND (approval_no IS NOT NULL)) OR ((status = 'rejected'::text) AND (decided_at IS NOT NULL) AND (approval_no IS NOT NULL) AND (admin_reason IS NOT NULL) AND (length(btrim(admin_reason)) > 0)))),
    CONSTRAINT restriction_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT restriction_requests_type_check CHECK ((type = ANY (ARRAY['BACKDATED_DEMAND'::text, 'LEDGER_BACKDATE'::text, 'COMPANY_SHARE_INCOME'::text, 'CASH_DEPOSIT_LIMIT'::text])))
);


--
-- Name: TABLE restriction_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.restriction_requests IS 'One-time Admin approval requests that lift a restriction for one bound transaction. Spent by UPDATE … WHERE consumed_at IS NULL.';


--
-- Name: decide_restriction_request(uuid, text, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decide_restriction_request(p_id uuid, p_decision text, p_reason text, p_actor_id uuid, p_actor_name text) RETURNS SETOF public.restriction_requests
    LANGUAGE sql
    AS $$
    update restriction_requests
       set status          = p_decision,
           approval_no     = app.next_finance_number('restriction_approval', 'APR'),
           decided_by      = p_actor_id,
           decided_by_name = p_actor_name,
           decided_at      = now(),
           admin_reason    = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_id
       and status = 'pending'
       and p_decision in ('approved', 'rejected')
    returning *;
  $$;


--
-- Name: delete_finance_ticket_source(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_finance_ticket_source(p_reference_type text, p_reference_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_ref       text;
    v_recompute jsonb;
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'no reference id');
    end if;

    case p_reference_type

      when 'ledger_entry' then
        select voucher_no into v_ref from ledger_entries where id = p_reference_id;
        if v_ref is null then
          return jsonb_build_object('deleted', false, 'reason', 'already gone');
        end if;

        -- Every FK pointing at this row is ON DELETE RESTRICT, which is checked
        -- per row and cannot be deferred, so the references have to be cleared
        -- before the delete rather than cascaded by it. The source documents are
        -- deliberately kept: destroying a salary payment because someone deleted
        -- a query about it would be a second, unasked-for deletion.
        update ledger_entries
           set reverses_entry_id    = nullif(reverses_entry_id, p_reference_id),
               reversed_by_entry_id = nullif(reversed_by_entry_id, p_reference_id)
         where reverses_entry_id = p_reference_id
            or reversed_by_entry_id = p_reference_id;

        update finance_transactions   set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update salary_payments        set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update partner_expenses       set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update branch_share_payments  set ledger_entry_id = null where ledger_entry_id = p_reference_id;
        update branch_share_payments  set bonus_ledger_entry_id = null
         where bonus_ledger_entry_id = p_reference_id;

        -- Transaction-local, so it is gone the moment this statement's
        -- transaction ends, however it ends.
        perform set_config('app.allow_ledger_delete', 'on', true);
        delete from ledger_entries where id = p_reference_id;
        perform set_config('app.allow_ledger_delete', 'off', true);

        -- The point of this migration. Same transaction as the delete: the book
        -- is never observable with a hole in its chain.
        v_recompute := recompute_finance_ledger_balances();

      when 'income_approval' then
        select reference_no into v_ref from finance_income_approvals where id = p_reference_id;
        delete from finance_income_approvals where id = p_reference_id;

      when 'finance_transaction' then
        select txn_no into v_ref from finance_transactions where id = p_reference_id;
        delete from finance_transactions where id = p_reference_id;

      when 'salary_payment' then
        select salary_no into v_ref from salary_payments where id = p_reference_id;
        delete from salary_payments where id = p_reference_id;

      when 'partner_expense' then
        select expense_no into v_ref from partner_expenses where id = p_reference_id;
        delete from partner_expenses where id = p_reference_id;

      when 'branch_share_payment' then
        select payment_no into v_ref from branch_share_payments where id = p_reference_id;
        delete from branch_share_payments where id = p_reference_id;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already gone');
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      -- Null for every non-ledger reference type, where no chain was touched.
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;


--
-- Name: delete_production_order(uuid, text, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_production_order(p_order_id uuid, p_reason text, p_ref_id text, p_actor_id uuid, p_actor_name text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_demand_number text;
  v_branch_id     uuid;
  v_branch_name   text;
  v_status        branch_production_order_status;
  v_business_date date;
  v_order         jsonb;
  v_items         jsonb;
  v_packing       jsonb;
  v_branch_rev    jsonb;
  v_pool_rev      jsonb;
  v_today         date;
  r               record;
begin
  -- Lock the order for the whole operation: a concurrent verification would
  -- otherwise credit stock between the sum below and the delete, and that credit
  -- would survive with nothing left to attribute it to.
  select demand_number, branch_id, branch_name, status, business_date
    into v_demand_number, v_branch_id, v_branch_name, v_status, v_business_date
    from production_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The business date drives the reversal's ledger row. Deliberately TODAY, not
  -- the demand's own date: the correction happens now, and back-dating it into a
  -- business day that may already be closed and snapshotted would change a figure
  -- that has been reported.
  v_today := (timezone('Asia/Karachi', now()))::date;

  -- ── Snapshot before anything is destroyed ─────────────────────────────────
  select to_jsonb(po) into v_order from production_orders po where po.id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.line_no), '[]'::jsonb)
    into v_items
    from production_order_items i
   where i.production_order_id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(pk) order by pk.line_no), '[]'::jsonb)
    into v_packing
    from production_order_packing_items pk
   where pk.production_order_id = p_order_id;

  -- ── Reverse the branch ledger ─────────────────────────────────────────────
  -- Net across the whole ref family (see header). A product whose net is already
  -- zero is skipped rather than written as a 0-delta row: a zero movement conveys
  -- nothing and would still consume the (ref_id, product_id, type) key.
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_branch_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
         and branch_id = v_branch_id
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_branch_rev) e
  loop
    perform public.apply_stock_movement(
      v_branch_id, r.product_id, r.product_name, r.delta,
      'adjustment'::stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Reverse the production pool ───────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_pool_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from production_stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_pool_rev) e
  loop
    perform public.apply_production_stock_movement(
      r.product_id, r.product_name, r.delta,
      'adjustment'::production_stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Record what is about to be destroyed ──────────────────────────────────
  -- Written before the delete so a failure anywhere below rolls this back with
  -- it: an audit row describing a demand that still exists would be worse than
  -- none at all.
  insert into audit_logs (action, admin_id, admin_name, details)
  values (
    'production_order_deleted',
    p_actor_id,
    p_actor_name,
    jsonb_build_object(
      'orderId',       p_order_id,
      'demandNumber',  v_demand_number,
      'branchId',      v_branch_id,
      'branchName',    v_branch_name,
      'status',        v_status::text,
      'businessDate',  v_business_date,
      'reason',        p_reason,
      'reversalRefId', p_ref_id,
      'reversedOn',    v_today,
      'order',         v_order,
      'items',         v_items,
      'packingItems',  v_packing,
      'branchReversals', v_branch_rev,
      'poolReversals',   v_pool_rev
    )
  );

  -- Cascades production_order_items and production_order_packing_items.
  delete from production_orders where id = p_order_id;

  return jsonb_build_object(
    'status',          'deleted',
    'demandNumber',    v_demand_number,
    'branchId',        v_branch_id,
    'branchName',      v_branch_name,
    'orderStatus',     v_status::text,
    'stockMoved',      jsonb_array_length(v_branch_rev) > 0 or jsonb_array_length(v_pool_rev) > 0,
    'branchReversals', v_branch_rev,
    'poolReversals',   v_pool_rev
  );
end;
$$;


--
-- Name: FUNCTION delete_production_order(p_order_id uuid, p_reason text, p_ref_id text, p_actor_id uuid, p_actor_name text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.delete_production_order(p_order_id uuid, p_reason text, p_ref_id text, p_actor_id uuid, p_actor_name text) IS 'Hard-deletes a demand and reverses whatever it moved, in one transaction. Reversal amount comes from the NET of the ledger ref family (<id> plus <id>:%), so a demand already corrected by migration 77 reverses correctly. Keeps stock_history, production_stock_history and attachments; writes an audit_logs snapshot first.';


--
-- Name: delete_user_account(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_user_account(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $_$
  declare
    v_found    boolean;
    v_has_auth boolean := to_regclass('auth.users') is not null;
  begin
    select exists (select 1 from public.users where id = p_user_id) into v_found;
    if not v_found and v_has_auth then
      execute 'select exists (select 1 from auth.users where id = $1)' into v_found using p_user_id;
    end if;
    if not v_found then
      return false;
    end if;

    perform set_config('app.allow_user_purge', 'on', true);
    if v_has_auth then
      execute 'delete from auth.users where id = $1' using p_user_id;
    end if;
    -- A profile row whose auth user is already gone must not linger either.
    delete from public.users where id = p_user_id;
    perform set_config('app.allow_user_purge', 'off', true);
    return true;
  end;
  $_$;


--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voucher_no text NOT NULL,
    seq bigint NOT NULL,
    entry_date date NOT NULL,
    ledger_head_id uuid,
    ledger_head_name text NOT NULL,
    ledger_head_type public.ledger_head_type NOT NULL,
    branch_id uuid,
    branch_name text,
    description text NOT NULL,
    debit numeric(14,2) DEFAULT 0 NOT NULL,
    credit numeric(14,2) DEFAULT 0 NOT NULL,
    balance numeric(14,2) NOT NULL,
    account public.finance_account NOT NULL,
    payment_method text,
    status public.ledger_entry_status DEFAULT 'posted'::public.ledger_entry_status NOT NULL,
    source_type public.finance_ledger_source NOT NULL,
    source_id uuid,
    reverses_entry_id uuid,
    reversed_by_entry_id uuid,
    approved_by uuid,
    approved_by_name text,
    created_by uuid,
    created_by_name text,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    updated_at timestamp with time zone,
    updated_by uuid,
    updated_by_name text,
    CONSTRAINT ledger_entries_credit_check CHECK ((credit >= (0)::numeric)),
    CONSTRAINT ledger_entries_debit_check CHECK ((debit >= (0)::numeric)),
    CONSTRAINT ledger_entry_one_sided CHECK ((((debit > (0)::numeric) AND (credit = (0)::numeric)) OR ((credit > (0)::numeric) AND (debit = (0)::numeric))))
);


--
-- Name: edit_finance_ledger_entry(uuid, jsonb, jsonb, uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.edit_finance_ledger_entry(p_entry_id uuid, p_set jsonb, p_expected jsonb, p_actor_id uuid, p_actor_name text, p_today date) RETURNS SETOF public.ledger_entries
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_row     ledger_entries%rowtype;
    v_key     text;
    v_current text;
  begin
    if p_set is null or jsonb_typeof(p_set) <> 'object' or p_set = '{}'::jsonb then
      raise exception 'No changes detected.';
    end if;

    select * into v_row from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'Ledger entry not found, or it has already been deleted.' using errcode = 'MBNFD';
    end if;

    for v_key in select jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
      v_current := case v_key
        when 'amount'        then greatest(v_row.debit, v_row.credit)::text
        when 'entryDate'     then v_row.entry_date::text
        when 'ledgerHeadId'  then coalesce(v_row.ledger_head_id::text, '')
        when 'branchId'      then coalesce(v_row.branch_id::text, '')
        when 'paymentMethod' then coalesce(v_row.payment_method, '')
        when 'account'       then v_row.account::text
        when 'description'   then v_row.description
        else null
      end;
      if v_current is null then
        raise exception 'field "%" cannot be edited on a ledger entry', v_key;
      end if;
      if v_key = 'amount' then
        if round(v_current::numeric, 2) <> round(coalesce(nullif(btrim(p_expected ->> v_key), ''), '0')::numeric, 2) then
          raise exception
            'Voucher % was changed by another user (its amount is now %). Reload it and make your change again.',
            v_row.voucher_no, v_current using errcode = 'MBCON';
        end if;
      elsif btrim(v_current) <> btrim(coalesce(p_expected ->> v_key, '')) then
        raise exception
          'Voucher % was changed by another user. Reload it and make your change again.',
          v_row.voucher_no using errcode = 'MBCON';
      end if;
    end loop;

    perform app.edit_ledger_entry(p_entry_id, p_set, p_actor_id, p_actor_name, p_today);

    return query select * from ledger_entries where id = p_entry_id;
  end;
  $$;


--
-- Name: edit_sale_items(uuid, jsonb, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.edit_sale_items(p_order_id uuid, p_items jsonb, p_business_date date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch_id    uuid;
  v_customer_id  uuid;
  v_tax_rate     numeric;
  v_delivery     numeric;
  v_old_grand    numeric;
  v_subtotal     numeric := 0;
  v_discount     numeric := 0;
  v_tax_amount   numeric;
  v_grand_total  numeric;
  v_shortfalls   jsonb := '[]'::jsonb;
  v_balances     jsonb := '{}'::jsonb;
  v_edit_ref     text;
  v_before       numeric;
  v_after        numeric;
  v_delta        numeric;
  r              record;
begin
  -- Lock the order; capture the components we keep (tax_rate, delivery) and the
  -- values we reconcile afterward (customer, old grand total).
  select branch_id, customer_id, tax_rate, delivery_charges, grand_total
    into v_branch_id, v_customer_id, v_tax_rate, v_delivery, v_old_grand
    from orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── Pass 1: lock each affected product's stock row (product_id order) and
  -- validate that no line increase would overdraw the branch balance. ─────────
  for r in
    with old_q as (
      select product_id, min(product_name) as product_name, sum(qty) as qty
        from order_items
       where order_id = p_order_id and product_id is not null
       group by product_id
    ),
    new_q as (
      select (i->>'productId')::uuid as product_id,
             min(i->>'productName')  as product_name,
             sum((i->>'qty')::numeric) as qty
        from jsonb_array_elements(p_items) as i
       where nullif(i->>'productId', '') is not null
       group by 1
    )
    select coalesce(o.product_id, n.product_id)     as product_id,
           coalesce(n.product_name, o.product_name) as product_name,
           coalesce(o.qty, 0)                       as old_qty,
           coalesce(n.qty, 0)                       as new_qty
      from old_q o
      full outer join new_q n on o.product_id = n.product_id
     order by 1
  loop
    select balance into v_before from stock
     where branch_id = v_branch_id and product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    -- Net change applied to balance = old_qty - new_qty. If that drives the
    -- balance negative, the correction is trying to "sell" more than exists.
    if v_before + (r.old_qty - r.new_qty) < 0 then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.new_qty,
        'available',   v_before + r.old_qty   -- what would be sellable after un-selling the old line
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Apply stock deltas + append the compensating ledger rows ────────────────
  -- Runs BEFORE order_items is replaced, so old_qty still reads the current lines.
  v_edit_ref := p_order_id::text || ':edit:' || gen_random_uuid()::text;

  for r in
    with old_q as (
      select product_id, min(product_name) as product_name, sum(qty) as qty
        from order_items
       where order_id = p_order_id and product_id is not null
       group by product_id
    ),
    new_q as (
      select (i->>'productId')::uuid as product_id,
             min(i->>'productName')  as product_name,
             sum((i->>'qty')::numeric) as qty
        from jsonb_array_elements(p_items) as i
       where nullif(i->>'productId', '') is not null
       group by 1
    )
    select coalesce(o.product_id, n.product_id)     as product_id,
           coalesce(n.product_name, o.product_name) as product_name,
           coalesce(o.qty, 0)                       as old_qty,
           coalesce(n.qty, 0)                       as new_qty
      from old_q o
      full outer join new_q n on o.product_id = n.product_id
     order by 1
  loop
    v_delta := r.old_qty - r.new_qty;   -- +restores stock, -takes more
    continue when v_delta = 0;

    insert into stock (branch_id, product_id, product_name, balance)
    values (v_branch_id, r.product_id, r.product_name, v_delta)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_delta,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (v_branch_id, r.product_id, r.product_name, 'adjustment', v_delta, v_after, v_edit_ref, p_business_date);

    v_balances := v_balances || jsonb_build_object(
      r.product_id::text,
      jsonb_build_object('productName', r.product_name, 'delta', v_delta, 'after', v_after)
    );
  end loop;

  -- ── Replace the line items ──────────────────────────────────────────────────
  delete from order_items where order_id = p_order_id;

  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    p_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'unitPrice')::numeric * (i.value->>'qty')::numeric - coalesce((i.value->>'discount')::numeric, 0),
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Recompute order totals from the new lines (mirrors migration 03) ─────────
  select coalesce(sum(line_total), 0), coalesce(sum(discount), 0)
    into v_subtotal, v_discount
    from order_items where order_id = p_order_id;

  v_tax_amount  := round(v_subtotal * coalesce(v_tax_rate, 0), 2);
  v_grand_total := v_subtotal + coalesce(v_delivery, 0) + v_tax_amount;

  update orders
     set subtotal       = v_subtotal,
         discount_total = v_discount,
         tax_amount     = v_tax_amount,
         grand_total    = v_grand_total,
         updated_at     = now()
   where id = p_order_id;

  -- Keep the customer's lifetime spend consistent (order count is unchanged — this
  -- is a correction, not a new order). Walk-in sales have no customer row.
  if v_customer_id is not null then
    update customers
       set total_spent = total_spent + (v_grand_total - v_old_grand)
     where id = v_customer_id;
  end if;

  return jsonb_build_object(
    'status',     'ok',
    'orderId',    p_order_id,
    'subtotal',   v_subtotal,
    'grandTotal', v_grand_total,
    'balances',   v_balances
  );
end;
$$;


--
-- Name: ensure_daily_sale_record(uuid, date, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_daily_sale_record(p_branch_id uuid, p_business_date date, p_actor_id uuid, p_actor_name text, p_actor_role text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: feed_daily_sale_record(uuid, date, numeric, numeric, numeric, uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feed_daily_sale_record(p_branch_id uuid, p_business_date date, p_cash numeric, p_easypaisa numeric, p_bank numeric, p_actor_id uuid, p_actor_name text, p_actor_role text, p_is_admin boolean) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: finance_dashboard_records(text, date, date, uuid, boolean, uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_dashboard_records(p_metric text, p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid, p_no_branch boolean DEFAULT false, p_head_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_heads uuid[] := app.finance_received_head_ids();
    v_q text := nullif(lower(trim(coalesce(p_search, ''))), '');
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 200);
    v_offset int := greatest(coalesce(p_offset, 0), 0);
    v_out jsonb;
  begin
    if p_from is null or p_to is null or p_to < p_from then
      raise exception 'invalid date range' using errcode = '22023';
    end if;
    if p_metric not in ('demand', 'share', 'received', 'ledger', 'return', 'discount') then
      raise exception 'unknown metric %', p_metric using errcode = '22023';
    end if;

    with src as (
      select o.order_id as id, o.demand_number as ref, o.business_date as d, o.branch_id as b,
             o.branch_name as bname, 'Production order'::text as source,
             case when p_metric = 'share'
                  then trim_scale(o.share_pct)::text || '% of ' || to_char(o.demand, 'FM999,999,999,990.00')
                  else o.line_count::text || ' lines'
                       || case when o.unpriced_lines > 0 then ', ' || o.unpriced_lines::text || ' unpriced' else '' end
             end as detail,
             o.status as status,
             case when p_metric = 'share' then o.company_share else o.demand end as amount,
             o.created_by_name as created_by,
             coalesce(o.approved_by_name, o.verified_by_name) as approved_by
      from app.finance_order_values(p_from, p_to, null) o
      where p_metric in ('demand', 'share')

      union all
      select e.id, e.voucher_no, e.entry_date, e.branch_id, coalesce(b.name, e.branch_name),
             'Ledger · ' || coalesce(lh.name, e.ledger_head_name) || ' · ' || e.source_type::text,
             e.description, e.status::text,
             case when p_metric = 'received' then e.debit - e.credit else e.credit - e.debit end,
             e.created_by_name, e.approved_by_name
      from ledger_entries e
      left join branches b on b.id = e.branch_id
      left join ledger_heads lh on lh.id = e.ledger_head_id
      where p_metric in ('received', 'ledger')
        and e.deleted_at is null
        and e.entry_date between p_from and p_to
        and (
          (p_metric = 'received' and e.ledger_head_type::text = 'income'
             and (e.ledger_head_id = any (v_heads) or e.source_type::text = 'cash_transfer'))
          or (p_metric = 'ledger' and e.ledger_head_type::text = 'expense'
             and (p_head_id is null or e.ledger_head_id = p_head_id))
        )

      union all
      select r.id, null, r.business_date, r.branch_id, coalesce(b.name, r.branch_name),
             'Production return',
             r.product_name || ' × ' || trim_scale(r.qty)::text || ' @ ' || to_char(coalesce(pr.price, 0), 'FM999,999,990.00')
               || coalesce(' · ' || r.disposition::text, ''),
             r.status::text, round(r.qty * coalesce(pr.price, 0), 2),
             r.created_by_name, r.reviewed_by_name
      from production_returns r
      left join branches b on b.id = r.branch_id
      left join products pr on pr.id = r.product_id
      where p_metric = 'return'
        and r.status::text = 'accepted'
        and r.business_date between p_from and p_to

      union all
      select x.id, x.demand_number, x.business_date, x.branch_id, coalesce(b.name, x.branch_name),
             'Production discount', x.reason, x.status::text, x.amount,
             x.created_by_name, x.reviewed_by_name
      from branch_discounts x
      left join branches b on b.id = x.branch_id
      where p_metric = 'discount'
        and x.status::text = 'approved'
        and x.business_date between p_from and p_to
    ),
    filtered as (
      select * from src
      where (case when p_no_branch then b is null
                  else p_branch_id is null or b = p_branch_id end)
        and (v_q is null
             or lower(coalesce(ref, '')) like '%' || v_q || '%'
             or lower(id::text) like '%' || v_q || '%'
             or lower(coalesce(bname, '')) like '%' || v_q || '%'
             or lower(coalesce(detail, '')) like '%' || v_q || '%'
             or lower(coalesce(source, '')) like '%' || v_q || '%')
    )
    select jsonb_build_object(
             'total', (select count(*) from filtered),
             'amount', coalesce((select sum(amount) from filtered), 0),
             'rows', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', id, 'reference', ref, 'date', d, 'branchId', b, 'branchName', bname,
                        'source', source, 'detail', detail, 'status', status, 'amount', amount,
                        'createdBy', created_by, 'approvedBy', approved_by
                      ) order by d, bname nulls last, ref nulls last, id)
               from (select * from filtered order by d, bname nulls last, ref nulls last, id
                     limit v_limit offset v_offset) pg
             ), '[]'::jsonb)
           )
      into v_out;

    return v_out;
  end;
  $$;


--
-- Name: finance_day_summary(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_day_summary(p_business_date date) RETURNS TABLE(opening_balance numeric, opening_cash numeric, opening_bank numeric, total_income numeric, total_expenses numeric, net_balance numeric, cash_in_hand numeric, bank_balance numeric, closing_balance numeric, entry_count integer)
    LANGUAGE sql STABLE
    AS $$
    with prior as (
      select
        coalesce(sum(debit - credit), 0)                                          as bal,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)           as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)           as bank
      from ledger_entries where entry_date < p_business_date and deleted_at is null
    ),
    today as (
      select
        coalesce(sum(debit), 0)                                                    as income,
        coalesce(sum(credit), 0)                                                   as expenses,
        coalesce(sum(debit - credit) filter (where account = 'cash'), 0)            as cash,
        coalesce(sum(debit - credit) filter (where account = 'bank'), 0)            as bank,
        count(*)::integer                                                          as n
      from ledger_entries where entry_date = p_business_date and deleted_at is null
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


--
-- Name: finance_ledger_totals(date, date, uuid, uuid, public.ledger_head_type, public.finance_account, public.ledger_entry_status, public.finance_ledger_source, text, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_ledger_totals(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_branch_id uuid DEFAULT NULL::uuid, p_ledger_head_id uuid DEFAULT NULL::uuid, p_type public.ledger_head_type DEFAULT NULL::public.ledger_head_type, p_account public.finance_account DEFAULT NULL::public.finance_account, p_status public.ledger_entry_status DEFAULT NULL::public.ledger_entry_status, p_source_type public.finance_ledger_source DEFAULT NULL::public.finance_ledger_source, p_search text DEFAULT NULL::text, p_min_amount numeric DEFAULT NULL::numeric, p_max_amount numeric DEFAULT NULL::numeric) RETURNS TABLE(entry_count bigint, total_debit numeric, total_credit numeric, opening_balance numeric)
    LANGUAGE sql STABLE
    AS $$
    with filtered as (
      select e.debit, e.credit
      from ledger_entries e
      where e.deleted_at is null
        and (p_from           is null or e.entry_date     >= p_from)
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
        else coalesce((select sum(debit - credit) from ledger_entries
                        where entry_date < p_from and deleted_at is null), 0)
      end
  $$;


--
-- Name: finance_monthly_dashboard(date, date, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_monthly_dashboard(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid, p_include_heads boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_heads uuid[] := app.finance_received_head_ids();
    v_days jsonb;
    v_ledger jsonb := '[]'::jsonb;
  begin
    if p_from is null or p_to is null or p_to < p_from then
      raise exception 'invalid date range' using errcode = '22023';
    end if;
    if p_to - p_from > 400 then
      raise exception 'date range too long' using errcode = '22023';
    end if;

    with prod as (
      select business_date as d, branch_id as b, sum(demand) as demand, sum(company_share) as share,
             count(*) as orders, sum(unpriced_lines) as unpriced
      from app.finance_order_values(p_from, p_to, p_branch_id)
      group by 1, 2
    ),
    ret as (
      select r.business_date as d, r.branch_id as b,
             sum(round(r.qty * coalesce(pr.price, 0), 2)) as amt, count(*) as n
      from production_returns r
      left join products pr on pr.id = r.product_id
      where r.status::text = 'accepted'
        and r.business_date between p_from and p_to
        and (p_branch_id is null or r.branch_id = p_branch_id)
      group by 1, 2
    ),
    disc as (
      select business_date as d, branch_id as b, sum(amount) as amt, count(*) as n
      from branch_discounts
      where status::text = 'approved'
        and business_date between p_from and p_to
        and (p_branch_id is null or branch_id = p_branch_id)
      group by 1, 2
    ),
    rec as (
      select entry_date as d, branch_id as b, sum(debit - credit) as amt, count(*) as n
      from ledger_entries
      where deleted_at is null
        and ledger_head_type::text = 'income'
        and (ledger_head_id = any (v_heads) or source_type::text = 'cash_transfer')
        and entry_date between p_from and p_to
        and (p_branch_id is null or branch_id = p_branch_id)
      group by 1, 2
    ),
    keys as (
      select d, b from prod union select d, b from ret
      union select d, b from disc union select d, b from rec
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', k.d, 'branchId', k.b,
             'demand', coalesce(prod.demand, 0), 'companyShare', coalesce(prod.share, 0),
             'received', coalesce(rec.amt, 0), 'returns', coalesce(ret.amt, 0),
             'discount', coalesce(disc.amt, 0),
             'orders', coalesce(prod.orders, 0), 'unpricedLines', coalesce(prod.unpriced, 0),
             'receipts', coalesce(rec.n, 0), 'returnCount', coalesce(ret.n, 0),
             'discountCount', coalesce(disc.n, 0)
           ) order by k.d, k.b), '[]'::jsonb)
      into v_days
    from keys k
    left join prod on prod.d = k.d and prod.b is not distinct from k.b
    left join ret  on ret.d  = k.d and ret.b  is not distinct from k.b
    left join disc on disc.d = k.d and disc.b is not distinct from k.b
    left join rec  on rec.d  = k.d and rec.b  is not distinct from k.b;

    if p_include_heads then
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', x.d, 'branchId', x.b, 'ledgerHeadId', x.h,
               'ledgerHeadName', x.name, 'amount', x.amt, 'entries', x.n
             ) order by x.d, x.b, x.name), '[]'::jsonb)
        into v_ledger
      from (
        select e.entry_date as d, e.branch_id as b, e.ledger_head_id as h,
               coalesce(max(lh.name), max(e.ledger_head_name)) as name,
               sum(e.credit - e.debit) as amt, count(*) as n
        from ledger_entries e
        left join ledger_heads lh on lh.id = e.ledger_head_id
        where e.deleted_at is null
          and e.ledger_head_type::text = 'expense'
          and e.entry_date between p_from and p_to
          and (p_branch_id is null or e.branch_id = p_branch_id)
        group by 1, 2, 3
      ) x;
    end if;

    return jsonb_build_object('days', v_days, 'ledger', v_ledger);
  end;
  $$;


--
-- Name: finance_ticket_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_ticket_stats(p_raised_by uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    with live as (
      select *
        from finance_tickets
       where deleted_at is null
         and (p_raised_by is null or raised_by = p_raised_by)
         -- Another person's draft is not on the desk yet.
         and (status <> 'draft' or (p_raised_by is not null and raised_by = p_raised_by))
    )
    select jsonb_build_object(
      'total',        (select count(*) from live),
      'draft',        (select count(*) from live where status = 'draft'),
      'open',         (select count(*) from live where status = 'open'),
      'underReview',  (select count(*) from live where status = 'under_review'),
      'waiting',      (select count(*) from live where status = 'waiting_for_finance'),
      'amended',      (select count(*) from live where status = 'amended'),
      'reopened',     (select count(*) from live where status = 'reopened'),
      'resolved',     (select count(*) from live where status = 'resolved'),
      'rejected',     (select count(*) from live where status = 'rejected'),
      'closed',       (select count(*) from live where status = 'closed'),
      'highPriority', (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and priority in ('high', 'urgent')),
      'urgent',       (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and priority = 'urgent'),
      'unassigned',   (select count(*) from live
                        where status not in ('draft', 'resolved', 'rejected', 'closed')
                          and assigned_to is null),
      'recent',       (select count(*) from live where updated_at > now() - interval '24 hours'),
      'deleted',      (select count(*) from finance_tickets
                        where deleted_at is not null
                          and (p_raised_by is null or raised_by = p_raised_by))
    );
  $$;


--
-- Name: increment_customer_stats(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_customer_stats(p_customer_id uuid, p_amount numeric) RETURNS void
    LANGUAGE sql
    AS $$
  update customers
     set total_orders = total_orders + 1,
         total_spent  = total_spent + p_amount
   where id = p_customer_id;
$$;


--
-- Name: list_public_base_tables(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_public_base_tables() RETURNS TABLE(table_name text, primary_key_columns text[])
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    select
      t.table_name::text,
      coalesce(
        (
          select array_agg(kcu.column_name::text order by kcu.ordinal_position)
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_name = tc.constraint_name
           and kcu.table_schema = tc.table_schema
          where tc.table_schema = 'public'
            and tc.table_name = t.table_name
            and tc.constraint_type = 'PRIMARY KEY'
        ),
        '{}'::text[]
      ) as primary_key_columns
    from information_schema.tables t
    where t.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
    order by t.table_name;
  $$;


--
-- Name: FUNCTION list_public_base_tables(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_public_base_tables() IS 'Lists every base table in the public schema plus its primary-key columns, for the backup:s3 script. Called by the API service role only; browsers are revoked below.';


--
-- Name: next_demand_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_demand_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'demand' returning count into next_count;
    if not found then raise exception 'counters row "demand" is missing'; end if;
    return 'DMD-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_event_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_event_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'special_events' returning count into next_count;
    if not found then raise exception 'counters row "special_events" is missing'; end if;
    return 'EVT-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_expense_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_expense_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'expenses' returning count into next_count;
    if not found then raise exception 'counters row "expenses" is missing'; end if;
    return 'EXP-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_finance_query_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_finance_query_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'finance_queries' returning count into next_count;
    if not found then raise exception 'counters row "finance_queries" is missing'; end if;
    return 'FIN-' || lpad(next_count::text, 3, '0');
  end;
  $$;


--
-- Name: next_order_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_order_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare
    next_count bigint;
  begin
    update counters set count = count + 1
      where id = 'orders'
      returning count into next_count;

    if not found then
      raise exception 'counters row "orders" is missing';
    end if;

    return 'MB-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_price_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_price_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'price_history' returning count into next_count;
    if not found then raise exception 'counters row "price_history" is missing'; end if;
    return 'PRC-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_special_order_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_special_order_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'special_order' returning count into next_count;
    if not found then raise exception 'counters row "special_order" is missing'; end if;
    return 'SO-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_stock_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_stock_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'stock' returning count into next_count;
    if not found then raise exception 'counters row "stock" is missing'; end if;
    return 'STK-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_ticket_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_ticket_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'support' returning count into next_count;
    if not found then raise exception 'counters row "support" is missing'; end if;
    return 'SUP-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: next_user_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_user_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'users' returning count into next_count;
    if not found then raise exception 'counters row "users" is missing'; end if;
    return 'MBU-' || lpad(next_count::text, 6, '0');
  end;
  $$;


--
-- Name: post_finance_ledger_entry(date, uuid, text, numeric, numeric, public.finance_account, public.finance_ledger_source, uuid, uuid, text, text, uuid, text, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_finance_ledger_entry(p_entry_date date, p_ledger_head_id uuid, p_description text, p_debit numeric, p_credit numeric, p_account public.finance_account, p_source_type public.finance_ledger_source, p_source_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_branch_name text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text, p_approved_by uuid DEFAULT NULL::uuid, p_approved_by_name text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_created_by_name text DEFAULT NULL::text, p_reverses_entry_id uuid DEFAULT NULL::uuid) RETURNS public.ledger_entries
    LANGUAGE plpgsql
    AS $$
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
    -- Migration 107: an inactive head refuses MANUAL entries only. A head the
    -- automatic postings resolve by code (branch share payout, bonus, salary,
    -- adjustment) may be hidden from the pickers and still be posted to by the
    -- workflow that owns it — hiding a head from people is not the same as
    -- closing it to the system.
    if not v_head.is_active and p_reverses_entry_id is null and p_source_type = 'manual' then
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

    select balance into v_prev
      from ledger_entries where deleted_at is null order by seq desc limit 1;
    v_prev := coalesce(v_prev, 0);

    insert into ledger_entries (
      voucher_no, entry_date, ledger_head_id, ledger_head_name, ledger_head_type,
      branch_id, branch_name, description, debit, credit, balance, account,
      payment_method, source_type, source_id, reverses_entry_id,
      approved_by, approved_by_name, created_by, created_by_name
    ) values (
      -- Exactly one side is non-zero (the CHECK at the top of this function
      -- guarantees it), so this never falls through to the wrong series: debit
      -- is money in, everything else is money out.
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


--
-- Name: prepare_special_order(uuid, uuid, text, jsonb, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_special_order(p_order_id uuid, p_by uuid, p_by_name text, p_items jsonb DEFAULT '[]'::jsonb, p_business_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_date        date := coalesce(p_business_date, app.karachi_business_date());
  v_prepared    numeric;
  v_any         boolean := false;
  v_ref         text;
  v_move_id     uuid;
  v_txn         text;
  r             record;
begin
  select branch_id, branch_name, order_number, status
    into v_branch, v_branch_name, v_number, v_status
    from special_orders where id = p_order_id
     for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_status <> 'pending' then
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;

  -- Validate every quantity before writing anything.
  for r in
    select i.id, i.qty,
           (select (o->>'preparedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
  loop
    v_prepared := coalesce(r.wanted, r.qty);
    if v_prepared < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Prepared quantity cannot be negative.');
    end if;
    if v_prepared > 0 then v_any := true; end if;
  end loop;
  if not v_any then
    return jsonb_build_object('status', 'invalid', 'error', 'Enter the quantity prepared for at least one item.');
  end if;

  update special_orders
     set status = 'awaiting_verification', prepared_by = p_by, prepared_by_name = p_by_name, prepared_at = now()
   where id = p_order_id;

  -- product_id order: migration 04's lock-ordering invariant for pool rows.
  for r in
    select i.id, i.product_id, i.item_name, i.qty, i.line_no,
           (select (o->>'preparedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
     order by i.product_id, i.line_no
  loop
    v_prepared := coalesce(r.wanted, r.qty);
    v_ref      := v_number || '/' || r.line_no;
    v_move_id  := null;
    v_txn      := null;

    if v_prepared > 0 then
      perform public.apply_production_stock_movement(
        p_product_id      => r.product_id,
        p_product_name    => r.item_name,
        p_delta           => v_prepared,
        p_type            => 'prepare',
        p_ref_id          => v_ref,
        p_business_date   => v_date,
        p_branch_id       => v_branch,
        p_created_by      => p_by,
        p_created_by_name => p_by_name,
        p_reason          => 'Special Order ' || v_number,
        p_remarks         => 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '')
      );

      update production_stock_history
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'source', 'special_order', 'specialOrderId', p_order_id,
               'specialOrderNumber', v_number, 'specialOrderItemId', r.id)
       where ref_id = v_ref and product_id = r.product_id and type = 'prepare'
      returning id, transaction_no into v_move_id, v_txn;
    end if;

    update special_order_items
       set prepared_qty = v_prepared, stock_movement_id = v_move_id, stock_transaction_no = v_txn
     where id = r.id;
  end loop;

  return jsonb_build_object('status', 'ok', 'branchId', v_branch, 'orderNumber', v_number);
end;
$$;


--
-- Name: production_dashboard_series(date, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_dashboard_series(p_month_from date, p_today date, p_branch_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  with months as (
    select to_char(m, 'YYYY-MM') as month
      from generate_series(date_trunc('month', p_month_from::timestamp),
                           date_trunc('month', p_today::timestamp),
                           interval '1 month') m
  ),
  month_demand as (
    select to_char(o.business_date, 'YYYY-MM') as month, sum(i.qty) as qty
      from production_orders o
      join production_order_items i on i.production_order_id = o.id
     where o.business_date >= date_trunc('month', p_month_from::timestamp)::date
       and o.business_date <= p_today
       and o.status <> 'cancelled'
       and (p_branch_id is null or o.branch_id = p_branch_id)
     group by 1
  ),
  month_produced as (
    select to_char(business_date, 'YYYY-MM') as month, sum(abs(delta)) as qty
      from production_stock_history
     where type = 'prepare'
       and business_date >= date_trunc('month', p_month_from::timestamp)::date
       and business_date <= p_today
     group by 1
  ),
  hour_demand as (
    select date_trunc('hour', o.submitted_at at time zone 'Asia/Karachi') as h, sum(i.qty) as qty
      from production_orders o
      join production_order_items i on i.production_order_id = o.id
     where o.business_date = p_today
       and o.status <> 'cancelled'
       and (p_branch_id is null or o.branch_id = p_branch_id)
       and (o.submitted_at at time zone 'Asia/Karachi') >= p_today::timestamp
       and (o.submitted_at at time zone 'Asia/Karachi') <  p_today::timestamp + interval '30 hours'
     group by 1
  ),
  hour_produced as (
    select date_trunc('hour', created_at at time zone 'Asia/Karachi') as h, sum(abs(delta)) as qty
      from production_stock_history
     where type = 'prepare' and business_date = p_today
       and (created_at at time zone 'Asia/Karachi') >= p_today::timestamp
       and (created_at at time zone 'Asia/Karachi') <  p_today::timestamp + interval '30 hours'
     group by 1
  ),
  bounds as (
    select min(h) as lo, max(h) as hi
      from (select h from hour_demand union all select h from hour_produced) u
  ),
  hours as (
    select h from bounds, generate_series(bounds.lo, bounds.hi, interval '1 hour') h
     where bounds.lo is not null
  )
  select jsonb_build_object(
    'monthly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.month,
               'demand',   coalesce((select d.qty from month_demand d where d.month = m.month), 0),
               'produced', coalesce((select p.qty from month_produced p where p.month = m.month), 0)
             ) order by m.month)
        from months m
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hour', to_char(hr.h, 'YYYY-MM-DD"T"HH24:00'),
               'demand',   coalesce((select d.qty from hour_demand d where d.h = hr.h), 0),
               'produced', coalesce((select p.qty from hour_produced p where p.h = hr.h), 0)
             ) order by hr.h)
        from hours hr
    ), '[]'::jsonb)
  );
$$;


--
-- Name: production_dashboard_week(date, date, date, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_dashboard_week(p_from date, p_to date, p_prev_from date, p_prev_to date, p_branch_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  with orders as (
    select o.id, o.business_date, o.branch_id, o.branch_name, o.status,
           o.was_changed, o.submitted_at,
           (o.business_date >= p_from) as cur
      from production_orders o
     where (o.business_date between p_from and p_to
            or o.business_date between p_prev_from and p_prev_to)
       and o.status <> 'cancelled'
  ),
  lines as (
    select o.id as order_id, o.business_date, o.branch_id, o.branch_name, o.cur,
           i.product_id, i.product_name, i.qty,
           case when o.status in ('verified', 'approved')
                then coalesce(i.approved_qty, 0) else 0 end as delivered
      from orders o
      join production_order_items i on i.production_order_id = o.id
  ),
  scoped_orders as (
    select * from orders where p_branch_id is null or branch_id = p_branch_id
  ),
  scoped as (
    select * from lines where p_branch_id is null or branch_id = p_branch_id
  ),
  prepared as (
    select product_id, business_date, abs(delta) as qty,
           (business_date >= p_from) as cur
      from production_stock_history
     where type = 'prepare'
       and (business_date between p_from and p_to
            or business_date between p_prev_from and p_prev_to)
  ),
  returned as (
    select qty, (business_date >= p_from) as cur
      from production_returns
     where status = 'accepted'
       and (business_date between p_from and p_to
            or business_date between p_prev_from and p_prev_to)
       and (p_branch_id is null or branch_id = p_branch_id)
  ),
  -- Grouped by product_id alone, as 112 does: a deleted product's lines
  -- (product_id null) collapse into one entry rather than one per name snapshot.
  top as (
    select product_id, product_name, qty,
           row_number() over (order by qty desc, product_id) as rn
      from (
        select product_id, max(product_name) as product_name, sum(qty) as qty
          from scoped
         where cur
         group by product_id
      ) t
     order by qty desc, product_id
     limit 10
  ),
  branch_week as (
    select branch_id, max(branch_name) as branch_name,
           sum(qty) as demand, sum(delivered) as delivered
      from lines
     where cur
     group by branch_id
  ),
  heat_cells as (
    select branch_id, product_id, sum(qty) as qty
      from lines
     where cur
     group by branch_id, product_id
  ),
  days as (
    select d::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  recent as (
    select o.id, o.submitted_at, o.branch_name, o.status, o.was_changed,
           (select count(*) from production_order_items i where i.production_order_id = o.id) as products,
           (select coalesce(sum(i.qty), 0) from production_order_items i where i.production_order_id = o.id) as units
      from scoped_orders o
     order by o.submitted_at desc
     limit 7
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'demand', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from scoped where cur),
        'prev', (select coalesce(sum(qty), 0) from scoped where not cur)),
      'delivered', jsonb_build_object(
        'cur',  (select coalesce(sum(delivered), 0) from scoped where cur),
        'prev', (select coalesce(sum(delivered), 0) from scoped where not cur)),
      'produced', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from prepared where cur),
        'prev', (select coalesce(sum(qty), 0) from prepared where not cur)),
      'openOrders', jsonb_build_object(
        'cur',  (select count(*) from scoped_orders where cur and status = 'pending'),
        'prev', (select count(*) from scoped_orders where not cur and status = 'pending')),
      'deliveredOrders', jsonb_build_object(
        'cur',  (select count(*) from scoped_orders where cur and status in ('verified', 'approved')),
        'prev', (select count(*) from scoped_orders where not cur and status in ('verified', 'approved'))),
      'returns', jsonb_build_object(
        'cur',  (select coalesce(sum(qty), 0) from returned where cur),
        'prev', (select coalesce(sum(qty), 0) from returned where not cur))
    ),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', d.day,
               'demand',   (select coalesce(sum(s.qty), 0) from scoped s where s.business_date = d.day),
               'produced', (select coalesce(sum(p.qty), 0) from prepared p where p.business_date = d.day)
             ) order by d.day)
        from days d
    ), '[]'::jsonb),
    -- `changed` overlaps the status counts (a changed order is also verified,
    -- approved, …), so it is reported beside them, never as a share of the total.
    'orderStatus', jsonb_build_object(
      'pending',              (select count(*) from scoped_orders where cur and status = 'pending'),
      'awaitingVerification', (select count(*) from scoped_orders where cur and status = 'awaiting_verification'),
      'verified',             (select count(*) from scoped_orders where cur and status = 'verified'),
      'approved',             (select count(*) from scoped_orders where cur and status = 'approved'),
      'rejected',             (select count(*) from scoped_orders where cur and status = 'rejected'),
      'changed',              (select count(*) from scoped_orders where cur and was_changed)
    ),
    'branchCompare', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branchId', branch_id, 'branchName', branch_name,
               'demand', demand, 'delivered', delivered
             ) order by demand desc, branch_id)
        from branch_week
    ), '[]'::jsonb),
    'plan', coalesce((
      select jsonb_agg(jsonb_build_object(
               'productId', t.product_id, 'productName', t.product_name,
               'demand', t.qty,
               'produced', (select coalesce(sum(p.qty), 0) from prepared p where p.cur and p.product_id = t.product_id),
               'stock',    (select coalesce(sum(s.balance), 0) from production_stock s where s.product_id = t.product_id)
             ) order by t.rn)
        from top t
    ), '[]'::jsonb),
    'heat', jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(jsonb_build_object('productId', product_id, 'productName', product_name) order by rn)
          from top
      ), '[]'::jsonb),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'branchId', b.branch_id, 'branchName', b.branch_name,
                 'values', coalesce((
                   select jsonb_agg(coalesce(c.qty, 0) order by t.rn)
                     from top t
                     left join heat_cells c
                       on c.branch_id = b.branch_id
                      and c.product_id is not distinct from t.product_id
                 ), '[]'::jsonb)
               ) order by b.demand desc, b.branch_id)
          from branch_week b
      ), '[]'::jsonb)
    ),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', id, 'submittedAt', submitted_at, 'branchName', branch_name,
               'products', products, 'units', units,
               'status', status, 'wasChanged', was_changed
             ) order by submitted_at desc)
        from recent
    ), '[]'::jsonb)
  );
$$;


--
-- Name: production_demand_overview(date, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_demand_overview(p_demand_from date, p_day_from date, p_last7 date) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  with order_qty as (
    -- One row per order in the window; itemsQty() in production.routes.ts
    -- summed item.qty per order the same way.
    select
      o.id, o.business_date, o.branch_id, o.branch_name, o.status, o.was_changed,
      coalesce((
        select sum(i.qty) from production_order_items i where i.production_order_id = o.id
      ), 0) as qty
    from production_orders o
    where o.business_date >= p_demand_from
      and o.status <> 'cancelled'
  ),
  -- topProducts groups by product_id alone, same as productMap[it.product_id]
  -- in production.routes.ts — a deleted product's items (product_id null) all
  -- collapse into one entry, never one entry per distinct name snapshot.
  product_qty as (
    select i.product_id, max(i.product_name) as product_name, sum(i.qty) as qty
      from production_order_items i
      join order_qty oq on oq.id = i.production_order_id
     group by i.product_id
  ),
  by_day as (
    select business_date, sum(qty) as qty, count(*) as orders
      from order_qty
     where business_date >= p_day_from
     group by business_date
  ),
  by_month as (
    select left(business_date::text, 7) as month, sum(qty) as qty
      from order_qty
     group by left(business_date::text, 7)
     order by month desc
     limit 6
  ),
  -- branch_id is NOT NULL on production_orders, so this always collapses to one
  -- row per branch — matches branchMap[o.branch_id] exactly.
  by_branch as (
    select branch_id, max(branch_name) as branch_name, sum(qty) as qty
      from order_qty
     group by branch_id
  ),
  top_products as (
    select product_id, product_name, qty
      from product_qty
     order by qty desc, product_id
     limit 10
  )
  select jsonb_build_object(
    'waitingOrders',  (select count(*) from order_qty where status = 'pending'),
    'totalDemandQty', (select coalesce(sum(qty), 0) from order_qty where status = 'pending'),
    'approvedOrders', (select count(*) from order_qty where status = 'approved' and business_date >= p_last7),
    'changedOrders',  (select count(*) from order_qty where status = 'approved' and business_date >= p_last7 and was_changed),
    'demandByDay',    coalesce((
                         select jsonb_agg(jsonb_build_object('date', business_date, 'qty', qty, 'orders', orders) order by business_date)
                         from by_day
                       ), '[]'::jsonb),
    'demandByMonth',  coalesce((
                         select jsonb_agg(jsonb_build_object('month', month, 'qty', qty) order by month)
                         from by_month
                       ), '[]'::jsonb),
    'branchDemand',   coalesce((
                         select jsonb_agg(jsonb_build_object('branchId', branch_id, 'branchName', branch_name, 'qty', qty) order by qty desc)
                         from by_branch
                       ), '[]'::jsonb),
    'topProducts',    coalesce((
                         select jsonb_agg(jsonb_build_object('productId', product_id, 'productName', product_name, 'qty', qty) order by qty desc)
                         from top_products
                       ), '[]'::jsonb)
  );
$$;


--
-- Name: production_demand_shortfalls(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_demand_shortfalls(p_quantities jsonb, p_exclude_order_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_shortfalls jsonb := '[]'::jsonb;
  v_balance    numeric;
  v_available  numeric;
  r            record;
begin
  for r in
    select (i->>'productId')::uuid   as product_id,
           sum((i->>'qty')::numeric) as qty
      from jsonb_array_elements(coalesce(p_quantities, '[]'::jsonb)) as i
     where nullif(i->>'productId', '') is not null
     group by 1
     order by 1
  loop
    if r.qty is null or r.qty <= 0 then continue; end if;

    select balance into v_balance from production_stock
     where product_id = r.product_id
     for update;
    if not found then v_balance := 0; end if;

    v_available := v_balance - public.production_outstanding_demand(r.product_id, p_exclude_order_id);

    if r.qty > v_available then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', coalesce((select name from products where id = r.product_id), 'Unknown product'),
        'requested',   r.qty,
        'available',   greatest(v_available, 0),
        'shortage',    r.qty - v_available
      );
    end if;
  end loop;

  return v_shortfalls;
end;
$$;


--
-- Name: production_outstanding_demand(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_outstanding_demand(p_product_id uuid, p_exclude_order_id uuid DEFAULT NULL::uuid) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
  select coalesce(sum(
           case when o.status = 'pending'
                then i.qty
                else coalesce(i.approved_qty, i.qty)
           end), 0)
    from production_order_items i
    join production_orders o on o.id = i.production_order_id
   where i.product_id = p_product_id
     and o.status in ('pending', 'awaiting_verification')
     and (p_exclude_order_id is null or o.id <> p_exclude_order_id);
$$;


--
-- Name: production_stock_availability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.production_stock_availability() RETURNS TABLE(product_id uuid, balance numeric, reserved numeric, available numeric)
    LANGUAGE sql STABLE
    AS $$
  with reserved as (
    select i.product_id,
           sum(case when o.status = 'pending'
                    then i.qty
                    else coalesce(i.approved_qty, i.qty) end) as qty
      from production_order_items i
      join production_orders o on o.id = i.production_order_id
     where o.status in ('pending', 'awaiting_verification')
       and i.product_id is not null
     group by i.product_id
  )
  select p.id,
         coalesce(s.balance, 0),
         coalesce(r.qty, 0),
         coalesce(s.balance, 0) - coalesce(r.qty, 0)
    from products p
    left join production_stock s on s.product_id = p.id
    left join reserved r         on r.product_id = p.id;
$$;


--
-- Name: purge_idempotency_keys(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_idempotency_keys(p_older_than_days integer DEFAULT 30) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_deleted integer;
begin
  delete from idempotency_keys
   where created_at < now() - make_interval(days => p_older_than_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


--
-- Name: recompute_finance_ledger_balances(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_finance_ledger_balances() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_updated integer;
    v_before  numeric(14,2);
    v_after   numeric(14,2);
    v_rows    integer;
  begin
    perform pg_advisory_xact_lock(hashtext('finance_ledger_post'));

    select count(*) into v_rows from ledger_entries where deleted_at is null;
    select balance into v_before
      from ledger_entries where deleted_at is null order by seq desc limit 1;

    perform set_config('app.allow_balance_recompute', 'on', true);

    with running as (
      select id,
             sum(debit - credit) over (order by seq rows between unbounded preceding and current row) as bal
        from ledger_entries
       where deleted_at is null
    )
    update ledger_entries e
       set balance = r.bal
      from running r
     where e.id = r.id
       and e.balance is distinct from r.bal;

    get diagnostics v_updated = row_count;

    perform set_config('app.allow_balance_recompute', 'off', true);

    select balance into v_after
      from ledger_entries where deleted_at is null order by seq desc limit 1;

    return jsonb_build_object(
      'rows',           v_rows,
      'updated',        v_updated,
      'closingBefore',  v_before,
      'closingAfter',   v_after
    );
  end;
  $$;


--
-- Name: reject_cash_transfer(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_reason text) RETURNS public.cash_transfers
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION reject_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.reject_cash_transfer(p_id uuid, p_actor_id uuid, p_actor_name text, p_reason text) IS 'Refuse a pending cash transfer with a reason. The row and its photo are kept. P0001 if already decided; P0002 if missing.';


--
-- Name: release_idempotency_key(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_idempotency_key(p_user_id uuid, p_key text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  delete from idempotency_keys
   where user_id = p_user_id
     and key     = p_key
     and status  = 'in_progress';
end;
$$;


--
-- Name: reverse_finance_ledger_entry(uuid, date, text, uuid, text, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reverse_finance_ledger_entry(p_entry_id uuid, p_entry_date date, p_reason text, p_actor_id uuid, p_actor_name text, p_corrected_amount numeric DEFAULT NULL::numeric, p_corrected_description text DEFAULT NULL::text) RETURNS SETOF public.ledger_entries
    LANGUAGE plpgsql
    AS $$
  declare
    v_orig   ledger_entries%rowtype;
    v_set    jsonb := '{}'::jsonb;
  begin
    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry % does not exist, or it has already been deleted', p_entry_id;
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % was reversed by % and is no longer part of the book',
        v_orig.voucher_no, coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), '?');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is a reversing entry and cannot be changed', v_orig.voucher_no;
    end if;

    if p_corrected_amount is not null or nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
      if p_corrected_amount is not null then
        v_set := v_set || jsonb_build_object('amount', round(p_corrected_amount, 2));
      end if;
      if nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
        v_set := v_set || jsonb_build_object('description', btrim(p_corrected_description));
      end if;
      perform app.edit_ledger_entry(p_entry_id, v_set, p_actor_id, p_actor_name, p_entry_date);
    else
      if exists (select 1 from finance_day_closings where business_date = v_orig.entry_date) then
        raise exception 'the finance day % is closed, so voucher % cannot be removed from it. Reopen the day first.',
          to_char(v_orig.entry_date, 'DD-Mon-YYYY'), v_orig.voucher_no;
      end if;
      update ledger_entries
         set deleted_at      = now(),
             deleted_by      = p_actor_id,
             deleted_by_name = p_actor_name,
             delete_reason   = p_reason
       where id = p_entry_id;
      perform recompute_finance_ledger_balances();
    end if;

    return query select * from ledger_entries where id = p_entry_id;
  end;
  $$;


--
-- Name: review_production_order(uuid, public.branch_production_order_status, jsonb, text, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_production_order(p_order_id uuid, p_status public.branch_production_order_status, p_overrides jsonb, p_reason text, p_reviewed_by uuid, p_reviewed_by_name text, p_packing_overrides jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch_id     uuid;
  v_branch_name   text;
  v_exists        boolean;
  v_was_changed   boolean := false;
  v_items         jsonb   := '[]'::jsonb;
  v_packing       jsonb   := '[]'::jsonb;
  v_demand        numeric;
  v_approved      numeric;
  v_override      numeric;
  r               record;
begin
  update production_orders
     set status           = p_status,
         approved_by      = p_reviewed_by,
         approved_by_name = p_reviewed_by_name,
         approved_at      = now()
   where id = p_order_id
     and status = 'pending'
  returning branch_id, branch_name into v_branch_id, v_branch_name;

  if not found then
    select exists (select 1 from production_orders where id = p_order_id) into v_exists;
    if v_exists then
      return jsonb_build_object('status', 'already_reviewed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Rejection: status flipped, nothing computed. Kept as `= 'rejected'` rather
  -- than a negation for the same backward-compatibility reason migration 56
  -- documents at length — an old server still sending 'approved' must run the
  -- full computation, not fall into this early return.
  if p_status = 'rejected' then
    return jsonb_build_object(
      'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
      'items', '[]'::jsonb, 'packingItems', '[]'::jsonb
    );
  end if;

  for r in
    select i.id, i.product_id, i.product_name, i.qty
      from production_order_items i
     where i.production_order_id = p_order_id
     order by i.product_id
  loop
    -- The fresh demand IS the requirement. No production_balances read, and so
    -- no `for update` row lock: this loop no longer contends with a concurrent
    -- review of another order for the same branch/product.
    v_demand := coalesce(r.qty, 0);

    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
     where (o->>'productId')::uuid = r.product_id
     limit 1;

    -- Default is the fresh demand. An explicit override still wins — that is how
    -- Production reduces (or raises) a line, which is the intended edit path.
    v_approved := coalesce(v_override, v_demand);
    if v_approved <> v_demand then v_was_changed := true; end if;

    update production_order_items
       set previous_balance_qty  = 0,
           total_required_qty    = v_demand,
           approved_qty          = v_approved,
           remaining_balance_qty = 0
     where id = r.id;

    -- Deliberately NO production_balances write. A short-approved line is a
    -- decision Production made about THIS demand; it does not become a debt the
    -- next demand inherits.

    v_items := v_items || jsonb_build_object(
      'productId',           r.product_id,
      'productName',         r.product_name,
      'qty',                 r.qty,
      'previousBalanceQty',  0,
      'totalRequiredQty',    v_demand,
      'approvedQty',         v_approved,
      'remainingBalanceQty', 0
    );

    v_override := null;
  end loop;

  -- Packing materials are unchanged: they never had a carry-forward, so this
  -- loop is copied verbatim from migration 56.
  for r in
    select p.id, p.packing_material_id, p.material_name, p.qty
      from production_order_packing_items p
     where p.production_order_id = p_order_id
     order by p.line_no
  loop
    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_packing_overrides, '[]'::jsonb)) as o
     where (o->>'packingMaterialId')::uuid = r.packing_material_id
     limit 1;

    v_approved := coalesce(v_override, r.qty);
    if v_approved <> r.qty then v_was_changed := true; end if;

    update production_order_packing_items
       set approved_qty = v_approved
     where id = r.id;

    v_packing := v_packing || jsonb_build_object(
      'packingMaterialId', r.packing_material_id,
      'materialName',      r.material_name,
      'qty',               r.qty,
      'approvedQty',       v_approved
    );

    v_override := null;
  end loop;

  update production_orders
     set was_changed   = v_was_changed,
         change_reason = p_reason
   where id = p_order_id;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
    'items', v_items, 'packingItems', v_packing
  );
end;
$$;


--
-- Name: review_production_order_checked(uuid, public.branch_production_order_status, jsonb, text, uuid, text, jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_production_order_checked(p_order_id uuid, p_status public.branch_production_order_status, p_overrides jsonb, p_reason text, p_reviewed_by uuid, p_reviewed_by_name text, p_packing_overrides jsonb DEFAULT '[]'::jsonb, p_enforce_stock boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_shortfalls jsonb;
  v_wanted     jsonb;
begin
  -- Only committing to SEND hands stock out. In this workflow that is
  -- 'awaiting_verification' — review does not move stock, but it is the decision
  -- that promises it, and the decision is the moment a shortage can still be
  -- acted on. ('approved' is accepted too: it is the legacy alias the route
  -- normalises, and guarding both costs nothing.)
  --
  -- Rejecting moves nothing and must never be blocked by a shortage — refusing a
  -- demand you cannot meet is precisely what rejection is for.
  if p_enforce_stock and p_status in ('awaiting_verification', 'approved') then
    -- What this approval will commit to: the override where Production set one,
    -- the branch's own request where they did not.
    select coalesce(jsonb_agg(jsonb_build_object('productId', x.product_id, 'qty', x.qty)), '[]'::jsonb)
      into v_wanted
      from (
        select i.product_id,
               coalesce(
                 (select (o->>'approvedQty')::numeric
                    from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
                   where (o->>'productId')::uuid = i.product_id
                   limit 1),
                 i.qty) as qty
          from production_order_items i
         where i.production_order_id = p_order_id
           and i.product_id is not null
      ) x;

    v_shortfalls := public.production_demand_shortfalls(v_wanted, p_order_id);
    if jsonb_array_length(v_shortfalls) > 0 then
      return jsonb_build_object('status', 'insufficient_stock', 'shortfalls', v_shortfalls);
    end if;
  end if;

  return public.review_production_order(
    p_order_id, p_status, p_overrides, p_reason,
    p_reviewed_by, p_reviewed_by_name, p_packing_overrides
  );
end;
$$;


--
-- Name: revoke_all_auth_sessions(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_all_auth_sessions(p_user_id uuid, p_keep_auth_session_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  declare
    ended   integer := 0;
    removed integer := 0;
  begin
    if p_user_id is null then return 0; end if;

    update public.auth_sessions
       set revoked_at = now()
     where user_id = p_user_id
       and revoked_at is null
       and (p_keep_auth_session_id is null or id <> p_keep_auth_session_id);
    get diagnostics ended = row_count;

    if to_regclass('auth.sessions') is not null then
      execute 'delete from auth.sessions
                where user_id = $1 and ($2::uuid is null or id <> $2)'
        using p_user_id, p_keep_auth_session_id;
      get diagnostics removed = row_count;
    end if;

    return ended + removed;
  end;
  $_$;


--
-- Name: FUNCTION revoke_all_auth_sessions(p_user_id uuid, p_keep_auth_session_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.revoke_all_auth_sessions(p_user_id uuid, p_keep_auth_session_id uuid) IS 'End every signed-in device of one user, optionally keeping one session. Covers API sessions and, while Supabase Auth is still present, GoTrue sessions. Returns how many were ended.';


--
-- Name: revoke_auth_session(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_auth_session(p_auth_session_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  declare
    ended   integer := 0;
    removed integer := 0;
  begin
    if p_auth_session_id is null then return false; end if;

    update public.auth_sessions
       set revoked_at = now()
     where id = p_auth_session_id and revoked_at is null;
    get diagnostics ended = row_count;

    if to_regclass('auth.sessions') is not null then
      execute 'delete from auth.sessions where id = $1' using p_auth_session_id;
      get diagnostics removed = row_count;
    end if;

    return ended + removed > 0;
  end;
  $_$;


--
-- Name: FUNCTION revoke_auth_session(p_auth_session_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.revoke_auth_session(p_auth_session_id uuid) IS 'End one signed-in device: revokes the API session with this id and, while Supabase Auth is still present, deletes the GoTrue session with the same id. True if either existed.';


--
-- Name: sales_analytics(date, date, uuid, integer, date, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sales_analytics(p_from date, p_to date, p_branch_id uuid, p_top_limit integer, p_prev_from date, p_prev_to date, p_today date) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
with scoped as (
  select o.id, o.business_date, o.grand_total, o.payment_method
    from orders o
   where o.business_date between p_from and p_to
     and o.status <> 'cancelled'
     and (p_branch_id is null or o.branch_id = p_branch_id)
),
-- Every money figure below reads from here, never from `scoped`.
paid as (
  select * from scoped where payment_method <> 'staff'
),
days as (
  select d::date as business_date
    from generate_series(p_from, p_to, interval '1 day') as d
),
daily as (
  select days.business_date,
         coalesce(sum(paid.grand_total), 0) as sales,
         -- count(paid.id) and not count(*): the left join leaves one all-null
         -- row for a day with no sales, which count(*) would report as one sale.
         count(paid.id)                     as transactions
    from days
    left join paid on paid.business_date = days.business_date
   group by days.business_date
),
highest as (
  select business_date, sales, transactions
    from daily
   where sales > 0
   order by sales desc, business_date
   limit 1
),
-- `sales > 0`, exactly as `highest` has it, and the predicate is the whole point
-- rather than symmetry: `days` is a DENSE series, so a Sunday the branch was shut
-- is present with sales 0 and would win "lowest" on every window containing one.
-- The figure a manager wants is the worst day the shop actually traded; a
-- fabricated Rs.0 for a day nobody opened buries it, and reads as a catastrophe
-- rather than a closure. A window with no trading at all yields no row, and the
-- card shows an em dash rather than a zero it cannot justify.
--
-- Ties break on the EARLIER date (`business_date` ascending, as in `highest`), so
-- the answer is stable across refetches instead of flipping between two equal days.
lowest as (
  select business_date, sales, transactions
    from daily
   where sales > 0
   order by sales asc, business_date
   limit 1
),
payment as (
  select payment_method::text as method,
         sum(grand_total)     as total,
         count(*)             as cnt
    from paid
   group by payment_method
),
staff as (
  select coalesce(sum(grand_total), 0) as total, count(*) as cnt
    from scoped
   where payment_method = 'staff'
),
top_products as (
  -- product_id is nullable (ON DELETE SET NULL keeps sales history when a
  -- product is deleted), so a null falls back to the name snapshot rather than
  -- collapsing every deleted product into one bucket.
  -- Aggregated as text: there is no max(uuid) in Postgres, and the value is
  -- only ever emitted as a string. Every row in a group carries the same
  -- product_id (or none at all), so max() picks that one value exactly.
  select coalesce(i.product_id::text, 'name:' || i.product_name) as group_key,
         max(i.product_id::text)                                 as product_id,
         min(i.product_name)                                     as product_name,
         coalesce(min(i.category_name), '')                      as category_name,
         sum(i.qty)                                              as qty,
         sum(i.line_total)                                       as sales
    from order_items i
    join paid p on p.id = i.order_id
   group by 1
   order by sales desc, product_name
   limit greatest(coalesce(p_top_limit, 5), 1)
),
totals as (
  select coalesce(sum(grand_total), 0) as sales, count(*) as transactions from paid
),
previous as (
  select coalesce(sum(o.grand_total), 0) as sales, count(*) as transactions
    from orders o
   where p_prev_from is not null
     and p_prev_to   is not null
     and o.business_date between p_prev_from and p_prev_to
     and o.status <> 'cancelled'
     and o.payment_method <> 'staff'
     and (p_branch_id is null or o.branch_id = p_branch_id)
),
-- Its own scan rather than a lookup into `daily`: "Today's Sales" is today's
-- figure whatever window the user is looking at, and today is frequently
-- outside it (Yesterday, Previous Month, any custom range in the past).
today as (
  select coalesce(sum(o.grand_total), 0) as sales, count(*) as transactions
    from orders o
   where o.business_date = p_today
     and o.status <> 'cancelled'
     and o.payment_method <> 'staff'
     and (p_branch_id is null or o.branch_id = p_branch_id)
)
select jsonb_build_object(
  'totalSales',        (select sales        from totals),
  'totalTransactions', (select transactions from totals),
  'todaySales',        (select sales        from today),
  'todayTransactions', (select transactions from today),
  'staffTotal',        (select total        from staff),
  'staffCount',        (select cnt          from staff),
  -- Denominator is every day in the (clamped) window, including the ones that
  -- sold nothing. Averaging over trading days only would answer a different
  -- question — "how good is a day we open" — and would rise when the shop shuts.
  'dayCount',          (select count(*)     from days),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
           order by business_date)
      from daily), '[]'::jsonb),
  'highestDay', (
    select jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
      from highest),
  'lowestDay', (
    select jsonb_build_object(
             'date',         to_char(business_date, 'YYYY-MM-DD'),
             'sales',        sales,
             'transactions', transactions)
      from lowest),
  'paymentMethods', coalesce((
    select jsonb_agg(jsonb_build_object('method', method, 'total', total, 'count', cnt)
           order by total desc)
      from payment), '[]'::jsonb),
  'topProducts', coalesce((
    select jsonb_agg(jsonb_build_object(
             'productId',    coalesce(product_id, ''),
             'productName',  product_name,
             'categoryName', category_name,
             'qty',          qty,
             'sales',        sales)
           order by sales desc, product_name)
      from top_products), '[]'::jsonb),
  'previousSales',        (select sales        from previous),
  'previousTransactions', (select transactions from previous)
);
$$;


--
-- Name: set_payment_method_lock(uuid, public.payment_method, boolean, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_payment_method_lock(p_branch_id uuid, p_payment_method public.payment_method, p_is_locked boolean, p_reason text, p_actor_id uuid, p_actor_name text, p_actor_role text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: soft_delete_finance_record(text, uuid, text, uuid, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.soft_delete_finance_record(p_reference_type text, p_reference_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_query_id uuid, p_query_no text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  declare
    v_ref       text;
    v_recompute jsonb;
    v_ct_ledger jsonb;
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

      -- Migration 125. The deposit and every ledger entry it produced are
      -- removed together, in this transaction. Nothing is posted: no reversal,
      -- no credit, no adjustment. A second delete finds the deposit already
      -- stamped and touches nothing.
      when 'cash_transfer' then
        update cash_transfers
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning transfer_no into v_ref;

        if v_ref is not null then
          v_ct_ledger := app.delete_cash_transfer_entries(
            p_reference_id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no
          );
          v_recompute := v_ct_ledger -> 'recompute';
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
      'ledgerRemoved',     v_ct_ledger ->> 'voucherNos',
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;


--
-- Name: transfer_return_stock_to_production(uuid, text, numeric, text, date, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_return_stock_to_production(p_product_id uuid, p_product_name text, p_qty numeric, p_ref_id text, p_business_date date, p_reason text, p_created_by uuid DEFAULT NULL::uuid, p_created_by_name text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_available  numeric;
  v_return     numeric;
  v_production numeric;
begin
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('status', 'invalid', 'error', 'Transfer quantity must be greater than zero.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'invalid', 'error', 'A reason is required to transfer return stock.');
  end if;

  -- Lock the return row so two transfers cannot both spend the same units.
  select balance into v_available from return_stock
   where product_id = p_product_id
   for update;
  if not found then v_available := 0; end if;

  if exists (
    select 1 from return_stock_history
     where ref_id = p_ref_id and product_id = p_product_id and type = 'transfer_out'
  ) then
    select balance into v_production from production_stock where product_id = p_product_id;
    return jsonb_build_object(
      'status', 'duplicate',
      'returnStock', v_available, 'productionStock', coalesce(v_production, 0));
  end if;

  if v_available < p_qty then
    return jsonb_build_object('status', 'insufficient', 'requested', p_qty, 'available', v_available);
  end if;

  v_return := public.apply_return_stock_movement(
    p_product_id, p_product_name, -p_qty, 'transfer_out', p_ref_id, p_business_date,
    null, null, p_created_by, p_created_by_name, btrim(p_reason), null
  );

  v_production := public.apply_production_stock_movement(
    p_product_id, p_product_name, p_qty, 'return_transfer', p_ref_id, p_business_date,
    null, p_created_by, p_created_by_name, btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'ok', 'qty', p_qty,
    'returnStock', v_return, 'productionStock', v_production);
end;
$$;


--
-- Name: verify_production_order(uuid, jsonb, jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_production_order(p_order_id uuid, p_verified_items jsonb, p_new_items jsonb, p_verified_by uuid, p_verified_by_name text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch_id     uuid;
  v_branch_name   text;
  v_exists        boolean;
  v_items         jsonb;
  v_max_line      integer;
  r               record;
  n               record;
begin
  update production_orders
     set status           = 'verified',
         verified_by      = p_verified_by,
         verified_by_name = p_verified_by_name,
         verified_at      = now()
   where id = p_order_id
     and status = 'awaiting_verification'
  returning branch_id, branch_name into v_branch_id, v_branch_name;

  if not found then
    select exists (select 1 from production_orders where id = p_order_id) into v_exists;
    if v_exists then
      return jsonb_build_object('status', 'already_reviewed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The branch's counted quantity becomes the approved figure. Whatever it falls
  -- short of is a fact about this delivery, recorded on the line as the gap
  -- between qty and approved_qty — it is no longer promoted into a balance the
  -- next demand inherits.
  for r in
    select o->>'productId' as product_id, (o->>'verifiedQty')::numeric as verified_qty
      from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
  loop
    select i.id
      into n
      from production_order_items i
     where i.production_order_id = p_order_id
       and i.product_id = r.product_id::uuid
     limit 1;
    if not found then continue; end if;

    update production_order_items
       set approved_qty          = r.verified_qty,
           remaining_balance_qty = 0
     where id = n.id;
  end loop;

  -- Lines that arrived without being demanded — unchanged from migration 58.
  if jsonb_array_length(coalesce(p_new_items, '[]'::jsonb)) > 0 then
    select coalesce(max(line_no), 0) into v_max_line
      from production_order_items
     where production_order_id = p_order_id;

    for r in
      select o->>'productId' as product_id, o->>'productName' as product_name, (o->>'qty')::numeric as qty
        from jsonb_array_elements(p_new_items) as o
    loop
      v_max_line := v_max_line + 1;
      insert into production_order_items (
        production_order_id, product_id, product_name, qty, remarks,
        previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no,
        added_by_production
      ) values (
        p_order_id, r.product_id::uuid, r.product_name, r.qty, 'Added at verification',
        0, r.qty, r.qty, 0, v_max_line,
        -- Nobody demanded this line: it turned up in the delivery. Flagged so the
        -- review screen reads its Demand as '-' instead of quoting the arrived
        -- quantity back as though the branch had asked for it.
        true
      );
    end loop;
  end if;

  -- Every final line, read back after the writes above — the caller moves stock
  -- from this, so it must reflect the whole order.
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'productId',   i.product_id,
             'productName', i.product_name,
             'qty',         coalesce(i.approved_qty, 0)
           ) order by i.line_no),
           '[]'::jsonb)
    into v_items
    from production_order_items i
   where i.production_order_id = p_order_id;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name,
    'items', v_items
  );
end;
$$;


--
-- Name: verify_production_order_checked(uuid, jsonb, jsonb, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_production_order_checked(p_order_id uuid, p_verified_items jsonb, p_new_items jsonb, p_verified_by uuid, p_verified_by_name text, p_enforce_stock boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_shortfalls jsonb;
  v_wanted     jsonb;
begin
  if p_enforce_stock then
    select coalesce(jsonb_agg(jsonb_build_object('productId', product_id, 'qty', qty)), '[]'::jsonb)
      into v_wanted
      from (
        select (o->>'productId')::uuid as product_id, (o->>'verifiedQty')::numeric as qty
          from jsonb_array_elements(coalesce(p_verified_items, '[]'::jsonb)) as o
        union all
        select (o->>'productId')::uuid, (o->>'qty')::numeric
          from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) as o
      ) x
     where product_id is not null;

    v_shortfalls := public.production_demand_shortfalls(v_wanted, p_order_id);
    if jsonb_array_length(v_shortfalls) > 0 then
      return jsonb_build_object('status', 'insufficient_stock', 'shortfalls', v_shortfalls);
    end if;
  end if;

  return public.verify_production_order(
    p_order_id, p_verified_items, p_new_items, p_verified_by, p_verified_by_name
  );
end;
$$;


--
-- Name: verify_special_order(uuid, uuid, uuid, text, jsonb, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_special_order(p_order_id uuid, p_branch_id uuid, p_by uuid, p_by_name text, p_items jsonb DEFAULT '[]'::jsonb, p_business_date date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_branch      uuid;
  v_branch_name text;
  v_number      text;
  v_status      branch_production_order_status;
  v_date        date := coalesce(p_business_date, app.karachi_business_date());
  v_prepared    numeric;
  v_verified    numeric;
  v_ref         text;
  v_note        text;
  v_meta        jsonb;
  v_moves       jsonb := '[]'::jsonb;
  r             record;
begin
  select branch_id, branch_name, status, order_number
    into v_branch, v_branch_name, v_status, v_number
    from special_orders where id = p_order_id
     for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_branch_id is null or v_branch <> p_branch_id then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_status = 'approved' then
    return jsonb_build_object('status', 'already_verified', 'orderNumber', v_number);
  end if;
  if v_status <> 'awaiting_verification' then
    return jsonb_build_object('status', 'invalid_status', 'current', v_status);
  end if;
  if not exists (
    select 1 from attachments
     where entity = 'special_order_verification' and entity_id = p_order_id
  ) then
    return jsonb_build_object('status', 'photo_required');
  end if;

  -- Validate every quantity before writing anything.
  for r in
    select i.id, i.item_name, coalesce(i.prepared_qty, i.qty) as prepared,
           (select (o->>'receivedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
  loop
    v_verified := coalesce(r.wanted, r.prepared);
    if v_verified < 0 then
      return jsonb_build_object('status', 'invalid', 'error', 'Received quantity cannot be negative.');
    end if;
    if v_verified > r.prepared then
      return jsonb_build_object('status', 'invalid', 'error',
        'Received quantity for ' || r.item_name || ' cannot be more than the ' || trim(to_char(r.prepared, 'FM999999990.###'), '.') || ' prepared.');
    end if;
  end loop;

  update special_orders
     set status = 'approved',
         verified_by = p_by, verified_by_name = p_by_name, verified_at = now(),
         approved_by = p_by, approved_by_name = p_by_name, approved_at = now(),
         stock_added_at = now()
   where id = p_order_id;

  v_note := 'Special Order ' || v_number || coalesce(' — ' || nullif(v_branch_name, ''), '');

  for r in
    select i.id, i.product_id, i.item_name, i.qty, i.line_no, i.prepared_qty,
           (select (o->>'receivedQty')::numeric
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as o
             where (o->>'itemId')::uuid = i.id limit 1) as wanted
      from special_order_items i where i.special_order_id = p_order_id
     order by i.product_id, i.line_no
  loop
    v_ref  := v_number || '/' || r.line_no;
    v_meta := jsonb_build_object(
      'source', 'special_order', 'specialOrderId', p_order_id,
      'specialOrderNumber', v_number, 'specialOrderItemId', r.id);

    -- An order prepared before this migration was never booked into Production
    -- Stock. Book it now, in full, so the transfer below has units to move —
    -- the unique ledger key makes this a no-op for anything already booked.
    if r.prepared_qty is null then
      perform public.apply_production_stock_movement(
        p_product_id => r.product_id, p_product_name => r.item_name, p_delta => r.qty,
        p_type => 'prepare', p_ref_id => v_ref, p_business_date => v_date,
        p_branch_id => v_branch, p_created_by => p_by, p_created_by_name => p_by_name,
        p_reason => 'Special Order ' || v_number, p_remarks => v_note);
      update special_order_items set prepared_qty = r.qty where id = r.id;
      v_prepared := r.qty;
    else
      v_prepared := r.prepared_qty;
    end if;

    v_verified := coalesce(r.wanted, v_prepared);

    if v_verified > 0 then
      -- Out of Production Stock …
      perform public.apply_production_stock_movement(
        p_product_id      => r.product_id,
        p_product_name    => r.item_name,
        p_delta           => -v_verified,
        p_type            => 'transfer_out',
        p_ref_id          => v_ref,
        p_business_date   => v_date,
        p_branch_id       => v_branch,
        p_created_by      => p_by,
        p_created_by_name => p_by_name,
        p_reason          => 'Special Order ' || v_number,
        p_remarks         => v_note
      );

      -- … and into the branch's own stock, where it is sold from.
      perform public.apply_stock_movement(
        p_branch_id     => v_branch,
        p_product_id    => r.product_id,
        p_product_name  => r.item_name,
        p_delta         => v_verified,
        p_type          => 'production',
        p_ref_id        => v_ref,
        p_business_date => v_date
      );
    end if;

    update production_stock_history
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta
     where ref_id = v_ref and product_id = r.product_id and type in ('prepare', 'transfer_out');

    update special_order_items set verified_qty = v_verified where id = r.id;

    v_moves := v_moves || jsonb_build_object(
      'itemId', r.id, 'itemName', r.item_name, 'requestedQty', r.qty,
      'preparedQty', v_prepared, 'verifiedQty', v_verified, 'stockRef', v_ref);
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch, 'orderNumber', v_number, 'movements', v_moves);
end;
$$;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity public.attachment_entity NOT NULL,
    entity_id uuid,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    width integer,
    height integer,
    uploaded_by uuid,
    uploaded_by_name text,
    bound_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    action text NOT NULL,
    admin_id uuid,
    admin_name text,
    target_user_id uuid,
    target_user_name text,
    target_user_role public.user_role,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_refresh_tokens (
    token_hash text NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: TABLE auth_refresh_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_refresh_tokens IS 'The refresh tokens issued for a session, stored as SHA-256. Each is single-use; reuse of a spent one ends the session.';


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client text DEFAULT 'web'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: TABLE auth_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_sessions IS 'One row per signed-in device. Its id is the `sid` claim of the access tokens issued for it and is what login_sessions.auth_session_id records.';


--
-- Name: backup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_id text NOT NULL,
    backup_type text NOT NULL,
    status text NOT NULL,
    trigger text NOT NULL,
    environment text NOT NULL,
    app_version text,
    database_version text,
    pg_dump_version text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    dump_ms integer,
    upload_ms integer,
    s3_bucket text NOT NULL,
    s3_key text,
    auth_s3_key text,
    manifest_s3_key text,
    file_size bigint,
    auth_file_size bigint,
    checksum_sha256 text,
    auth_checksum_sha256 text,
    retention_until timestamp with time zone,
    attempts integer DEFAULT 1 NOT NULL,
    error_category text,
    error_message text,
    triggered_by uuid,
    triggered_by_name text,
    last_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_jobs_backup_type_check CHECK ((backup_type = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'manual'::text]))),
    CONSTRAINT backup_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'verified'::text, 'failed'::text, 'stale'::text]))),
    CONSTRAINT backup_jobs_trigger_check CHECK ((trigger = ANY (ARRAY['scheduler'::text, 'manual'::text, 'api'::text])))
);


--
-- Name: TABLE backup_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.backup_jobs IS 'One row per pg_dump → S3 backup run (daily/weekly/monthly/manual). The partial unique index on (backup_type) where status = running is the cross-dyno lock. Service role only.';


--
-- Name: backup_restore_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_restore_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_job_id uuid,
    backup_id text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    target_host_redacted text,
    table_count integer,
    row_counts jsonb,
    checks jsonb,
    error_message text,
    run_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_restore_tests_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: TABLE backup_restore_tests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.backup_restore_tests IS 'Restore drills run by `pnpm backup:restore:test` against an isolated, non-production database. Service role only.';


--
-- Name: branch_discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_discounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    production_order_id uuid NOT NULL,
    demand_number text,
    amount numeric(14,2) NOT NULL,
    reason text NOT NULL,
    status public.branch_discount_status DEFAULT 'pending'::public.branch_discount_status NOT NULL,
    business_date date NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by uuid,
    reviewed_by_name text,
    reviewed_at timestamp with time zone,
    review_note text,
    CONSTRAINT branch_discounts_amount_positive CHECK ((amount > (0)::numeric))
);


--
-- Name: TABLE branch_discounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.branch_discounts IS 'Branch claims for money back against a production demand. Reviewed by Production like a return, but moves no stock — approval records that the claim was allowed and books nothing.';


--
-- Name: branch_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    address text,
    latitude numeric(10,7) NOT NULL,
    longitude numeric(10,7) NOT NULL,
    radius_km numeric(6,2) DEFAULT 50 NOT NULL,
    google_place_id text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT branch_locations_lat_range CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))),
    CONSTRAINT branch_locations_lng_range CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))),
    CONSTRAINT branch_locations_radius_positive CHECK (((radius_km > (0)::numeric) AND (radius_km <= (500)::numeric)))
);


--
-- Name: branch_share_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_share_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_no text DEFAULT app.next_finance_number('finance_branch_share'::text, 'BSP'::text) NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    bonus numeric(14,2) DEFAULT 0 NOT NULL,
    business_date date NOT NULL,
    payment_method text NOT NULL,
    account public.finance_account NOT NULL,
    status public.finance_doc_status DEFAULT 'pending_approval'::public.finance_doc_status NOT NULL,
    notes text,
    requested_by uuid,
    requested_by_name text DEFAULT ''::text NOT NULL,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    ledger_entry_id uuid,
    bonus_ledger_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    CONSTRAINT branch_share_payment_has_amount CHECK (((amount > (0)::numeric) OR (bonus > (0)::numeric))),
    CONSTRAINT branch_share_payments_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT branch_share_payments_bonus_check CHECK ((bonus >= (0)::numeric))
);


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    name text NOT NULL,
    slug text NOT NULL,
    location text,
    phone text,
    address text,
    city text,
    manager_id uuid,
    manager_name text,
    is_active boolean DEFAULT true NOT NULL,
    daily_budget numeric(14,2),
    weekly_budget numeric(14,2),
    monthly_budget numeric(14,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_share_pct numeric(5,2),
    CONSTRAINT branches_company_share_pct_check CHECK (((company_share_pct IS NULL) OR ((company_share_pct >= (0)::numeric) AND (company_share_pct <= (100)::numeric))))
);


--
-- Name: COLUMN branches.company_share_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.branches.company_share_pct IS 'Company''s cut of this branch''s collection, 0-100. NULL = inherit finance_settings.company_share_pct. Branch share is always 100 minus this.';


--
-- Name: business_day_closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_day_closures (
    business_date date NOT NULL,
    status public.closure_status NOT NULL,
    trigger public.closure_trigger NOT NULL,
    closed_by text,
    auto_stock_closing boolean DEFAULT false NOT NULL,
    sales_summary jsonb,
    expense_summary jsonb,
    production_expense_summary jsonb,
    production_summary jsonb,
    stock_snapshot jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    duration_ms integer
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    name text NOT NULL,
    slug text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counters (
    id text NOT NULL,
    count bigint NOT NULL
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    name text NOT NULL,
    phone text,
    email text,
    address text,
    branch_id uuid,
    branch_name text,
    total_orders integer DEFAULT 0 NOT NULL,
    total_spent numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_closing_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_closing_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_date date NOT NULL,
    scope public.closing_report_scope NOT NULL,
    branch_id uuid,
    department text,
    report_json jsonb NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_sale_record_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_sale_record_audits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid,
    branch_id uuid NOT NULL,
    business_date date NOT NULL,
    action public.daily_sale_audit_action NOT NULL,
    field text,
    old_value text,
    new_value text,
    reason text,
    actor_id uuid,
    actor_name text,
    actor_role text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_sale_audits_record_present CHECK (((record_id IS NOT NULL) OR (action = ANY (ARRAY['method_locked'::public.daily_sale_audit_action, 'method_unlocked'::public.daily_sale_audit_action]))))
);


--
-- Name: TABLE daily_sale_record_audits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.daily_sale_record_audits IS 'Append-only history for Daily Sale Records: every manual feed, lock, unlock, verification, amendment and admin override, with old and new values.';


--
-- Name: daily_sale_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_sale_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    business_date date NOT NULL,
    auto_total_sale numeric(14,2) DEFAULT 0 NOT NULL,
    auto_cash numeric(14,2) DEFAULT 0 NOT NULL,
    auto_easypaisa numeric(14,2) DEFAULT 0 NOT NULL,
    auto_foodpanda numeric(14,2) DEFAULT 0 NOT NULL,
    auto_bank numeric(14,2) DEFAULT 0 NOT NULL,
    auto_other numeric(14,2) DEFAULT 0 NOT NULL,
    auto_staff numeric(14,2) DEFAULT 0 NOT NULL,
    discount numeric(14,2) DEFAULT 0 NOT NULL,
    cash_expense numeric(14,2) DEFAULT 0 NOT NULL,
    expense_total numeric(14,2) DEFAULT 0 NOT NULL,
    order_count integer DEFAULT 0 NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    manual_cash numeric(14,2),
    manual_easypaisa numeric(14,2),
    manual_bank numeric(14,2),
    fed_by uuid,
    fed_by_name text,
    fed_at timestamp with time zone,
    cash_difference numeric(14,2) GENERATED ALWAYS AS (
CASE
    WHEN (manual_cash IS NULL) THEN NULL::numeric
    ELSE (manual_cash - (auto_cash - cash_expense))
END) STORED,
    easypaisa_difference numeric(14,2) GENERATED ALWAYS AS (
CASE
    WHEN (manual_easypaisa IS NULL) THEN NULL::numeric
    ELSE (manual_easypaisa - auto_easypaisa)
END) STORED,
    bank_difference numeric(14,2) GENERATED ALWAYS AS (
CASE
    WHEN (manual_bank IS NULL) THEN NULL::numeric
    ELSE (manual_bank - auto_bank)
END) STORED,
    overall_difference numeric(14,2) GENERATED ALWAYS AS (((COALESCE(
CASE
    WHEN (manual_cash IS NULL) THEN NULL::numeric
    ELSE (manual_cash - (auto_cash - cash_expense))
END, (0)::numeric) + COALESCE(
CASE
    WHEN (manual_easypaisa IS NULL) THEN NULL::numeric
    ELSE (manual_easypaisa - auto_easypaisa)
END, (0)::numeric)) + COALESCE(
CASE
    WHEN (manual_bank IS NULL) THEN NULL::numeric
    ELSE (manual_bank - auto_bank)
END, (0)::numeric))) STORED,
    payment_total numeric(14,2) GENERATED ALWAYS AS (((((auto_cash + auto_easypaisa) + auto_foodpanda) + auto_bank) + auto_other)) STORED,
    expected_cash_in_hand numeric(14,2) GENERATED ALWAYS AS ((auto_cash - cash_expense)) STORED,
    status public.daily_sale_record_status DEFAULT 'open'::public.daily_sale_record_status NOT NULL,
    created_by uuid,
    created_by_name text,
    verified_by uuid,
    verified_by_name text,
    verified_at timestamp with time zone,
    locked_by uuid,
    locked_by_name text,
    locked_at timestamp with time zone,
    amended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_sale_records_manual_non_negative CHECK (((COALESCE(manual_cash, (0)::numeric) >= (0)::numeric) AND (COALESCE(manual_easypaisa, (0)::numeric) >= (0)::numeric) AND (COALESCE(manual_bank, (0)::numeric) >= (0)::numeric)))
);


--
-- Name: TABLE daily_sale_records; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.daily_sale_records IS 'Per-branch, per-business-day reconciliation of system sales against physically counted receipts. A reporting layer over orders/expenses — it never modifies them.';


--
-- Name: COLUMN daily_sale_records.cash_difference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daily_sale_records.cash_difference IS 'Counted cash minus CASH ON TABLE (auto_cash - cash_expense) — what should physically be in the drawer, not gross takings. See migration 102.';


--
-- Name: COLUMN daily_sale_records.expected_cash_in_hand; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daily_sale_records.expected_cash_in_hand IS 'Cash on Table: cash taken less cash paid out of the till. The figure cash_difference reconciles against.';


--
-- Name: employee_advances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_advances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    advance_no text DEFAULT app.next_finance_number('finance_advance'::text, 'ADV'::text) NOT NULL,
    employee_id uuid NOT NULL,
    employee_name text NOT NULL,
    department text NOT NULL,
    designation text NOT NULL,
    business_date date NOT NULL,
    advance_amount numeric(14,2) DEFAULT 0 NOT NULL,
    bonus_amount numeric(14,2) DEFAULT 0 NOT NULL,
    loan_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_amount numeric(14,2) NOT NULL,
    payment_method text NOT NULL,
    account public.finance_account NOT NULL,
    status public.finance_doc_status DEFAULT 'pending_approval'::public.finance_doc_status NOT NULL,
    notes text,
    recovered_by_salary_id uuid,
    recovered_at timestamp with time zone,
    created_by uuid,
    created_by_name text,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    ledger_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    CONSTRAINT employee_advances_advance_amount_check CHECK ((advance_amount >= (0)::numeric)),
    CONSTRAINT employee_advances_bonus_amount_check CHECK ((bonus_amount >= (0)::numeric)),
    CONSTRAINT employee_advances_loan_amount_check CHECK ((loan_amount >= (0)::numeric)),
    CONSTRAINT employee_advances_total_amount_check CHECK ((total_amount > (0)::numeric)),
    CONSTRAINT employee_advances_total_matches CHECK ((total_amount = ((advance_amount + bonus_amount) + loan_amount)))
);


--
-- Name: event_branch_demand_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_branch_demand_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    demand_id uuid NOT NULL,
    product_id uuid,
    product_name text NOT NULL,
    qty numeric(14,3) NOT NULL,
    approved_qty numeric(14,3),
    prepared_qty numeric(14,3) DEFAULT 0 NOT NULL,
    unit_price numeric(14,2),
    remarks text,
    line_no integer NOT NULL,
    CONSTRAINT event_branch_demand_items_qty_check CHECK ((qty > (0)::numeric))
);


--
-- Name: event_branch_demands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_branch_demands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    status public.event_demand_status DEFAULT 'draft'::public.event_demand_status NOT NULL,
    expected_customers integer,
    notes text,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    submitted_by_name text,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    reviewed_by_name text,
    review_remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_branches (
    event_id uuid NOT NULL,
    branch_id uuid NOT NULL
);


--
-- Name: event_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    audience public.event_notification_audience NOT NULL,
    branch_id uuid,
    reminder_kind public.event_reminder_kind NOT NULL,
    offset_days smallint NOT NULL,
    scheduled_for date NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    status public.event_notification_status DEFAULT 'pending'::public.event_notification_status NOT NULL,
    in_app_notification_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    claimed_at timestamp with time zone,
    sent_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_production_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_production_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    stage public.event_production_stage NOT NULL,
    completion_percentage smallint DEFAULT 0 NOT NULL,
    remarks text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_by uuid,
    updated_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_production_status_completion_percentage_check CHECK (((completion_percentage >= 0) AND (completion_percentage <= 100)))
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    branch_id uuid NOT NULL,
    branch_name text,
    business_date date NOT NULL,
    description text NOT NULL,
    payment_method public.expense_payment_method NOT NULL,
    amount numeric(14,2) NOT NULL,
    remarks text,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expense_number text DEFAULT public.next_expense_number() NOT NULL,
    category text NOT NULL
);


--
-- Name: finance_amendments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_amendments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    query_no text NOT NULL,
    reference_type text NOT NULL,
    reference_id uuid,
    reference_no text NOT NULL,
    action text NOT NULL,
    field text NOT NULL,
    original_value text,
    new_value text,
    difference numeric(14,2),
    reason text NOT NULL,
    admin_id uuid,
    admin_name text DEFAULT ''::text NOT NULL,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_amendments_action_check CHECK ((action = ANY (ARRAY['edit'::text, 'amend'::text, 'overwrite'::text, 'delete'::text]))),
    CONSTRAINT finance_amendments_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: finance_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity text NOT NULL,
    entity_id uuid,
    entity_ref text,
    action text NOT NULL,
    actor_id uuid,
    actor_name text DEFAULT ''::text NOT NULL,
    actor_role text,
    previous_values jsonb,
    new_values jsonb,
    ip_address text,
    device_info text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_day_closings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_day_closings (
    business_date date NOT NULL,
    opening_balance numeric(14,2) NOT NULL,
    opening_cash numeric(14,2) NOT NULL,
    opening_bank numeric(14,2) NOT NULL,
    total_income numeric(14,2) NOT NULL,
    total_expenses numeric(14,2) NOT NULL,
    net_balance numeric(14,2) NOT NULL,
    cash_in_hand numeric(14,2) NOT NULL,
    bank_balance numeric(14,2) NOT NULL,
    closing_balance numeric(14,2) NOT NULL,
    entry_count integer DEFAULT 0 NOT NULL,
    notes text,
    closed_by uuid,
    closed_by_name text,
    closed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_code text DEFAULT app.next_finance_number('finance_employee'::text, 'EMP'::text) NOT NULL,
    name text NOT NULL,
    department text NOT NULL,
    designation text NOT NULL,
    branch_id uuid,
    branch_name text,
    base_salary numeric(14,2) DEFAULT 0 NOT NULL,
    phone text,
    joined_on date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_income_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_income_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference_no text DEFAULT app.next_finance_number('finance_income'::text, 'INC'::text) NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text NOT NULL,
    business_date date NOT NULL,
    total_amount numeric(14,2) DEFAULT 0 NOT NULL,
    cash_amount numeric(14,2) DEFAULT 0 NOT NULL,
    easypaisa_amount numeric(14,2) DEFAULT 0 NOT NULL,
    foodpanda_amount numeric(14,2) DEFAULT 0 NOT NULL,
    bank_amount numeric(14,2) DEFAULT 0 NOT NULL,
    other_amount numeric(14,2) DEFAULT 0 NOT NULL,
    branch_expenses numeric(14,2) DEFAULT 0 NOT NULL,
    net_amount numeric(14,2) DEFAULT 0 NOT NULL,
    company_share_pct numeric(5,2) NOT NULL,
    branch_share_pct numeric(5,2) NOT NULL,
    company_share numeric(14,2) DEFAULT 0 NOT NULL,
    branch_share numeric(14,2) DEFAULT 0 NOT NULL,
    status public.finance_income_status DEFAULT 'pending_verification'::public.finance_income_status NOT NULL,
    verified_by uuid,
    verified_by_name text,
    verified_at timestamp with time zone,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    notes text,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text
);


--
-- Name: finance_partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    father_name text,
    date_of_birth date,
    joined_on date,
    partner_type text,
    address text,
    contact_number text,
    emergency_number text,
    share_pct numeric(5,2) DEFAULT 25 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_partners_partner_type_check CHECK ((partner_type = ANY (ARRAY['founder'::text, 'co_founder'::text]))),
    CONSTRAINT finance_partners_share_pct_check CHECK (((share_pct > (0)::numeric) AND (share_pct <= (100)::numeric)))
);


--
-- Name: finance_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    query_no text DEFAULT public.next_finance_query_number() NOT NULL,
    business_date date NOT NULL,
    title text NOT NULL,
    amount numeric(14,2) NOT NULL,
    category text NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    type text NOT NULL,
    comment text,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_by_name text,
    CONSTRAINT finance_queries_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT finance_queries_type_check CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])))
);


--
-- Name: finance_query_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_query_counters (
    day date NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: finance_query_year_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_query_year_counters (
    year integer NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: finance_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_settings (
    id boolean DEFAULT true NOT NULL,
    company_share_pct numeric(5,2) DEFAULT 75 NOT NULL,
    branch_share_pct numeric(5,2) DEFAULT 25 NOT NULL,
    share_basis text DEFAULT 'gross'::text NOT NULL,
    opening_cash_balance numeric(14,2) DEFAULT 0 NOT NULL,
    opening_bank_balance numeric(14,2) DEFAULT 0 NOT NULL,
    opening_balance_date date,
    auto_import_branch_income boolean DEFAULT true NOT NULL,
    require_admin_verification boolean DEFAULT true NOT NULL,
    allow_super_admin_write boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL,
    CONSTRAINT finance_settings_id_check CHECK (id),
    CONSTRAINT finance_settings_share_basis_check CHECK ((share_basis = ANY (ARRAY['gross'::text, 'net'::text]))),
    CONSTRAINT finance_shares_sum_100 CHECK ((abs(((company_share_pct + branch_share_pct) - (100)::numeric)) < 0.005))
);


--
-- Name: finance_ticket_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_ticket_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    author_id uuid,
    author_name text DEFAULT ''::text NOT NULL,
    author_role text,
    author_side text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_ticket_messages_body_check CHECK ((length(btrim(body)) > 0)),
    CONSTRAINT finance_ticket_messages_side_check CHECK ((author_side = ANY (ARRAY['finance'::text, 'admin'::text])))
);


--
-- Name: finance_ticket_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_ticket_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    query_no text NOT NULL,
    version integer NOT NULL,
    action text NOT NULL,
    changed_by uuid,
    changed_by_name text DEFAULT ''::text NOT NULL,
    changed_by_role text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    snapshot jsonb NOT NULL,
    CONSTRAINT finance_ticket_versions_action_check CHECK ((action = ANY (ARRAY['created'::text, 'submitted'::text, 'edited'::text, 'amended'::text, 'status_changed'::text, 'assigned'::text, 'responded'::text, 'resolved'::text, 'reopened'::text, 'deleted'::text, 'restored'::text, 'recreated'::text, 'record_corrected'::text]))),
    CONSTRAINT finance_ticket_versions_changes_check CHECK ((jsonb_typeof(changes) = 'array'::text)),
    CONSTRAINT finance_ticket_versions_version_check CHECK ((version >= 1))
);


--
-- Name: finance_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_no text DEFAULT app.next_finance_number('finance_ticket'::text, 'FQ'::text) NOT NULL,
    reference_type text,
    reference_id uuid,
    reference_no text,
    reference_snapshot jsonb,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution_note text,
    raised_by uuid,
    raised_by_name text DEFAULT ''::text NOT NULL,
    raised_by_role text,
    resolved_by uuid,
    resolved_by_name text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    query_no text DEFAULT app.next_finance_query_no() NOT NULL,
    query_type text DEFAULT 'other'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    voucher_ref text,
    admin_response text,
    responded_by uuid,
    responded_by_name text,
    responded_at timestamp with time zone,
    assigned_to uuid,
    assigned_to_name text,
    assigned_at timestamp with time zone,
    information_received_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    resolution_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    reopen_count integer DEFAULT 0 NOT NULL,
    reopened_at timestamp with time zone,
    reopened_by uuid,
    reopened_by_name text,
    reopen_reason text,
    resolution_type text,
    internal_note text,
    amount numeric(14,2),
    branch_id uuid,
    branch_name text,
    business_date date,
    remarks text,
    transaction_ref text,
    expense_ref text,
    income_ref text,
    resolution_amount numeric(14,2),
    version integer DEFAULT 1 NOT NULL,
    submitted_at timestamp with time zone,
    amend_count integer DEFAULT 0 NOT NULL,
    amended_at timestamp with time zone,
    amended_by uuid,
    amended_by_name text,
    recreated_from_id uuid,
    recreated_from_query_no text,
    recreated_as_id uuid,
    recreated_as_query_no text,
    restored_at timestamp with time zone,
    restored_by uuid,
    restored_by_name text,
    restore_reason text,
    CONSTRAINT finance_tickets_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT finance_tickets_draft_check CHECK ((((status = 'draft'::text) AND (submitted_at IS NULL)) OR ((status <> 'draft'::text) AND (submitted_at IS NOT NULL)))),
    CONSTRAINT finance_tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT finance_tickets_query_type_check CHECK ((query_type = ANY (ARRAY['income'::text, 'expense'::text, 'company_transaction'::text, 'partner_advance'::text, 'company_share'::text, 'branch_share'::text, 'salary'::text, 'ledger'::text, 'payment'::text, 'stock_finance_difference'::text, 'calculation_issue'::text, 'other'::text]))),
    CONSTRAINT finance_tickets_reference_type_check CHECK ((reference_type = ANY (ARRAY['ledger_entry'::text, 'income_approval'::text, 'finance_transaction'::text, 'salary_payment'::text, 'employee_advance'::text, 'partner_expense'::text, 'branch_share_payment'::text, 'order'::text, 'cash_transfer'::text]))),
    CONSTRAINT finance_tickets_reopen_check CHECK ((((reopen_count = 0) AND (reopened_at IS NULL) AND (reopened_by_name IS NULL) AND (reopen_reason IS NULL)) OR ((reopen_count > 0) AND (reopened_at IS NOT NULL) AND (reopened_by_name IS NOT NULL) AND (length(btrim(reopen_reason)) > 0)))),
    CONSTRAINT finance_tickets_resolution_amount_check CHECK (((resolution_amount IS NULL) OR (resolution_amount >= (0)::numeric))),
    CONSTRAINT finance_tickets_resolution_check CHECK ((((status = ANY (ARRAY['draft'::text, 'open'::text, 'under_review'::text, 'waiting_for_finance'::text, 'amended'::text, 'reopened'::text])) AND (resolved_by IS NULL) AND (resolved_at IS NULL)) OR ((status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'closed'::text])) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT finance_tickets_resolution_history_check CHECK ((jsonb_typeof(resolution_history) = 'array'::text)),
    CONSTRAINT finance_tickets_resolution_type_check CHECK (((resolution_type IS NULL) OR (resolution_type = ANY (ARRAY['fixed'::text, 'information_provided'::text, 'rejected'::text, 'duplicate'::text, 'other'::text])))),
    CONSTRAINT finance_tickets_resolution_type_live_check CHECK (((resolution_type IS NULL) OR (status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'closed'::text])))),
    CONSTRAINT finance_tickets_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'under_review'::text, 'waiting_for_finance'::text, 'amended'::text, 'reopened'::text, 'resolved'::text, 'rejected'::text, 'closed'::text]))),
    CONSTRAINT finance_tickets_version_check CHECK ((version >= 1))
);


--
-- Name: finance_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    txn_no text DEFAULT app.next_finance_number('finance_txn'::text, 'FTX'::text) NOT NULL,
    txn_type public.ledger_head_type NOT NULL,
    ledger_head_id uuid NOT NULL,
    ledger_head_name text NOT NULL,
    branch_id uuid,
    branch_name text,
    description text NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_method text NOT NULL,
    account public.finance_account NOT NULL,
    business_date date NOT NULL,
    status public.finance_doc_status DEFAULT 'pending_approval'::public.finance_doc_status NOT NULL,
    reference_no text,
    notes text,
    created_by uuid,
    created_by_name text,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    ledger_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    CONSTRAINT finance_transactions_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: geofence_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geofence_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid,
    branch_name text,
    user_id uuid,
    user_name text,
    user_role public.user_role,
    action text NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    accuracy_m integer,
    distance_km numeric(10,3),
    radius_km numeric(6,2),
    outcome text NOT NULL,
    allowed boolean NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geofence_logs_outcome_known CHECK ((outcome = ANY (ARRAY['allowed'::text, 'blocked'::text, 'no_position'::text, 'inaccurate'::text, 'stale'::text, 'not_configured'::text, 'disabled'::text, 'exempt'::text])))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    user_id uuid NOT NULL,
    key text NOT NULL,
    endpoint text NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text])))
);


--
-- Name: TABLE idempotency_keys; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.idempotency_keys IS 'Replay protection for client-supplied Idempotency-Key headers on offline-capable writes. Claimed before the handler runs, completed with the response the handler produced, released when the request had no side effect to protect.';


--
-- Name: ledger_entries_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ledger_entries_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ledger_entries_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ledger_entries_seq_seq OWNED BY public.ledger_entries.seq;


--
-- Name: ledger_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_heads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    type public.ledger_head_type NOT NULL,
    description text,
    group_name text,
    is_active boolean DEFAULT true NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    reason text NOT NULL,
    ip_address text,
    user_agent text,
    browser text,
    browser_version text,
    os text,
    os_version text,
    device_type text,
    country text,
    country_code text,
    city text,
    region text,
    timezone text,
    location_source text DEFAULT 'UNKNOWN'::text NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT login_attempts_location_source_known CHECK ((location_source = ANY (ARRAY['IP'::text, 'DEVICE_GPS'::text, 'UNKNOWN'::text]))),
    CONSTRAINT login_attempts_reason_known CHECK ((reason = ANY (ARRAY['invalid_credentials'::text, 'account_disabled'::text, 'email_not_confirmed'::text, 'rate_limited'::text, 'no_role'::text, 'invalid_session'::text, 'expired_token'::text, 'unknown'::text])))
);


--
-- Name: TABLE login_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.login_attempts IS 'Failed sign-in attempts: the address that was typed, why it was refused, and the IP, resolved city and parsed browser it came from. Reported by the client because a static-export app authenticates against Supabase directly and the API never sees the failure — and therefore forgeable, which is why it is evidence for a person and never an input to a lockout. Never contains a password, a hash of one, or any other credential material.';


--
-- Name: login_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    user_email text,
    user_name text,
    user_role public.user_role,
    branch_id uuid,
    branch_name text,
    ip_address text,
    user_agent text,
    country text,
    country_code text,
    city text,
    region text,
    login_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_code text,
    auth_session_id uuid,
    browser text,
    browser_version text,
    os text,
    os_version text,
    device_type text,
    timezone text,
    is_suspicious boolean DEFAULT false NOT NULL,
    suspicious_reason text,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoked_by_name text,
    revoke_reason text,
    location_source text DEFAULT 'UNKNOWN'::text NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    screen_size text,
    device_name text,
    browser_email text,
    area text,
    CONSTRAINT login_sessions_end_reason_known CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['logout'::text, 'expired'::text, 'revoked'::text, 'reauth'::text])))),
    CONSTRAINT login_sessions_location_source_known CHECK ((location_source = ANY (ARRAY['IP'::text, 'DEVICE_GPS'::text, 'UNKNOWN'::text]))),
    CONSTRAINT login_sessions_revocation_complete CHECK ((((revoked_at IS NULL) AND (revoked_by_name IS NULL)) OR ((revoked_at IS NOT NULL) AND (revoked_by_name IS NOT NULL))))
);


--
-- Name: TABLE login_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.login_sessions IS 'Login history and active sessions: who signed in, from which IP, resolved city and parsed browser, how long it lasted, whether it looked unusual, and who revoked it. Opened, pinged and closed by the client because a static-export app signs in to Supabase directly and the API never sees the login. Evidence for a human and a handle for an admin — never an authorisation input.';


--
-- Name: COLUMN login_sessions.auth_session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.auth_session_id IS 'The GoTrue session this row describes (`session_id` claim, read off the verified access token). The handle revoke_auth_session() deletes by. Null for sessions opened before migration 98.';


--
-- Name: COLUMN login_sessions.device_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.device_type IS 'desktop | mobile | tablet | bot | unknown. Parsed from user_agent at insert; the raw string is kept alongside because this is a guess.';


--
-- Name: COLUMN login_sessions.location_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.location_source IS 'IP | DEVICE_GPS | UNKNOWN — how country/city/latitude/longitude were obtained. IP is a guess about a network, accurate to a city at best and regularly wrong by a country. Read this before presenting the coordinates as a place a person was.';


--
-- Name: COLUMN login_sessions.latitude; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.latitude IS 'Centroid of whatever `location_source` resolved. For source=IP this is the middle of a city or a network block, NOT where anybody was standing.';


--
-- Name: COLUMN login_sessions.screen_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.screen_size IS 'Screen dimensions as the browser reported them, e.g. 1920x1080. Client-reported and therefore forgeable; shown as evidence, never used in a decision.';


--
-- Name: COLUMN login_sessions.device_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.device_name IS 'Device model where the user agent carries one (mostly Android), null otherwise. A guess read from an untrusted string, like every other parsed device column.';


--
-- Name: COLUMN login_sessions.browser_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.browser_email IS 'Verified Google account the session signed in with, read server-side from the authenticated identities when the session was opened through OAuth. Null for a password login or when no Google identity is verified. Distinct from user_email (the Mountain Bakes account) and never copied from it.';


--
-- Name: COLUMN login_sessions.area; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.login_sessions.area IS 'Neighbourhood / suburb from reverse-geocoding the device position (Manzoor Colony). Set only with location_source = DEVICE_GPS; null for an IP-resolved row, which knows the city at best.';


--
-- Name: notification_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid,
    recipient_id uuid,
    business_date date,
    channel text NOT NULL,
    status public.notification_delivery_status DEFAULT 'pending'::public.notification_delivery_status NOT NULL,
    provider text,
    provider_message_id text,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    order_id uuid,
    event_notification_id uuid,
    CONSTRAINT notification_logs_target_ck CHECK ((((order_id IS NOT NULL) AND (report_id IS NULL) AND (recipient_id IS NULL)) OR (order_id IS NULL)))
);


--
-- Name: COLUMN notification_logs.order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_logs.order_id IS 'Set for order-confirmation sends; null for daily-closing summaries (which use report_id + recipient_id instead).';


--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_reads (
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_reads REPLICA IDENTITY FULL;


--
-- Name: notification_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid,
    department text,
    recipient_name text NOT NULL,
    mobile_number text NOT NULL,
    channel public.notification_channel DEFAULT 'whatsapp'::public.notification_channel NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_recipients_scope_ck CHECK (((branch_id IS NOT NULL) <> (department IS NOT NULL)))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    type public.notification_type NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    target_user_id uuid,
    target_role public.user_role,
    branch_id uuid,
    related_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_target_present CHECK (((target_user_id IS NOT NULL) OR (target_role IS NOT NULL)))
);

ALTER TABLE ONLY public.notifications REPLICA IDENTITY FULL;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid,
    product_name text NOT NULL,
    category_id uuid,
    category_name text,
    unit_price numeric(14,2) NOT NULL,
    qty numeric(14,3) NOT NULL,
    discount numeric(14,2) DEFAULT 0 NOT NULL,
    line_total numeric(14,2) NOT NULL,
    line_no integer NOT NULL,
    CONSTRAINT order_items_qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    order_number text NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    customer_id uuid,
    customer_name text,
    customer_phone text,
    customer_address text,
    subtotal numeric(14,2) NOT NULL,
    discount_total numeric(14,2) DEFAULT 0 NOT NULL,
    delivery_charges numeric(14,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(6,3) DEFAULT 0 NOT NULL,
    tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    grand_total numeric(14,2) NOT NULL,
    payment_method public.payment_method NOT NULL,
    status public.order_status DEFAULT 'pending'::public.order_status NOT NULL,
    notes text,
    received_cash numeric(14,2),
    cash_returned numeric(14,2),
    created_by uuid,
    created_by_name text,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: packing_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packing_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    category text,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_no text DEFAULT app.next_finance_number('finance_partner'::text, 'PEX'::text) NOT NULL,
    partner_name text NOT NULL,
    ledger_head_id uuid NOT NULL,
    ledger_head_name text NOT NULL,
    description text NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_method text NOT NULL,
    account public.finance_account NOT NULL,
    business_date date NOT NULL,
    status public.finance_doc_status DEFAULT 'pending_approval'::public.finance_doc_status NOT NULL,
    requested_by uuid,
    requested_by_name text DEFAULT ''::text NOT NULL,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    notes text,
    ledger_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    partner_id uuid,
    txn_kind text DEFAULT 'draw'::text NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    CONSTRAINT partner_expenses_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT partner_expenses_txn_kind_check CHECK ((txn_kind = ANY (ARRAY['advance'::text, 'draw'::text])))
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: TABLE password_reset_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.password_reset_tokens IS 'Single-use password reset links, stored as SHA-256 of the token in the link.';


--
-- Name: payment_method_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_method_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    payment_method public.payment_method NOT NULL,
    is_locked boolean NOT NULL,
    updated_by uuid,
    updated_by_name text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE payment_method_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_method_settings IS 'Per-branch lock configuration for manual payment entry on Daily Sale Records. An absent row means the shared default (see DAILY_SALE_MANUAL_METHODS).';


--
-- Name: price_activation_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_activation_locks (
    business_date date NOT NULL,
    status public.closure_status NOT NULL,
    trigger public.closure_trigger NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    activated integer,
    closed_at timestamp with time zone,
    error text
);


--
-- Name: product_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_price_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    product_id uuid NOT NULL,
    product_code text,
    product_name text NOT NULL,
    category_name text,
    old_price numeric(14,2),
    new_price numeric(14,2) NOT NULL,
    effective_date date NOT NULL,
    reason text,
    source public.price_change_source NOT NULL,
    status public.price_change_status NOT NULL,
    version_number integer NOT NULL,
    changed_by uuid,
    changed_by_name text,
    changed_on timestamp with time zone DEFAULT now() NOT NULL,
    activated_on timestamp with time zone,
    batch_id uuid,
    price_number text DEFAULT public.next_price_number() NOT NULL,
    CONSTRAINT product_price_history_version_positive CHECK ((version_number > 0))
);


--
-- Name: production_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    product_id uuid NOT NULL,
    product_name text,
    pending_qty numeric(14,3) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT production_balances_non_negative CHECK ((pending_qty >= (0)::numeric))
);


--
-- Name: TABLE production_balances; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.production_balances IS 'DEPRECATED as of migration 74. The pending-balance carry-forward was removed: a demand is now the fresh demand only. Nothing writes this table any more and every row was zeroed by that migration. Reads are retained so the outstanding route, the daily-closing snapshot and the production report keep working; they now report zero. Do not reintroduce writes without reading migration 74.';


--
-- Name: production_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    production_order_id uuid NOT NULL,
    product_id uuid,
    product_name text NOT NULL,
    qty numeric(14,3) NOT NULL,
    remarks text,
    previous_balance_qty numeric(14,3),
    total_required_qty numeric(14,3),
    approved_qty numeric(14,3),
    remaining_balance_qty numeric(14,3),
    line_no integer NOT NULL,
    is_special boolean DEFAULT false NOT NULL,
    added_by_production boolean DEFAULT false NOT NULL,
    unit_price numeric(14,2)
);


--
-- Name: COLUMN production_order_items.previous_balance_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_order_items.previous_balance_qty IS 'Always 0 for orders reviewed from migration 74 onward. Historical orders keep the real carry-forward figure that was frozen onto them at review time.';


--
-- Name: COLUMN production_order_items.total_required_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_order_items.total_required_qty IS 'Equals qty (the fresh demand) from migration 74 onward. Historical orders keep previous_balance_qty + qty, which is what was actually approved against.';


--
-- Name: COLUMN production_order_items.added_by_production; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_order_items.added_by_production IS 'True when this line was added by Production or found at verification rather than demanded by the branch. Its qty still carries the intended quantity and is still the approval default; this only tells the screens not to report that quantity as branch demand.';


--
-- Name: COLUMN production_order_items.unit_price; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_order_items.unit_price IS 'The Admin product price AS AT submission. Snapshotted server-side; never accepted from a client. A later price change must not move this figure — the order stays worth what it was worth.';


--
-- Name: production_order_packing_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_order_packing_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    production_order_id uuid NOT NULL,
    packing_material_id uuid,
    material_name text NOT NULL,
    qty numeric(14,3) NOT NULL,
    approved_qty numeric(14,3),
    line_no integer NOT NULL
);


--
-- Name: production_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    branch_id uuid NOT NULL,
    branch_name text,
    business_date date NOT NULL,
    submitted_time text,
    status public.branch_production_order_status DEFAULT 'pending'::public.branch_production_order_status NOT NULL,
    created_by uuid,
    created_by_name text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    was_changed boolean DEFAULT false NOT NULL,
    change_reason text,
    printed boolean DEFAULT false NOT NULL,
    printed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    demand_number text DEFAULT public.next_demand_number() NOT NULL,
    verified_by uuid,
    verified_by_name text,
    verified_at timestamp with time zone,
    cancel_reason text,
    cancelled_by uuid,
    cancelled_by_name text,
    cancelled_at timestamp with time zone,
    required_date date
);


--
-- Name: COLUMN production_orders.cancel_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_orders.cancel_reason IS 'Why the branch withdrew this demand. Mandatory at cancellation; null on every other order.';


--
-- Name: COLUMN production_orders.required_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_orders.required_date IS 'Date the branch needs this demand delivered by, chosen on the order form. NULL only on demands raised before the field existed; required for every new demand. Distinct from business_date, which is the day the demand was raised.';


--
-- Name: production_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    branch_id uuid NOT NULL,
    branch_name text,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    qty numeric(14,3) NOT NULL,
    reason text,
    status public.production_return_status DEFAULT 'pending'::public.production_return_status NOT NULL,
    source text,
    business_date date NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by uuid,
    reviewed_by_name text,
    reviewed_at timestamp with time zone,
    disposition public.production_return_disposition DEFAULT 'saleable'::public.production_return_disposition NOT NULL,
    disposition_note text,
    photo_attachment_id uuid,
    CONSTRAINT production_returns_qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: COLUMN production_returns.disposition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_returns.disposition IS 'What happened to the goods, independent of whether the return was accepted. saleable → credited to the pool; damaged/expired → received then written off, so the units never become sellable stock.';


--
-- Name: production_stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_stock (
    product_id uuid NOT NULL,
    product_name text,
    balance numeric(14,3) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: production_stock_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_stock_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    type public.production_stock_movement_type NOT NULL,
    delta numeric(14,3) NOT NULL,
    balance_after numeric(14,3) NOT NULL,
    ref_id text NOT NULL,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    branch_id uuid,
    production_order_id uuid,
    created_by uuid,
    created_by_name text,
    reason text,
    remarks text,
    transaction_no text,
    metadata jsonb
);


--
-- Name: COLUMN production_stock_history.branch_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_stock_history.branch_id IS 'Which branch the movement was FOR: the receiving branch on a transfer_out, the returning branch on a return_in. NULL on prepare/sale/adjustment, which are pool-level and belong to no branch.';


--
-- Name: COLUMN production_stock_history.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_stock_history.reason IS 'Required on adjustment (enforced in apply_production_stock_adjustment). Free text on everything else.';


--
-- Name: COLUMN production_stock_history.transaction_no; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.production_stock_history.transaction_no IS 'Human-readable ledger reference, STK-YYYYMMDD-NNNNNN. What someone quotes on a query. The uuid id stays the key.';


--
-- Name: production_stock_txn_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.production_stock_txn_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    name text NOT NULL,
    category_id uuid,
    category_name text,
    sku text,
    price numeric(14,2) DEFAULT 0 NOT NULL,
    cost_price numeric(14,2),
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stock_code text DEFAULT public.next_stock_number() NOT NULL,
    is_special boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN products.is_special; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.is_special IS 'Auto-created to carry a branch special order item. Real and active (so stock works) but hidden from the order catalogue, price list and POS.';


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.user_role NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: restriction_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restriction_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_no text DEFAULT app.next_finance_number('restriction_event'::text, 'RE'::text) NOT NULL,
    rule_code text NOT NULL,
    branch_id uuid,
    branch_name text,
    user_id uuid,
    user_name text,
    ref text,
    current_value text,
    threshold text,
    action text NOT NULL,
    result text NOT NULL,
    approval_no text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE restriction_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.restriction_events IS 'Append-only audit of restriction rules firing, being requested, decided and reconfigured.';


--
-- Name: restriction_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restriction_rules (
    group_key text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_by_name text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT restriction_rules_group_check CHECK ((group_key = ANY (ARRAY['demand'::text, 'sales'::text, 'production'::text, 'cash'::text, 'ledger'::text, 'company'::text])))
);


--
-- Name: TABLE restriction_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.restriction_rules IS 'Admin Settings → Restriction Rules. One jsonb config per group; merged over DEFAULT_RESTRICTION_RULES by the API.';


--
-- Name: return_stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.return_stock (
    product_id uuid NOT NULL,
    product_name text,
    balance numeric(14,3) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT return_stock_balance_non_negative CHECK ((balance >= (0)::numeric))
);


--
-- Name: return_stock_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.return_stock_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    type public.return_stock_movement_type NOT NULL,
    delta numeric(14,3) NOT NULL,
    balance_after numeric(14,3) NOT NULL,
    ref_id text NOT NULL,
    business_date date NOT NULL,
    branch_id uuid,
    production_return_id uuid,
    created_by uuid,
    created_by_name text,
    reason text,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: salary_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salary_no text DEFAULT app.next_finance_number('finance_salary'::text, 'SAL'::text) NOT NULL,
    employee_id uuid NOT NULL,
    employee_name text NOT NULL,
    department text NOT NULL,
    designation text NOT NULL,
    salary_month text NOT NULL,
    gross_salary numeric(14,2) NOT NULL,
    bonus numeric(14,2) DEFAULT 0 NOT NULL,
    deductions numeric(14,2) DEFAULT 0 NOT NULL,
    net_salary numeric(14,2) NOT NULL,
    payment_date date,
    payment_method text NOT NULL,
    account public.finance_account NOT NULL,
    status public.finance_doc_status DEFAULT 'pending_approval'::public.finance_doc_status NOT NULL,
    notes text,
    created_by uuid,
    created_by_name text,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    rejection_reason text,
    ledger_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deleted_by_name text,
    delete_reason text,
    deleted_query_id uuid,
    deleted_query_no text,
    CONSTRAINT salary_payments_bonus_check CHECK ((bonus >= (0)::numeric)),
    CONSTRAINT salary_payments_deductions_check CHECK ((deductions >= (0)::numeric)),
    CONSTRAINT salary_payments_gross_salary_check CHECK ((gross_salary >= (0)::numeric)),
    CONSTRAINT salary_payments_net_salary_check CHECK ((net_salary > (0)::numeric)),
    CONSTRAINT salary_payments_salary_month_check CHECK ((salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text))
);


--
-- Name: salary_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    employee_name text NOT NULL,
    previous_salary numeric(14,2) NOT NULL,
    new_salary numeric(14,2) NOT NULL,
    reason text NOT NULL,
    effective_from date NOT NULL,
    changed_by uuid,
    changed_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT salary_revisions_new_salary_check CHECK ((new_salary >= (0)::numeric))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id boolean DEFAULT true NOT NULL,
    company_name text,
    logo_url text,
    logo_path text,
    currency text DEFAULT 'PKR'::text NOT NULL,
    currency_symbol text DEFAULT 'Rs'::text NOT NULL,
    gst_rate numeric(6,3) DEFAULT 0 NOT NULL,
    gst_enabled boolean DEFAULT false NOT NULL,
    receipt_footer text,
    theme public.app_theme DEFAULT 'light'::public.app_theme NOT NULL,
    business_start_time text,
    business_closing_time text,
    order_start_time text,
    order_end_time text,
    auto_close_business boolean DEFAULT true NOT NULL,
    auto_stock_closing boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    closing_notifications_enabled boolean DEFAULT false NOT NULL,
    order_confirmations_enabled boolean DEFAULT false NOT NULL,
    event_notifications_enabled boolean DEFAULT false NOT NULL,
    geofencing_enabled boolean DEFAULT false NOT NULL,
    geofence_default_radius_km numeric(6,2) DEFAULT 50 NOT NULL,
    geofence_verify_interval_min integer DEFAULT 5 NOT NULL,
    geofence_require_high_accuracy boolean DEFAULT true NOT NULL,
    geofence_gps_timeout_sec integer DEFAULT 20 NOT NULL,
    geofence_max_position_age_sec integer DEFAULT 300 NOT NULL,
    CONSTRAINT settings_singleton CHECK (id)
);


--
-- Name: special_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.special_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_number text DEFAULT public.next_event_number() NOT NULL,
    series_code text NOT NULL,
    event_year integer NOT NULL,
    name text NOT NULL,
    description text,
    category public.event_category NOT NULL,
    event_type text,
    calendar_system public.event_calendar_system DEFAULT 'gregorian'::public.event_calendar_system NOT NULL,
    hijri_month smallint,
    hijri_day smallint,
    gregorian_month smallint,
    gregorian_day smallint,
    nth_weekday smallint,
    weekday smallint,
    is_recurring boolean DEFAULT true NOT NULL,
    estimated_date date,
    confirmed_date date,
    duration_days smallint DEFAULT 1 NOT NULL,
    event_date date GENERATED ALWAYS AS (COALESCE(confirmed_date, estimated_date)) STORED,
    event_end_date date GENERATED ALWAYS AS ((COALESCE(confirmed_date, estimated_date) + (duration_days - 1))) STORED,
    demand_due_date date,
    demand_lead_days smallint DEFAULT 10 NOT NULL,
    preparation_start_date date,
    status public.event_status DEFAULT 'upcoming'::public.event_status NOT NULL,
    priority public.event_priority DEFAULT 'normal'::public.event_priority NOT NULL,
    applies_to_all_branches boolean DEFAULT true NOT NULL,
    color text,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    occurrence_index smallint DEFAULT 1 NOT NULL,
    reminder_lead_days smallint DEFAULT 14 NOT NULL,
    anchor_offset_days smallint DEFAULT 0 NOT NULL,
    CONSTRAINT special_events_anchor_ck CHECK ((((NOT is_recurring) AND (confirmed_date IS NOT NULL)) OR ((calendar_system = 'hijri'::public.event_calendar_system) AND (hijri_month IS NOT NULL) AND (hijri_day IS NOT NULL)) OR ((calendar_system = 'gregorian'::public.event_calendar_system) AND (gregorian_month IS NOT NULL) AND (gregorian_day IS NOT NULL)) OR ((calendar_system = 'gregorian_nth_weekday'::public.event_calendar_system) AND (gregorian_month IS NOT NULL) AND (nth_weekday IS NOT NULL) AND (weekday IS NOT NULL)) OR ((calendar_system = 'hijri_last_weekday'::public.event_calendar_system) AND (hijri_month IS NOT NULL) AND (weekday IS NOT NULL)))),
    CONSTRAINT special_events_anchor_offset_days_check CHECK (((anchor_offset_days >= '-30'::integer) AND (anchor_offset_days <= 30))),
    CONSTRAINT special_events_demand_lead_days_check CHECK ((demand_lead_days >= 0)),
    CONSTRAINT special_events_duration_days_check CHECK ((duration_days >= 1)),
    CONSTRAINT special_events_gregorian_day_check CHECK (((gregorian_day >= 1) AND (gregorian_day <= 31))),
    CONSTRAINT special_events_gregorian_month_check CHECK (((gregorian_month >= 1) AND (gregorian_month <= 12))),
    CONSTRAINT special_events_hijri_day_check CHECK (((hijri_day >= 1) AND (hijri_day <= 30))),
    CONSTRAINT special_events_hijri_month_check CHECK (((hijri_month >= 1) AND (hijri_month <= 12))),
    CONSTRAINT special_events_nth_weekday_check CHECK (((nth_weekday >= 1) AND (nth_weekday <= 5))),
    CONSTRAINT special_events_occurrence_index_check CHECK (((occurrence_index >= 1) AND (occurrence_index <= 2))),
    CONSTRAINT special_events_reminder_lead_days_check CHECK (((reminder_lead_days >= 1) AND (reminder_lead_days <= 120))),
    CONSTRAINT special_events_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);


--
-- Name: special_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.special_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    special_order_id uuid NOT NULL,
    product_id uuid NOT NULL,
    item_name text NOT NULL,
    qty numeric(14,3) NOT NULL,
    amount numeric(14,2) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    line_no integer NOT NULL,
    stock_movement_id uuid,
    stock_transaction_no text,
    prepared_qty numeric(14,3),
    verified_qty numeric(14,3),
    CONSTRAINT special_order_items_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT special_order_items_prepared_qty_check CHECK ((prepared_qty >= (0)::numeric)),
    CONSTRAINT special_order_items_qty_check CHECK ((qty > (0)::numeric)),
    CONSTRAINT special_order_items_verified_qty_check CHECK ((verified_qty >= (0)::numeric))
);


--
-- Name: COLUMN special_order_items.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.special_order_items.amount IS 'Agreed amount for the whole row as entered by the branch. Not a unit price, not from the price list, never used in stock arithmetic.';


--
-- Name: COLUMN special_order_items.prepared_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.special_order_items.prepared_qty IS 'What Production actually prepared — the quantity added to Production Stock. NULL until prepared. Never written over qty.';


--
-- Name: COLUMN special_order_items.verified_qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.special_order_items.verified_qty IS 'What the branch confirmed receiving — the quantity added to Branch Stock. NULL until verified. Never more than prepared_qty.';


--
-- Name: special_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.special_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number text DEFAULT public.next_special_order_number() NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text,
    business_date date NOT NULL,
    required_date date,
    status public.branch_production_order_status DEFAULT 'pending'::public.branch_production_order_status NOT NULL,
    created_by uuid,
    created_by_name text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    prepared_by uuid,
    prepared_by_name text,
    prepared_at timestamp with time zone,
    verified_by uuid,
    verified_by_name text,
    verified_at timestamp with time zone,
    approved_by uuid,
    approved_by_name text,
    approved_at timestamp with time zone,
    stock_added_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_name text,
    balance numeric(14,3) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    branch_id uuid NOT NULL,
    branch_name text,
    user_id uuid,
    user_name text,
    product_id uuid,
    product_name text NOT NULL,
    requested_qty numeric(14,3) NOT NULL,
    available_qty numeric(14,3) NOT NULL,
    reason text,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    type public.stock_movement_type NOT NULL,
    delta numeric(14,3) NOT NULL,
    balance_after numeric(14,3) NOT NULL,
    ref_id text NOT NULL,
    business_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN stock_history.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stock_history.type IS 'sale | production | return | adjustment. A return is ''return'' regardless of which side recorded it — branch-initiated (commit_branch_return) and Production-accepted (PUT /api/production-returns/:id/review) are the same event. ''adjustment'' means an admin correction (apply_stock_correction, migration 33) and nothing else; see migration 75.';


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_number text DEFAULT public.next_ticket_number() NOT NULL,
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    reference_snapshot jsonb,
    message text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution_note text,
    branch_id uuid,
    branch_name text,
    raised_by uuid,
    raised_by_name text,
    raised_by_role text,
    resolved_by uuid,
    resolved_by_name text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    archived_by_name text
);


--
-- Name: COLUMN support_tickets.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_tickets.archived_at IS 'Set when an admin archives the query from the Support Center. NULL = live. Archived rows are hidden from the default list but never deleted -- the ticket is the audit anchor for any correction applied from it (stock_history.ref_id is ''<ticket_id>:stock:<uuid>''). See migration 76.';


--
-- Name: user_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_credentials (
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    password_changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE user_credentials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_credentials IS 'One bcrypt password hash per user, for the API''s own sign-in. Separate from users so that no query for a user row can return it.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text,
    phone text,
    username text,
    role public.user_role NOT NULL,
    branch_id uuid,
    branch_name text,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    last_login_at timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL,
    last_password_reset timestamp with time zone,
    password_reset_by uuid,
    password_reset_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_code text DEFAULT public.next_user_number() NOT NULL,
    CONSTRAINT users_no_branch_user CHECK ((role <> 'branch_user'::public.user_role))
);


--
-- Name: COLUMN users.user_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.user_code IS 'Mountain Bakes staff ID, MBU-000125. Human-readable, stable for the life of the account, and the identifier the security screens are read by so an email address does not have to be. Distinct from orders.order_number (MB-######) on purpose.';


--
-- Name: CONSTRAINT users_no_branch_user ON users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT users_no_branch_user ON public.users IS 'Shift accounts were removed by migration 122. The user_role enum keeps the value only because Postgres cannot drop it.';


--
-- Name: ledger_entries seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries ALTER COLUMN seq SET DEFAULT nextval('public.ledger_entries_seq_seq'::regclass);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_storage_path_key UNIQUE (storage_path);


--
-- Name: audit_logs audit_logs_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_legacy_id_key UNIQUE (legacy_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_tokens auth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: backup_jobs backup_jobs_backup_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_backup_id_key UNIQUE (backup_id);


--
-- Name: backup_jobs backup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_pkey PRIMARY KEY (id);


--
-- Name: backup_restore_tests backup_restore_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_restore_tests
    ADD CONSTRAINT backup_restore_tests_pkey PRIMARY KEY (id);


--
-- Name: branch_discounts branch_discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_discounts
    ADD CONSTRAINT branch_discounts_pkey PRIMARY KEY (id);


--
-- Name: branch_locations branch_locations_branch_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_locations
    ADD CONSTRAINT branch_locations_branch_unique UNIQUE (branch_id);


--
-- Name: branch_locations branch_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_locations
    ADD CONSTRAINT branch_locations_pkey PRIMARY KEY (id);


--
-- Name: branch_share_payments branch_share_payments_payment_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_payment_no_key UNIQUE (payment_no);


--
-- Name: branch_share_payments branch_share_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_pkey PRIMARY KEY (id);


--
-- Name: branches branches_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_legacy_id_key UNIQUE (legacy_id);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: branches branches_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_slug_key UNIQUE (slug);


--
-- Name: business_day_closures business_day_closures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_day_closures
    ADD CONSTRAINT business_day_closures_pkey PRIMARY KEY (business_date);


--
-- Name: cash_transfers cash_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_pkey PRIMARY KEY (id);


--
-- Name: cash_transfers cash_transfers_transfer_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_transfer_no_key UNIQUE (transfer_no);


--
-- Name: categories categories_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_legacy_id_key UNIQUE (legacy_id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: counters counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counters
    ADD CONSTRAINT counters_pkey PRIMARY KEY (id);


--
-- Name: customers customers_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_legacy_id_key UNIQUE (legacy_id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: daily_closing_reports daily_closing_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closing_reports
    ADD CONSTRAINT daily_closing_reports_pkey PRIMARY KEY (id);


--
-- Name: daily_sale_record_audits daily_sale_record_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_record_audits
    ADD CONSTRAINT daily_sale_record_audits_pkey PRIMARY KEY (id);


--
-- Name: daily_sale_records daily_sale_records_branch_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_branch_date_key UNIQUE (branch_id, business_date);


--
-- Name: daily_sale_records daily_sale_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_pkey PRIMARY KEY (id);


--
-- Name: employee_advances employee_advances_advance_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_advance_no_key UNIQUE (advance_no);


--
-- Name: employee_advances employee_advances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_pkey PRIMARY KEY (id);


--
-- Name: event_branch_demand_items event_branch_demand_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demand_items
    ADD CONSTRAINT event_branch_demand_items_pkey PRIMARY KEY (id);


--
-- Name: event_branch_demands event_branch_demands_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_key UNIQUE (event_id, branch_id);


--
-- Name: event_branch_demands event_branch_demands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_pkey PRIMARY KEY (id);


--
-- Name: event_branches event_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branches
    ADD CONSTRAINT event_branches_pkey PRIMARY KEY (event_id, branch_id);


--
-- Name: event_notifications event_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_pkey PRIMARY KEY (id);


--
-- Name: event_production_status event_production_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_production_status
    ADD CONSTRAINT event_production_status_key UNIQUE (event_id, stage);


--
-- Name: event_production_status event_production_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_production_status
    ADD CONSTRAINT event_production_status_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_expense_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_expense_number_key UNIQUE (expense_number);


--
-- Name: expenses expenses_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_legacy_id_key UNIQUE (legacy_id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: finance_amendments finance_amendments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_amendments
    ADD CONSTRAINT finance_amendments_pkey PRIMARY KEY (id);


--
-- Name: finance_audit_logs finance_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_audit_logs
    ADD CONSTRAINT finance_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: finance_day_closings finance_day_closings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_day_closings
    ADD CONSTRAINT finance_day_closings_pkey PRIMARY KEY (business_date);


--
-- Name: finance_employees finance_employees_employee_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_employees
    ADD CONSTRAINT finance_employees_employee_code_key UNIQUE (employee_code);


--
-- Name: finance_employees finance_employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_employees
    ADD CONSTRAINT finance_employees_pkey PRIMARY KEY (id);


--
-- Name: finance_income_approvals finance_income_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_pkey PRIMARY KEY (id);


--
-- Name: finance_income_approvals finance_income_approvals_reference_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_reference_no_key UNIQUE (reference_no);


--
-- Name: finance_partners finance_partners_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_partners
    ADD CONSTRAINT finance_partners_name_key UNIQUE (name);


--
-- Name: finance_partners finance_partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_partners
    ADD CONSTRAINT finance_partners_pkey PRIMARY KEY (id);


--
-- Name: finance_queries finance_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_queries
    ADD CONSTRAINT finance_queries_pkey PRIMARY KEY (id);


--
-- Name: finance_queries finance_queries_query_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_queries
    ADD CONSTRAINT finance_queries_query_no_key UNIQUE (query_no);


--
-- Name: finance_query_counters finance_query_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_query_counters
    ADD CONSTRAINT finance_query_counters_pkey PRIMARY KEY (day);


--
-- Name: finance_query_year_counters finance_query_year_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_query_year_counters
    ADD CONSTRAINT finance_query_year_counters_pkey PRIMARY KEY (year);


--
-- Name: finance_settings finance_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_settings
    ADD CONSTRAINT finance_settings_pkey PRIMARY KEY (id);


--
-- Name: finance_ticket_messages finance_ticket_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_messages
    ADD CONSTRAINT finance_ticket_messages_pkey PRIMARY KEY (id);


--
-- Name: finance_ticket_versions finance_ticket_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_versions
    ADD CONSTRAINT finance_ticket_versions_pkey PRIMARY KEY (id);


--
-- Name: finance_ticket_versions finance_ticket_versions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_versions
    ADD CONSTRAINT finance_ticket_versions_unique UNIQUE (ticket_id, version);


--
-- Name: finance_tickets finance_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_pkey PRIMARY KEY (id);


--
-- Name: finance_tickets finance_tickets_ticket_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_ticket_no_key UNIQUE (ticket_no);


--
-- Name: finance_transactions finance_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_pkey PRIMARY KEY (id);


--
-- Name: finance_transactions finance_transactions_txn_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_txn_no_key UNIQUE (txn_no);


--
-- Name: geofence_logs geofence_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_logs
    ADD CONSTRAINT geofence_logs_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, key);


--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: ledger_entries ledger_entries_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_seq_key UNIQUE (seq);


--
-- Name: ledger_entries ledger_entries_voucher_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_voucher_no_key UNIQUE (voucher_no);


--
-- Name: ledger_heads ledger_heads_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_heads
    ADD CONSTRAINT ledger_heads_code_key UNIQUE (code);


--
-- Name: ledger_heads ledger_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_heads
    ADD CONSTRAINT ledger_heads_pkey PRIMARY KEY (id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);


--
-- Name: login_sessions login_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (id);


--
-- Name: notification_logs notification_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (notification_id, user_id);


--
-- Name: notification_recipients notification_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_recipients
    ADD CONSTRAINT notification_recipients_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_legacy_id_key UNIQUE (legacy_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_legacy_id_key UNIQUE (legacy_id);


--
-- Name: orders orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: packing_materials packing_materials_material_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packing_materials
    ADD CONSTRAINT packing_materials_material_code_key UNIQUE (material_code);


--
-- Name: packing_materials packing_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packing_materials
    ADD CONSTRAINT packing_materials_pkey PRIMARY KEY (id);


--
-- Name: partner_expenses partner_expenses_expense_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_expense_no_key UNIQUE (expense_no);


--
-- Name: partner_expenses partner_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: payment_method_settings payment_method_settings_branch_method_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_method_settings
    ADD CONSTRAINT payment_method_settings_branch_method_key UNIQUE (branch_id, payment_method);


--
-- Name: payment_method_settings payment_method_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_method_settings
    ADD CONSTRAINT payment_method_settings_pkey PRIMARY KEY (id);


--
-- Name: price_activation_locks price_activation_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_activation_locks
    ADD CONSTRAINT price_activation_locks_pkey PRIMARY KEY (business_date);


--
-- Name: product_price_history product_price_history_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_legacy_id_key UNIQUE (legacy_id);


--
-- Name: product_price_history product_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_pkey PRIMARY KEY (id);


--
-- Name: product_price_history product_price_history_price_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_price_number_key UNIQUE (price_number);


--
-- Name: product_price_history product_price_history_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_version_key UNIQUE (product_id, version_number);


--
-- Name: production_balances production_balances_branch_product_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_balances
    ADD CONSTRAINT production_balances_branch_product_key UNIQUE (branch_id, product_id);


--
-- Name: production_balances production_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_balances
    ADD CONSTRAINT production_balances_pkey PRIMARY KEY (id);


--
-- Name: production_order_items production_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_items
    ADD CONSTRAINT production_order_items_pkey PRIMARY KEY (id);


--
-- Name: production_order_packing_items production_order_packing_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_packing_items
    ADD CONSTRAINT production_order_packing_items_pkey PRIMARY KEY (id);


--
-- Name: production_order_packing_items production_order_packing_items_unique_material; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_packing_items
    ADD CONSTRAINT production_order_packing_items_unique_material UNIQUE (production_order_id, packing_material_id);


--
-- Name: production_orders production_orders_demand_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_demand_number_key UNIQUE (demand_number);


--
-- Name: production_orders production_orders_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_legacy_id_key UNIQUE (legacy_id);


--
-- Name: production_orders production_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_pkey PRIMARY KEY (id);


--
-- Name: production_returns production_returns_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_legacy_id_key UNIQUE (legacy_id);


--
-- Name: production_returns production_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_pkey PRIMARY KEY (id);


--
-- Name: production_stock_history production_stock_history_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_idempotency_key UNIQUE (ref_id, product_id, type);


--
-- Name: production_stock_history production_stock_history_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_legacy_id_key UNIQUE (legacy_id);


--
-- Name: production_stock_history production_stock_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_pkey PRIMARY KEY (id);


--
-- Name: production_stock production_stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock
    ADD CONSTRAINT production_stock_pkey PRIMARY KEY (product_id);


--
-- Name: products products_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_legacy_id_key UNIQUE (legacy_id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_stock_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_stock_code_key UNIQUE (stock_code);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: restriction_events restriction_events_event_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_events
    ADD CONSTRAINT restriction_events_event_no_key UNIQUE (event_no);


--
-- Name: restriction_events restriction_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_events
    ADD CONSTRAINT restriction_events_pkey PRIMARY KEY (id);


--
-- Name: restriction_requests restriction_requests_approval_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_approval_no_key UNIQUE (approval_no);


--
-- Name: restriction_requests restriction_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_pkey PRIMARY KEY (id);


--
-- Name: restriction_requests restriction_requests_request_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_request_no_key UNIQUE (request_no);


--
-- Name: restriction_rules restriction_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_rules
    ADD CONSTRAINT restriction_rules_pkey PRIMARY KEY (group_key);


--
-- Name: return_stock_history return_stock_history_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_idempotency_key UNIQUE (ref_id, product_id, type);


--
-- Name: return_stock_history return_stock_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_pkey PRIMARY KEY (id);


--
-- Name: return_stock return_stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock
    ADD CONSTRAINT return_stock_pkey PRIMARY KEY (product_id);


--
-- Name: salary_payments salary_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_pkey PRIMARY KEY (id);


--
-- Name: salary_payments salary_payments_salary_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_salary_no_key UNIQUE (salary_no);


--
-- Name: salary_revisions salary_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: special_events special_events_event_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_events
    ADD CONSTRAINT special_events_event_number_key UNIQUE (event_number);


--
-- Name: special_events special_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_events
    ADD CONSTRAINT special_events_pkey PRIMARY KEY (id);


--
-- Name: special_events special_events_series_year_occurrence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_events
    ADD CONSTRAINT special_events_series_year_occurrence_key UNIQUE (series_code, event_year, occurrence_index);


--
-- Name: special_order_items special_order_items_line_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_order_items
    ADD CONSTRAINT special_order_items_line_key UNIQUE (special_order_id, line_no);


--
-- Name: special_order_items special_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_order_items
    ADD CONSTRAINT special_order_items_pkey PRIMARY KEY (id);


--
-- Name: special_orders special_orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_order_number_key UNIQUE (order_number);


--
-- Name: special_orders special_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_pkey PRIMARY KEY (id);


--
-- Name: stock_audit_log stock_audit_log_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audit_log
    ADD CONSTRAINT stock_audit_log_legacy_id_key UNIQUE (legacy_id);


--
-- Name: stock_audit_log stock_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audit_log
    ADD CONSTRAINT stock_audit_log_pkey PRIMARY KEY (id);


--
-- Name: stock stock_branch_product_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_branch_product_key UNIQUE (branch_id, product_id);


--
-- Name: stock_history stock_history_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_history
    ADD CONSTRAINT stock_history_idempotency_key UNIQUE (ref_id, product_id, type);


--
-- Name: stock_history stock_history_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_history
    ADD CONSTRAINT stock_history_legacy_id_key UNIQUE (legacy_id);


--
-- Name: stock_history stock_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_history
    ADD CONSTRAINT stock_history_pkey PRIMARY KEY (id);


--
-- Name: stock stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_ticket_number_key UNIQUE (ticket_number);


--
-- Name: user_credentials user_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credentials
    ADD CONSTRAINT user_credentials_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_user_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_user_code_key UNIQUE (user_code);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: attachments_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_entity_idx ON public.attachments USING btree (entity, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: attachments_orphan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_orphan_idx ON public.attachments USING btree (created_at) WHERE (entity_id IS NULL);


--
-- Name: audit_logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_created_idx ON public.audit_logs USING btree (created_at DESC);


--
-- Name: audit_logs_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_target_idx ON public.audit_logs USING btree (target_user_id) WHERE (target_user_id IS NOT NULL);


--
-- Name: auth_refresh_tokens_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_refresh_tokens_session_idx ON public.auth_refresh_tokens USING btree (session_id);


--
-- Name: auth_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_expires_at_idx ON public.auth_sessions USING btree (expires_at);


--
-- Name: auth_sessions_user_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_live_idx ON public.auth_sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: backup_jobs_one_running_per_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX backup_jobs_one_running_per_type ON public.backup_jobs USING btree (backup_type) WHERE (status = 'running'::text);


--
-- Name: backup_jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_status_idx ON public.backup_jobs USING btree (status, started_at DESC);


--
-- Name: backup_jobs_type_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_type_started_idx ON public.backup_jobs USING btree (backup_type, started_at DESC);


--
-- Name: backup_restore_tests_backup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_restore_tests_backup_idx ON public.backup_restore_tests USING btree (backup_id, started_at DESC);


--
-- Name: branch_discounts_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_discounts_branch_idx ON public.branch_discounts USING btree (branch_id, business_date DESC);


--
-- Name: branch_discounts_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_discounts_date_idx ON public.branch_discounts USING btree (business_date DESC);


--
-- Name: branch_discounts_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_discounts_order_idx ON public.branch_discounts USING btree (production_order_id);


--
-- Name: branch_discounts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_discounts_status_idx ON public.branch_discounts USING btree (status) WHERE (status = 'pending'::public.branch_discount_status);


--
-- Name: branch_locations_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_locations_active_idx ON public.branch_locations USING btree (branch_id) WHERE is_active;


--
-- Name: branch_share_payments_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_share_payments_branch_idx ON public.branch_share_payments USING btree (branch_id, business_date DESC);


--
-- Name: branch_share_payments_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_share_payments_live_idx ON public.branch_share_payments USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: branch_share_payments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branch_share_payments_status_idx ON public.branch_share_payments USING btree (status, created_at DESC);


--
-- Name: branches_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branches_active_idx ON public.branches USING btree (name) WHERE is_active;


--
-- Name: business_day_closures_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX business_day_closures_date_idx ON public.business_day_closures USING btree (business_date DESC);


--
-- Name: business_day_closures_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX business_day_closures_stale_idx ON public.business_day_closures USING btree (started_at) WHERE (status = 'running'::public.closure_status);


--
-- Name: cash_transfers_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_transfers_branch_idx ON public.cash_transfers USING btree (branch_id, business_date DESC);


--
-- Name: cash_transfers_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_transfers_date_idx ON public.cash_transfers USING btree (business_date DESC);


--
-- Name: cash_transfers_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_transfers_live_idx ON public.cash_transfers USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: cash_transfers_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_transfers_status_idx ON public.cash_transfers USING btree (status) WHERE (status = 'pending'::public.cash_transfer_status);


--
-- Name: cash_transfers_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_transfers_window_idx ON public.cash_transfers USING btree (branch_id, created_at) WHERE (status = 'approved'::public.cash_transfer_status);


--
-- Name: categories_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_active_idx ON public.categories USING btree (sort_order, name) WHERE is_active;


--
-- Name: customers_branch_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_branch_created_idx ON public.customers USING btree (branch_id, created_at DESC);


--
-- Name: customers_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_branch_idx ON public.customers USING btree (branch_id, name);


--
-- Name: customers_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_phone_idx ON public.customers USING btree (phone) WHERE (phone IS NOT NULL);


--
-- Name: daily_closing_reports_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_closing_reports_branch_idx ON public.daily_closing_reports USING btree (branch_id, business_date DESC);


--
-- Name: daily_closing_reports_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX daily_closing_reports_key ON public.daily_closing_reports USING btree (business_date, scope, COALESCE((branch_id)::text, ''::text));


--
-- Name: daily_sale_audits_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_sale_audits_branch_idx ON public.daily_sale_record_audits USING btree (branch_id, created_at DESC);


--
-- Name: daily_sale_audits_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_sale_audits_record_idx ON public.daily_sale_record_audits USING btree (record_id, created_at DESC);


--
-- Name: daily_sale_records_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_sale_records_branch_date_idx ON public.daily_sale_records USING btree (branch_id, business_date DESC);


--
-- Name: daily_sale_records_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_sale_records_date_idx ON public.daily_sale_records USING btree (business_date DESC);


--
-- Name: daily_sale_records_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_sale_records_open_idx ON public.daily_sale_records USING btree (status) WHERE (status = ANY (ARRAY['open'::public.daily_sale_record_status, 'pending_verification'::public.daily_sale_record_status]));


--
-- Name: employee_advances_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_advances_employee_idx ON public.employee_advances USING btree (employee_id, business_date DESC);


--
-- Name: employee_advances_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_advances_live_idx ON public.employee_advances USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: employee_advances_outstanding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_advances_outstanding_idx ON public.employee_advances USING btree (employee_id) WHERE ((status = ANY (ARRAY['posted'::public.finance_doc_status, 'locked'::public.finance_doc_status])) AND (recovered_by_salary_id IS NULL));


--
-- Name: employee_advances_salary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_advances_salary_idx ON public.employee_advances USING btree (recovered_by_salary_id) WHERE (recovered_by_salary_id IS NOT NULL);


--
-- Name: employee_advances_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_advances_status_idx ON public.employee_advances USING btree (status, business_date DESC);


--
-- Name: event_branch_demand_items_demand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_branch_demand_items_demand_idx ON public.event_branch_demand_items USING btree (demand_id, line_no);


--
-- Name: event_branch_demand_items_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_branch_demand_items_product_idx ON public.event_branch_demand_items USING btree (product_id) WHERE (product_id IS NOT NULL);


--
-- Name: event_branch_demands_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_branch_demands_branch_idx ON public.event_branch_demands USING btree (branch_id, event_id);


--
-- Name: event_branch_demands_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_branch_demands_event_idx ON public.event_branch_demands USING btree (event_id, status);


--
-- Name: event_branches_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_branches_branch_idx ON public.event_branches USING btree (branch_id);


--
-- Name: event_notifications_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_notifications_due_idx ON public.event_notifications USING btree (scheduled_for) WHERE (status = 'pending'::public.event_notification_status);


--
-- Name: event_notifications_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_notifications_event_idx ON public.event_notifications USING btree (event_id, scheduled_for);


--
-- Name: event_notifications_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_notifications_key ON public.event_notifications USING btree (event_id, audience, COALESCE((branch_id)::text, ''::text), reminder_kind, offset_days);


--
-- Name: event_production_status_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_production_status_event_idx ON public.event_production_status USING btree (event_id);


--
-- Name: expenses_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_branch_date_idx ON public.expenses USING btree (branch_id, business_date DESC);


--
-- Name: expenses_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_created_idx ON public.expenses USING btree (created_at);


--
-- Name: expenses_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_date_idx ON public.expenses USING btree (business_date);


--
-- Name: expenses_description_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_description_trgm_idx ON public.expenses USING gin (description public.gin_trgm_ops);


--
-- Name: finance_amendments_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_amendments_created_idx ON public.finance_amendments USING btree (created_at DESC);


--
-- Name: finance_amendments_reference_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_amendments_reference_idx ON public.finance_amendments USING btree (reference_type, reference_id);


--
-- Name: finance_amendments_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_amendments_ticket_idx ON public.finance_amendments USING btree (ticket_id, created_at DESC);


--
-- Name: finance_audit_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_audit_actor_idx ON public.finance_audit_logs USING btree (actor_id, created_at DESC);


--
-- Name: finance_audit_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_audit_created_idx ON public.finance_audit_logs USING btree (created_at DESC);


--
-- Name: finance_audit_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_audit_entity_idx ON public.finance_audit_logs USING btree (entity, entity_id, created_at DESC);


--
-- Name: finance_employees_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_employees_active_idx ON public.finance_employees USING btree (department, name) WHERE is_active;


--
-- Name: finance_income_approvals_live_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX finance_income_approvals_live_day_idx ON public.finance_income_approvals USING btree (branch_id, business_date) WHERE (deleted_at IS NULL);


--
-- Name: finance_income_approvals_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_income_approvals_live_idx ON public.finance_income_approvals USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: finance_income_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_income_branch_date_idx ON public.finance_income_approvals USING btree (branch_id, business_date DESC);


--
-- Name: finance_income_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_income_date_idx ON public.finance_income_approvals USING btree (business_date DESC);


--
-- Name: finance_income_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_income_status_idx ON public.finance_income_approvals USING btree (status, business_date DESC);


--
-- Name: finance_queries_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_queries_branch_date_idx ON public.finance_queries USING btree (branch_id, business_date DESC);


--
-- Name: finance_queries_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_queries_created_idx ON public.finance_queries USING btree (created_at);


--
-- Name: finance_queries_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_queries_type_idx ON public.finance_queries USING btree (type);


--
-- Name: finance_ticket_messages_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_ticket_messages_ticket_idx ON public.finance_ticket_messages USING btree (ticket_id, created_at);


--
-- Name: finance_ticket_versions_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_ticket_versions_ticket_idx ON public.finance_ticket_versions USING btree (ticket_id, version DESC);


--
-- Name: finance_tickets_amount_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_amount_idx ON public.finance_tickets USING btree (amount) WHERE ((deleted_at IS NULL) AND (amount IS NOT NULL));


--
-- Name: finance_tickets_assigned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_assigned_idx ON public.finance_tickets USING btree (assigned_to, status);


--
-- Name: finance_tickets_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_branch_idx ON public.finance_tickets USING btree (branch_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: finance_tickets_business_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_business_date_idx ON public.finance_tickets USING btree (business_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: finance_tickets_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_deleted_idx ON public.finance_tickets USING btree (deleted_at DESC) WHERE (deleted_at IS NOT NULL);


--
-- Name: finance_tickets_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_live_idx ON public.finance_tickets USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: finance_tickets_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_priority_idx ON public.finance_tickets USING btree (priority, created_at DESC);


--
-- Name: finance_tickets_query_no_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX finance_tickets_query_no_idx ON public.finance_tickets USING btree (query_no);


--
-- Name: finance_tickets_raised_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_raised_idx ON public.finance_tickets USING btree (raised_by, created_at DESC);


--
-- Name: finance_tickets_raised_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_raised_status_idx ON public.finance_tickets USING btree (raised_by, status, created_at DESC);


--
-- Name: finance_tickets_recreated_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_recreated_from_idx ON public.finance_tickets USING btree (recreated_from_id) WHERE (recreated_from_id IS NOT NULL);


--
-- Name: finance_tickets_reference_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_reference_idx ON public.finance_tickets USING btree (reference_type, reference_no);


--
-- Name: finance_tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_status_idx ON public.finance_tickets USING btree (status, created_at DESC);


--
-- Name: finance_tickets_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_tickets_updated_idx ON public.finance_tickets USING btree (updated_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: finance_transactions_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_live_idx ON public.finance_transactions USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: finance_txn_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_txn_branch_date_idx ON public.finance_transactions USING btree (branch_id, business_date DESC, created_at DESC) WHERE ((branch_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: finance_txn_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_txn_date_idx ON public.finance_transactions USING btree (business_date DESC, created_at DESC);


--
-- Name: finance_txn_head_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_txn_head_idx ON public.finance_transactions USING btree (ledger_head_id);


--
-- Name: finance_txn_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_txn_status_idx ON public.finance_transactions USING btree (status, business_date DESC);


--
-- Name: geofence_logs_blocked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geofence_logs_blocked_idx ON public.geofence_logs USING btree (created_at DESC) WHERE (NOT allowed);


--
-- Name: geofence_logs_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geofence_logs_branch_idx ON public.geofence_logs USING btree (branch_id, created_at DESC);


--
-- Name: geofence_logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geofence_logs_created_idx ON public.geofence_logs USING btree (created_at DESC);


--
-- Name: geofence_logs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geofence_logs_user_idx ON public.geofence_logs USING btree (user_id, created_at DESC);


--
-- Name: idempotency_keys_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_created_at_idx ON public.idempotency_keys USING btree (created_at);


--
-- Name: ledger_entries_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_account_idx ON public.ledger_entries USING btree (account, entry_date DESC);


--
-- Name: ledger_entries_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_branch_idx ON public.ledger_entries USING btree (branch_id, entry_date DESC) WHERE (branch_id IS NOT NULL);


--
-- Name: ledger_entries_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_date_idx ON public.ledger_entries USING btree (entry_date DESC, seq DESC);


--
-- Name: ledger_entries_description_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_description_trgm_idx ON public.ledger_entries USING gin (description public.gin_trgm_ops);


--
-- Name: ledger_entries_head_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_head_idx ON public.ledger_entries USING btree (ledger_head_id, entry_date DESC);


--
-- Name: ledger_entries_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_live_idx ON public.ledger_entries USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: ledger_entries_one_reversal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ledger_entries_one_reversal_idx ON public.ledger_entries USING btree (reverses_entry_id) WHERE (reverses_entry_id IS NOT NULL);


--
-- Name: ledger_entries_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_source_idx ON public.ledger_entries USING btree (source_type, source_id);


--
-- Name: ledger_heads_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_heads_type_idx ON public.ledger_heads USING btree (type, sort_order, name) WHERE is_active;


--
-- Name: login_attempts_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_attempts_at_idx ON public.login_attempts USING btree (attempted_at DESC);


--
-- Name: login_attempts_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_attempts_email_idx ON public.login_attempts USING btree (email, attempted_at DESC);


--
-- Name: login_attempts_ip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_attempts_ip_idx ON public.login_attempts USING btree (ip_address, attempted_at DESC) WHERE (ip_address IS NOT NULL);


--
-- Name: login_sessions_auth_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_auth_session_idx ON public.login_sessions USING btree (auth_session_id) WHERE (auth_session_id IS NOT NULL);


--
-- Name: login_sessions_branch_login_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_branch_login_idx ON public.login_sessions USING btree (branch_id, login_at DESC) WHERE (branch_id IS NOT NULL);


--
-- Name: login_sessions_browser_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_browser_idx ON public.login_sessions USING btree (user_id, browser, os) WHERE (user_id IS NOT NULL);


--
-- Name: login_sessions_city_login_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_city_login_idx ON public.login_sessions USING btree (city, login_at DESC) WHERE (city IS NOT NULL);


--
-- Name: login_sessions_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_country_idx ON public.login_sessions USING btree (country, login_at DESC) WHERE (country IS NOT NULL);


--
-- Name: login_sessions_device_login_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_device_login_idx ON public.login_sessions USING btree (device_type, login_at DESC) WHERE (device_type IS NOT NULL);


--
-- Name: login_sessions_login_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_login_at_idx ON public.login_sessions USING btree (login_at DESC);


--
-- Name: login_sessions_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_open_idx ON public.login_sessions USING btree (user_id, last_seen_at DESC) WHERE (ended_at IS NULL);


--
-- Name: login_sessions_role_login_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_role_login_idx ON public.login_sessions USING btree (user_role, login_at DESC);


--
-- Name: login_sessions_suspicious_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_suspicious_idx ON public.login_sessions USING btree (login_at DESC) WHERE is_suspicious;


--
-- Name: login_sessions_user_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_user_code_idx ON public.login_sessions USING btree (user_code, login_at DESC) WHERE (user_code IS NOT NULL);


--
-- Name: login_sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_user_idx ON public.login_sessions USING btree (user_id, login_at DESC);


--
-- Name: login_sessions_user_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_sessions_user_name_trgm_idx ON public.login_sessions USING gin (user_name public.gin_trgm_ops);


--
-- Name: notification_logs_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_event_idx ON public.notification_logs USING btree (event_notification_id) WHERE (event_notification_id IS NOT NULL);


--
-- Name: notification_logs_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_order_idx ON public.notification_logs USING btree (order_id, created_at DESC) WHERE (order_id IS NOT NULL);


--
-- Name: notification_logs_order_sent_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_logs_order_sent_key ON public.notification_logs USING btree (order_id, channel) WHERE ((order_id IS NOT NULL) AND (status = 'sent'::public.notification_delivery_status));


--
-- Name: notification_logs_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_recipient_idx ON public.notification_logs USING btree (recipient_id, created_at DESC);


--
-- Name: notification_logs_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_report_idx ON public.notification_logs USING btree (report_id);


--
-- Name: notification_logs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_status_idx ON public.notification_logs USING btree (status, created_at DESC);


--
-- Name: notification_reads_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_reads_user_idx ON public.notification_reads USING btree (user_id);


--
-- Name: notification_recipients_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_recipients_branch_idx ON public.notification_recipients USING btree (branch_id) WHERE active;


--
-- Name: notification_recipients_dept_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_recipients_dept_idx ON public.notification_recipients USING btree (department) WHERE active;


--
-- Name: notifications_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_role_idx ON public.notifications USING btree (target_role, branch_id, created_at DESC) WHERE (target_role IS NOT NULL);


--
-- Name: notifications_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (target_user_id) WHERE (NOT is_read);


--
-- Name: notifications_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_idx ON public.notifications USING btree (target_user_id, created_at DESC) WHERE (target_user_id IS NOT NULL);


--
-- Name: order_items_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_order_idx ON public.order_items USING btree (order_id, line_no);


--
-- Name: order_items_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_product_idx ON public.order_items USING btree (product_id) WHERE (product_id IS NOT NULL);


--
-- Name: orders_branch_business_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_branch_business_date_idx ON public.orders USING btree (branch_id, business_date) INCLUDE (status, payment_method, grand_total, discount_total);


--
-- Name: orders_branch_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_branch_created_idx ON public.orders USING btree (branch_id, created_at DESC);


--
-- Name: orders_branch_created_recon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_branch_created_recon_idx ON public.orders USING btree (branch_id, created_at) INCLUDE (status, payment_method, grand_total, discount_total);


--
-- Name: orders_branch_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_branch_status_idx ON public.orders USING btree (branch_id, status, created_at DESC);


--
-- Name: orders_business_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_business_date_idx ON public.orders USING btree (business_date, branch_id);


--
-- Name: orders_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_created_idx ON public.orders USING btree (created_at);


--
-- Name: orders_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id) WHERE (customer_id IS NOT NULL);


--
-- Name: orders_customer_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_customer_name_trgm_idx ON public.orders USING gin (customer_name public.gin_trgm_ops);


--
-- Name: orders_customer_phone_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_customer_phone_trgm_idx ON public.orders USING gin (customer_phone public.gin_trgm_ops);


--
-- Name: orders_order_number_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_order_number_trgm_idx ON public.orders USING gin (order_number public.gin_trgm_ops);


--
-- Name: orders_payment_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_payment_created_idx ON public.orders USING btree (payment_method, created_at DESC);


--
-- Name: orders_payment_method_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_payment_method_idx ON public.orders USING btree (payment_method, business_date);


--
-- Name: orders_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_status_created_idx ON public.orders USING btree (status, created_at);


--
-- Name: packing_materials_active_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packing_materials_active_name_idx ON public.packing_materials USING btree (material_name) WHERE is_active;


--
-- Name: partner_expenses_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_expenses_live_idx ON public.partner_expenses USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: partner_expenses_partner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_expenses_partner_idx ON public.partner_expenses USING btree (partner_name, business_date DESC);


--
-- Name: partner_expenses_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_expenses_status_idx ON public.partner_expenses USING btree (status, business_date DESC);


--
-- Name: password_reset_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_user_idx ON public.password_reset_tokens USING btree (user_id);


--
-- Name: payment_method_settings_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_method_settings_branch_idx ON public.payment_method_settings USING btree (branch_id);


--
-- Name: price_activation_locks_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_activation_locks_stale_idx ON public.price_activation_locks USING btree (started_at) WHERE (status = 'running'::public.closure_status);


--
-- Name: product_price_history_activation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_price_history_activation_idx ON public.product_price_history USING btree (effective_date) WHERE (status = 'scheduled'::public.price_change_status);


--
-- Name: product_price_history_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_price_history_batch_idx ON public.product_price_history USING btree (batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: product_price_history_changed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_price_history_changed_idx ON public.product_price_history USING btree (changed_on DESC);


--
-- Name: product_price_history_one_scheduled_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_price_history_one_scheduled_key ON public.product_price_history USING btree (product_id) WHERE (status = 'scheduled'::public.price_change_status);


--
-- Name: product_price_history_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_price_history_product_idx ON public.product_price_history USING btree (product_id, version_number DESC);


--
-- Name: production_balances_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_balances_branch_idx ON public.production_balances USING btree (branch_id);


--
-- Name: production_balances_outstanding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_balances_outstanding_idx ON public.production_balances USING btree (product_id) WHERE (pending_qty > (0)::numeric);


--
-- Name: production_order_items_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_order_items_order_idx ON public.production_order_items USING btree (production_order_id, line_no);


--
-- Name: production_order_items_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_order_items_product_idx ON public.production_order_items USING btree (product_id) WHERE (product_id IS NOT NULL);


--
-- Name: production_order_packing_items_material_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_order_packing_items_material_idx ON public.production_order_packing_items USING btree (packing_material_id);


--
-- Name: production_order_packing_items_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_order_packing_items_order_idx ON public.production_order_packing_items USING btree (production_order_id, line_no);


--
-- Name: production_orders_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_orders_branch_date_idx ON public.production_orders USING btree (branch_id, business_date DESC);


--
-- Name: production_orders_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_orders_date_idx ON public.production_orders USING btree (business_date DESC);


--
-- Name: production_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_orders_status_idx ON public.production_orders USING btree (status, business_date DESC);


--
-- Name: production_returns_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_returns_branch_idx ON public.production_returns USING btree (branch_id, business_date DESC);


--
-- Name: production_returns_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_returns_date_idx ON public.production_returns USING btree (business_date DESC);


--
-- Name: production_returns_disposition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_returns_disposition_idx ON public.production_returns USING btree (disposition, business_date DESC);


--
-- Name: production_returns_photo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_returns_photo_idx ON public.production_returns USING btree (photo_attachment_id) WHERE (photo_attachment_id IS NOT NULL);


--
-- Name: production_returns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_returns_status_idx ON public.production_returns USING btree (status) WHERE (status = 'pending'::public.production_return_status);


--
-- Name: production_stock_history_branch_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_branch_created_idx ON public.production_stock_history USING btree (branch_id, created_at DESC) WHERE (branch_id IS NOT NULL);


--
-- Name: production_stock_history_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_branch_idx ON public.production_stock_history USING btree (branch_id, business_date DESC);


--
-- Name: production_stock_history_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_created_idx ON public.production_stock_history USING btree (created_at DESC);


--
-- Name: production_stock_history_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_date_idx ON public.production_stock_history USING btree (business_date, product_id);


--
-- Name: production_stock_history_opening_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_opening_idx ON public.production_stock_history USING btree (product_id, business_date) INCLUDE (delta);


--
-- Name: production_stock_history_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_order_idx ON public.production_stock_history USING btree (production_order_id);


--
-- Name: production_stock_history_product_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_product_created_idx ON public.production_stock_history USING btree (product_id, created_at DESC);


--
-- Name: production_stock_history_product_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_product_name_trgm_idx ON public.production_stock_history USING gin (product_name public.gin_trgm_ops);


--
-- Name: production_stock_history_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_recent_idx ON public.production_stock_history USING btree (business_date DESC, created_at DESC);


--
-- Name: production_stock_history_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_ref_idx ON public.production_stock_history USING btree (ref_id);


--
-- Name: production_stock_history_txn_no_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX production_stock_history_txn_no_key ON public.production_stock_history USING btree (transaction_no);


--
-- Name: production_stock_history_txn_no_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_txn_no_trgm_idx ON public.production_stock_history USING gin (transaction_no public.gin_trgm_ops);


--
-- Name: production_stock_history_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_type_created_idx ON public.production_stock_history USING btree (type, created_at DESC);


--
-- Name: production_stock_history_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_stock_history_type_idx ON public.production_stock_history USING btree (type, business_date DESC);


--
-- Name: products_active_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_active_name_idx ON public.products USING btree (name) WHERE is_active;


--
-- Name: products_active_ordinary_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_active_ordinary_name_idx ON public.products USING btree (name) WHERE (is_active AND (NOT is_special));


--
-- Name: products_category_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_category_active_idx ON public.products USING btree (category_id) WHERE is_active;


--
-- Name: products_sku_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_sku_key ON public.products USING btree (sku) WHERE ((sku IS NOT NULL) AND is_active);


--
-- Name: products_special_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_special_name_key ON public.products USING btree (lower(TRIM(BOTH FROM name))) WHERE is_special;


--
-- Name: push_subscriptions_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_role_idx ON public.push_subscriptions USING btree (role);


--
-- Name: push_subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions USING btree (user_id);


--
-- Name: restriction_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restriction_events_created_idx ON public.restriction_events USING btree (created_at DESC);


--
-- Name: restriction_events_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restriction_events_rule_idx ON public.restriction_events USING btree (rule_code, created_at DESC);


--
-- Name: restriction_requests_binding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restriction_requests_binding_idx ON public.restriction_requests USING btree (type, binding_key, requested_at DESC);


--
-- Name: restriction_requests_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX restriction_requests_open_idx ON public.restriction_requests USING btree (type, binding_key) WHERE ((status = 'pending'::text) OR ((status = 'approved'::text) AND (consumed_at IS NULL)));


--
-- Name: restriction_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restriction_requests_status_idx ON public.restriction_requests USING btree (status, requested_at DESC);


--
-- Name: return_stock_history_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX return_stock_history_branch_idx ON public.return_stock_history USING btree (branch_id, business_date DESC);


--
-- Name: return_stock_history_opening_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX return_stock_history_opening_idx ON public.return_stock_history USING btree (product_id, business_date) INCLUDE (delta);


--
-- Name: return_stock_history_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX return_stock_history_recent_idx ON public.return_stock_history USING btree (business_date DESC, created_at DESC);


--
-- Name: salary_payments_employee_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX salary_payments_employee_month_idx ON public.salary_payments USING btree (employee_id, salary_month) WHERE (status <> 'rejected'::public.finance_doc_status);


--
-- Name: salary_payments_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salary_payments_live_idx ON public.salary_payments USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: salary_payments_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salary_payments_month_idx ON public.salary_payments USING btree (salary_month DESC, employee_name);


--
-- Name: salary_payments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salary_payments_status_idx ON public.salary_payments USING btree (status, created_at DESC);


--
-- Name: salary_revisions_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salary_revisions_employee_idx ON public.salary_revisions USING btree (employee_id, effective_from DESC);


--
-- Name: special_events_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_events_date_idx ON public.special_events USING btree (event_date) WHERE is_active;


--
-- Name: special_events_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_events_due_idx ON public.special_events USING btree (demand_due_date) WHERE (demand_due_date IS NOT NULL);


--
-- Name: special_events_series_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_events_series_idx ON public.special_events USING btree (series_code, event_year DESC);


--
-- Name: special_events_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_events_status_idx ON public.special_events USING btree (status, event_date) WHERE is_active;


--
-- Name: special_events_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_events_year_idx ON public.special_events USING btree (event_year, event_date);


--
-- Name: special_orders_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_orders_branch_date_idx ON public.special_orders USING btree (branch_id, business_date DESC);


--
-- Name: special_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX special_orders_status_idx ON public.special_orders USING btree (status, business_date DESC);


--
-- Name: stock_audit_log_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_audit_log_branch_idx ON public.stock_audit_log USING btree (branch_id, created_at DESC);


--
-- Name: stock_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_branch_idx ON public.stock USING btree (branch_id);


--
-- Name: stock_history_branch_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_history_branch_created_idx ON public.stock_history USING btree (branch_id, created_at DESC);


--
-- Name: stock_history_branch_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_history_branch_date_idx ON public.stock_history USING btree (branch_id, business_date, product_id);


--
-- Name: stock_history_product_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_history_product_name_trgm_idx ON public.stock_history USING gin (product_name public.gin_trgm_ops);


--
-- Name: stock_history_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_history_ref_idx ON public.stock_history USING btree (ref_id);


--
-- Name: stock_history_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_history_type_created_idx ON public.stock_history USING btree (type, created_at DESC);


--
-- Name: support_tickets_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_branch_idx ON public.support_tickets USING btree (branch_id, created_at DESC);


--
-- Name: support_tickets_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_live_idx ON public.support_tickets USING btree (created_at DESC) WHERE (archived_at IS NULL);


--
-- Name: support_tickets_raised_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_raised_idx ON public.support_tickets USING btree (raised_by, created_at DESC);


--
-- Name: support_tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_status_idx ON public.support_tickets USING btree (status, created_at DESC);


--
-- Name: users_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_branch_idx ON public.users USING btree (branch_id) WHERE (branch_id IS NOT NULL);


--
-- Name: users_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_created_idx ON public.users USING btree (created_at DESC);


--
-- Name: users_role_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_status_idx ON public.users USING btree (role, status, created_at DESC);


--
-- Name: attachments attachments_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_immutable BEFORE UPDATE ON public.attachments FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.attachments_immutable();


--
-- Name: attachments attachments_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_no_delete BEFORE DELETE ON public.attachments FOR EACH ROW EXECUTE FUNCTION app.attachments_immutable();


--
-- Name: branch_locations branch_locations_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER branch_locations_touch BEFORE UPDATE ON public.branch_locations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: branch_share_payments branch_share_payments_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER branch_share_payments_touch BEFORE UPDATE ON public.branch_share_payments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: branches branches_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER branches_touch BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: cash_transfers cash_transfers_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cash_transfers_touch BEFORE UPDATE ON public.cash_transfers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: categories categories_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_touch BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: counters counters_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER counters_no_delete BEFORE DELETE ON public.counters FOR EACH ROW EXECUTE FUNCTION app.forbid_counter_removal();


--
-- Name: counters counters_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER counters_no_truncate BEFORE TRUNCATE ON public.counters FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_counter_removal();


--
-- Name: customers customers_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: daily_sale_records daily_sale_records_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daily_sale_records_touch BEFORE UPDATE ON public.daily_sale_records FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: employee_advances employee_advances_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employee_advances_touch BEFORE UPDATE ON public.employee_advances FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: event_branch_demands event_branch_demands_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_branch_demands_touch BEFORE UPDATE ON public.event_branch_demands FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: event_notifications event_notifications_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_notifications_touch BEFORE UPDATE ON public.event_notifications FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: event_production_status event_production_status_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_production_status_touch BEFORE UPDATE ON public.event_production_status FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_amendments finance_amendments_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_amendments_immutable BEFORE UPDATE ON public.finance_amendments FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.finance_amendments_append_only();


--
-- Name: finance_amendments finance_amendments_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_amendments_no_delete BEFORE DELETE ON public.finance_amendments FOR EACH ROW EXECUTE FUNCTION app.finance_amendments_append_only();


--
-- Name: finance_audit_logs finance_audit_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_audit_no_delete BEFORE DELETE ON public.finance_audit_logs FOR EACH ROW EXECUTE FUNCTION app.finance_audit_immutable();


--
-- Name: finance_audit_logs finance_audit_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_audit_no_update BEFORE UPDATE ON public.finance_audit_logs FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.finance_audit_immutable();


--
-- Name: finance_employees finance_employees_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_employees_touch BEFORE UPDATE ON public.finance_employees FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_income_approvals finance_income_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_income_touch BEFORE UPDATE ON public.finance_income_approvals FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_partners finance_partners_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_partners_touch BEFORE UPDATE ON public.finance_partners FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_queries finance_queries_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_queries_touch BEFORE UPDATE ON public.finance_queries FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_ticket_messages finance_ticket_messages_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_ticket_messages_immutable BEFORE UPDATE ON public.finance_ticket_messages FOR EACH ROW WHEN (((COALESCE(current_setting('app.allow_ticket_cascade'::text, true), 'off'::text) <> 'on'::text) AND (COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text))) EXECUTE FUNCTION app.finance_ticket_messages_append_only();


--
-- Name: finance_ticket_messages finance_ticket_messages_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_ticket_messages_no_delete BEFORE DELETE ON public.finance_ticket_messages FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_ticket_cascade'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.finance_ticket_messages_append_only();


--
-- Name: finance_ticket_versions finance_ticket_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_ticket_versions_immutable BEFORE UPDATE ON public.finance_ticket_versions FOR EACH ROW WHEN (((COALESCE(current_setting('app.allow_ticket_cascade'::text, true), 'off'::text) <> 'on'::text) AND (COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text))) EXECUTE FUNCTION app.finance_ticket_versions_append_only();


--
-- Name: finance_ticket_versions finance_ticket_versions_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_ticket_versions_no_delete BEFORE DELETE ON public.finance_ticket_versions FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_ticket_cascade'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.finance_ticket_versions_append_only();


--
-- Name: finance_tickets finance_tickets_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_tickets_touch BEFORE UPDATE ON public.finance_tickets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: finance_transactions finance_transactions_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_transactions_touch BEFORE UPDATE ON public.finance_transactions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: ledger_entries ledger_entries_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_entries_immutable BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.finance_ledger_immutable();


--
-- Name: ledger_heads ledger_heads_protect; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_heads_protect BEFORE DELETE OR UPDATE ON public.ledger_heads FOR EACH ROW EXECUTE FUNCTION app.protect_system_ledger_heads();


--
-- Name: ledger_heads ledger_heads_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_heads_touch BEFORE UPDATE ON public.ledger_heads FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: notification_recipients notification_recipients_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_recipients_touch BEFORE UPDATE ON public.notification_recipients FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: orders orders_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: packing_materials packing_materials_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER packing_materials_touch BEFORE UPDATE ON public.packing_materials FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: partner_expenses partner_expenses_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER partner_expenses_touch BEFORE UPDATE ON public.partner_expenses FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: payment_method_settings payment_method_settings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_method_settings_touch BEFORE UPDATE ON public.payment_method_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: production_balances production_balances_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER production_balances_touch BEFORE UPDATE ON public.production_balances FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: production_order_items production_order_items_no_special; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER production_order_items_no_special BEFORE INSERT ON public.production_order_items FOR EACH ROW EXECUTE FUNCTION app.refuse_special_demand_line();


--
-- Name: production_orders production_orders_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER production_orders_touch BEFORE UPDATE ON public.production_orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: production_stock_history production_stock_history_txn_no; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER production_stock_history_txn_no BEFORE INSERT ON public.production_stock_history FOR EACH ROW EXECUTE FUNCTION app.stamp_production_stock_txn_no();


--
-- Name: production_stock production_stock_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER production_stock_touch BEFORE UPDATE ON public.production_stock FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: products products_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_touch BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: restriction_events restriction_events_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER restriction_events_no_change BEFORE DELETE OR UPDATE ON public.restriction_events FOR EACH ROW EXECUTE FUNCTION app.restriction_events_no_change();


--
-- Name: return_stock return_stock_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER return_stock_touch BEFORE UPDATE ON public.return_stock FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: salary_payments salary_payments_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER salary_payments_touch BEFORE UPDATE ON public.salary_payments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: salary_revisions salary_revisions_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER salary_revisions_no_delete BEFORE DELETE ON public.salary_revisions FOR EACH ROW EXECUTE FUNCTION app.salary_revisions_immutable();


--
-- Name: salary_revisions salary_revisions_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER salary_revisions_no_update BEFORE UPDATE ON public.salary_revisions FOR EACH ROW WHEN ((COALESCE(current_setting('app.allow_user_purge'::text, true), 'off'::text) <> 'on'::text)) EXECUTE FUNCTION app.salary_revisions_immutable();


--
-- Name: settings settings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settings_touch BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: special_events special_events_seed_stages; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER special_events_seed_stages AFTER INSERT ON public.special_events FOR EACH ROW EXECUTE FUNCTION app.seed_event_production_stages();


--
-- Name: special_events special_events_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER special_events_touch BEFORE UPDATE ON public.special_events FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: special_orders special_orders_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER special_orders_touch BEFORE UPDATE ON public.special_orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: stock stock_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stock_touch BEFORE UPDATE ON public.stock FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: support_tickets support_tickets_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_tickets_touch BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: users users_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_refresh_tokens auth_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backup_jobs backup_jobs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: backup_restore_tests backup_restore_tests_backup_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_restore_tests
    ADD CONSTRAINT backup_restore_tests_backup_job_id_fkey FOREIGN KEY (backup_job_id) REFERENCES public.backup_jobs(id) ON DELETE CASCADE;


--
-- Name: branch_discounts branch_discounts_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_discounts
    ADD CONSTRAINT branch_discounts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: branch_discounts branch_discounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_discounts
    ADD CONSTRAINT branch_discounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_discounts branch_discounts_production_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_discounts
    ADD CONSTRAINT branch_discounts_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES public.production_orders(id) ON DELETE RESTRICT;


--
-- Name: branch_discounts branch_discounts_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_discounts
    ADD CONSTRAINT branch_discounts_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_locations branch_locations_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_locations
    ADD CONSTRAINT branch_locations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: branch_locations branch_locations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_locations
    ADD CONSTRAINT branch_locations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_share_payments branch_share_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_share_payments branch_share_payments_bonus_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_bonus_ledger_entry_id_fkey FOREIGN KEY (bonus_ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: branch_share_payments branch_share_payments_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: branch_share_payments branch_share_payments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_share_payments branch_share_payments_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: branch_share_payments branch_share_payments_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_share_payments
    ADD CONSTRAINT branch_share_payments_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branches branches_manager_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_manager_fk FOREIGN KEY (manager_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_transfers cash_transfers_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_transfers cash_transfers_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: cash_transfers cash_transfers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_transfers cash_transfers_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_transfers cash_transfers_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: cash_transfers cash_transfers_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: customers customers_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: daily_closing_reports daily_closing_reports_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closing_reports
    ADD CONSTRAINT daily_closing_reports_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: daily_sale_record_audits daily_sale_record_audits_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_record_audits
    ADD CONSTRAINT daily_sale_record_audits_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: daily_sale_record_audits daily_sale_record_audits_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_record_audits
    ADD CONSTRAINT daily_sale_record_audits_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: daily_sale_record_audits daily_sale_record_audits_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_record_audits
    ADD CONSTRAINT daily_sale_record_audits_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.daily_sale_records(id) ON DELETE CASCADE;


--
-- Name: daily_sale_records daily_sale_records_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: daily_sale_records daily_sale_records_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: daily_sale_records daily_sale_records_fed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_fed_by_fkey FOREIGN KEY (fed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: daily_sale_records daily_sale_records_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: daily_sale_records daily_sale_records_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sale_records
    ADD CONSTRAINT daily_sale_records_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: employee_advances employee_advances_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: employee_advances employee_advances_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: employee_advances employee_advances_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: employee_advances employee_advances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.finance_employees(id) ON DELETE RESTRICT;


--
-- Name: employee_advances employee_advances_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: employee_advances employee_advances_recovered_by_salary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_advances
    ADD CONSTRAINT employee_advances_recovered_by_salary_id_fkey FOREIGN KEY (recovered_by_salary_id) REFERENCES public.salary_payments(id) ON DELETE SET NULL;


--
-- Name: event_branch_demand_items event_branch_demand_items_demand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demand_items
    ADD CONSTRAINT event_branch_demand_items_demand_id_fkey FOREIGN KEY (demand_id) REFERENCES public.event_branch_demands(id) ON DELETE CASCADE;


--
-- Name: event_branch_demand_items event_branch_demand_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demand_items
    ADD CONSTRAINT event_branch_demand_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: event_branch_demands event_branch_demands_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: event_branch_demands event_branch_demands_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.special_events(id) ON DELETE CASCADE;


--
-- Name: event_branch_demands event_branch_demands_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: event_branch_demands event_branch_demands_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branch_demands
    ADD CONSTRAINT event_branch_demands_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: event_branches event_branches_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branches
    ADD CONSTRAINT event_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: event_branches event_branches_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_branches
    ADD CONSTRAINT event_branches_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.special_events(id) ON DELETE CASCADE;


--
-- Name: event_notifications event_notifications_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: event_notifications event_notifications_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.special_events(id) ON DELETE CASCADE;


--
-- Name: event_notifications event_notifications_in_app_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_in_app_notification_id_fkey FOREIGN KEY (in_app_notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL;


--
-- Name: event_production_status event_production_status_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_production_status
    ADD CONSTRAINT event_production_status_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.special_events(id) ON DELETE CASCADE;


--
-- Name: event_production_status event_production_status_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_production_status
    ADD CONSTRAINT event_production_status_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_amendments finance_amendments_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_amendments
    ADD CONSTRAINT finance_amendments_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_amendments finance_amendments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_amendments
    ADD CONSTRAINT finance_amendments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.finance_tickets(id) ON DELETE RESTRICT;


--
-- Name: finance_audit_logs finance_audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_audit_logs
    ADD CONSTRAINT finance_audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_day_closings finance_day_closings_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_day_closings
    ADD CONSTRAINT finance_day_closings_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_employees finance_employees_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_employees
    ADD CONSTRAINT finance_employees_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: finance_income_approvals finance_income_approvals_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_income_approvals finance_income_approvals_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: finance_income_approvals finance_income_approvals_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_income_approvals finance_income_approvals_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_income_approvals
    ADD CONSTRAINT finance_income_approvals_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_queries finance_queries_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_queries
    ADD CONSTRAINT finance_queries_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: finance_queries finance_queries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_queries
    ADD CONSTRAINT finance_queries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_queries finance_queries_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_queries
    ADD CONSTRAINT finance_queries_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_ticket_messages finance_ticket_messages_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_messages
    ADD CONSTRAINT finance_ticket_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_ticket_messages finance_ticket_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_messages
    ADD CONSTRAINT finance_ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.finance_tickets(id) ON DELETE CASCADE;


--
-- Name: finance_ticket_versions finance_ticket_versions_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_versions
    ADD CONSTRAINT finance_ticket_versions_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_ticket_versions finance_ticket_versions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_ticket_versions
    ADD CONSTRAINT finance_ticket_versions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.finance_tickets(id) ON DELETE CASCADE;


--
-- Name: finance_tickets finance_tickets_amended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_amended_by_fkey FOREIGN KEY (amended_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_recreated_as_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_recreated_as_id_fkey FOREIGN KEY (recreated_as_id) REFERENCES public.finance_tickets(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_recreated_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_recreated_from_id_fkey FOREIGN KEY (recreated_from_id) REFERENCES public.finance_tickets(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_reopened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_reopened_by_fkey FOREIGN KEY (reopened_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_tickets finance_tickets_restored_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_tickets
    ADD CONSTRAINT finance_tickets_restored_by_fkey FOREIGN KEY (restored_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: finance_transactions finance_transactions_ledger_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_ledger_head_id_fkey FOREIGN KEY (ledger_head_id) REFERENCES public.ledger_heads(id) ON DELETE RESTRICT;


--
-- Name: geofence_logs geofence_logs_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_logs
    ADD CONSTRAINT geofence_logs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: geofence_logs geofence_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_logs
    ADD CONSTRAINT geofence_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_ledger_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_ledger_head_id_fkey FOREIGN KEY (ledger_head_id) REFERENCES public.ledger_heads(id) ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_reversed_by_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_reversed_by_entry_id_fkey FOREIGN KEY (reversed_by_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_reverses_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_reverses_entry_id_fkey FOREIGN KEY (reverses_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ledger_heads ledger_heads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_heads
    ADD CONSTRAINT ledger_heads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: login_sessions login_sessions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: login_sessions login_sessions_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: login_sessions login_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_logs notification_logs_event_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_event_notification_id_fkey FOREIGN KEY (event_notification_id) REFERENCES public.event_notifications(id) ON DELETE SET NULL;


--
-- Name: notification_logs notification_logs_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: notification_logs notification_logs_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.notification_recipients(id) ON DELETE SET NULL;


--
-- Name: notification_logs notification_logs_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.daily_closing_reports(id) ON DELETE SET NULL;


--
-- Name: notification_reads notification_reads_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_recipients notification_recipients_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_recipients
    ADD CONSTRAINT notification_recipients_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: orders orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: orders orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: packing_materials packing_materials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packing_materials
    ADD CONSTRAINT packing_materials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: partner_expenses partner_expenses_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: partner_expenses partner_expenses_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: partner_expenses partner_expenses_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: partner_expenses partner_expenses_ledger_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_ledger_head_id_fkey FOREIGN KEY (ledger_head_id) REFERENCES public.ledger_heads(id) ON DELETE RESTRICT;


--
-- Name: partner_expenses partner_expenses_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.finance_partners(id) ON DELETE RESTRICT;


--
-- Name: partner_expenses partner_expenses_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_expenses
    ADD CONSTRAINT partner_expenses_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_method_settings payment_method_settings_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_method_settings
    ADD CONSTRAINT payment_method_settings_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: payment_method_settings payment_method_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_method_settings
    ADD CONSTRAINT payment_method_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: product_price_history product_price_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: product_price_history product_price_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: production_balances production_balances_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_balances
    ADD CONSTRAINT production_balances_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: production_balances production_balances_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_balances
    ADD CONSTRAINT production_balances_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: production_order_items production_order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_items
    ADD CONSTRAINT production_order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: production_order_items production_order_items_production_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_items
    ADD CONSTRAINT production_order_items_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES public.production_orders(id) ON DELETE CASCADE;


--
-- Name: production_order_packing_items production_order_packing_items_packing_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_packing_items
    ADD CONSTRAINT production_order_packing_items_packing_material_id_fkey FOREIGN KEY (packing_material_id) REFERENCES public.packing_materials(id) ON DELETE SET NULL;


--
-- Name: production_order_packing_items production_order_packing_items_production_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_order_packing_items
    ADD CONSTRAINT production_order_packing_items_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES public.production_orders(id) ON DELETE CASCADE;


--
-- Name: production_orders production_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_orders production_orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: production_orders production_orders_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_orders production_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_orders production_orders_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_returns production_returns_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: production_returns production_returns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_returns production_returns_photo_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_photo_attachment_id_fkey FOREIGN KEY (photo_attachment_id) REFERENCES public.attachments(id);


--
-- Name: production_returns production_returns_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: production_returns production_returns_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_returns
    ADD CONSTRAINT production_returns_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_stock_history production_stock_history_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: production_stock_history production_stock_history_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: production_stock_history production_stock_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: production_stock_history production_stock_history_production_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock_history
    ADD CONSTRAINT production_stock_history_production_order_id_fkey FOREIGN KEY (production_order_id) REFERENCES public.production_orders(id) ON DELETE SET NULL;


--
-- Name: production_stock production_stock_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_stock
    ADD CONSTRAINT production_stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: restriction_events restriction_events_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_events
    ADD CONSTRAINT restriction_events_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: restriction_events restriction_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_events
    ADD CONSTRAINT restriction_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: restriction_requests restriction_requests_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: restriction_requests restriction_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: restriction_requests restriction_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_requests
    ADD CONSTRAINT restriction_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: restriction_rules restriction_rules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restriction_rules
    ADD CONSTRAINT restriction_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: return_stock_history return_stock_history_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: return_stock_history return_stock_history_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: return_stock_history return_stock_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: return_stock_history return_stock_history_production_return_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock_history
    ADD CONSTRAINT return_stock_history_production_return_id_fkey FOREIGN KEY (production_return_id) REFERENCES public.production_returns(id) ON DELETE SET NULL;


--
-- Name: return_stock return_stock_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.return_stock
    ADD CONSTRAINT return_stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: salary_payments salary_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: salary_payments salary_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: salary_payments salary_payments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: salary_payments salary_payments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.finance_employees(id) ON DELETE RESTRICT;


--
-- Name: salary_payments salary_payments_ledger_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id) ON DELETE RESTRICT;


--
-- Name: salary_revisions salary_revisions_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: salary_revisions salary_revisions_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.finance_employees(id) ON DELETE CASCADE;


--
-- Name: settings settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: special_events special_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_events
    ADD CONSTRAINT special_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: special_order_items special_order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_order_items
    ADD CONSTRAINT special_order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: special_order_items special_order_items_special_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_order_items
    ADD CONSTRAINT special_order_items_special_order_id_fkey FOREIGN KEY (special_order_id) REFERENCES public.special_orders(id) ON DELETE CASCADE;


--
-- Name: special_order_items special_order_items_stock_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_order_items
    ADD CONSTRAINT special_order_items_stock_movement_id_fkey FOREIGN KEY (stock_movement_id) REFERENCES public.production_stock_history(id) ON DELETE SET NULL;


--
-- Name: special_orders special_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: special_orders special_orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;


--
-- Name: special_orders special_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: special_orders special_orders_prepared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_prepared_by_fkey FOREIGN KEY (prepared_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: special_orders special_orders_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.special_orders
    ADD CONSTRAINT special_orders_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stock_audit_log stock_audit_log_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audit_log
    ADD CONSTRAINT stock_audit_log_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_audit_log stock_audit_log_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audit_log
    ADD CONSTRAINT stock_audit_log_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: stock_audit_log stock_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audit_log
    ADD CONSTRAINT stock_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stock stock_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_history stock_history_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_history
    ADD CONSTRAINT stock_history_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_history stock_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_history
    ADD CONSTRAINT stock_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: stock stock_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: support_tickets support_tickets_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_credentials user_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credentials
    ADD CONSTRAINT user_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: users users_password_reset_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_password_reset_by_fkey FOREIGN KEY (password_reset_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


