-- 129: Finance Query — correct the linked record, and optionally resolve the
-- query, in ONE transaction.
--
-- Until now the Help Desk's "Correct record" changed one field per request
-- (POST /api/finance/tickets/:id/amend → amend_finance_record), and resolving
-- the query was a second request. A correction touching two fields, or a
-- correction followed by a resolve, could therefore stop half-way: the amount
-- changed but the description not, or the record changed but the query still
-- open. This function wraps the existing per-field function rather than
-- replacing it, so "corrected" still means exactly what migration 121 says it
-- means (reversal + corrected voucher for a posted figure, derived totals
-- restated, the same whitelist of fields), and adds around it:
--
--   1. The query row is locked and its VERSION checked against the one the
--      admin opened. Every write to a query bumps the version, so a status
--      change, assignment or edit by another admin in the meantime is a
--      conflict rather than something silently resolved over.
--   2. Each field's value BEFORE the change (as amend_finance_record read it
--      under its own row lock) is compared with the value the admin was shown.
--      A record another user changed in the meantime raises MBCON and the whole
--      correction — every field, every voucher — rolls back.
--   3. A finance_amendments row per field, as the /amend route writes.
--   4. Optionally the query goes to RESOLVED (resolution type Fixed) with the
--      admin's response, satisfying finance_tickets_resolution_check.
--   5. One finance_ticket_versions row, action 'record_corrected', whose change
--      list names the record fields that moved and the status change — so View
--      History shows the correction beside the query's own edits.
--
-- Any RAISE anywhere — a refused field, a closed day in the ledger, a conflict —
-- undoes all of it. finance_audit_logs is still written by the API afterwards,
-- as every other route does (it is forensic context and never blocks a write).
--
-- Error codes the API maps:  P0001 → 409 (a sentence for the admin),
--                            MBCON → 409 conflict (reload and retry),
--                            MBNFD → 404.
-- ---------------------------------------------------------------------------

-- 1. The new version action
alter table finance_ticket_versions drop constraint if exists finance_ticket_versions_action_check;
alter table finance_ticket_versions add constraint finance_ticket_versions_action_check check (action in (
  'created', 'submitted', 'edited', 'amended', 'status_changed', 'assigned', 'responded',
  'resolved', 'reopened', 'deleted', 'restored', 'recreated', 'record_corrected'
));

-- 2. The function
create or replace function correct_finance_record_for_query(
  p_ticket_id        uuid,
  p_expected_version integer,
  -- [{ "field": "amount", "value": "3000", "expected": "2500",
  --    "label": "Amount", "money": true }, …] — applied in array order.
  p_edits            jsonb,
  p_reason           text,
  -- 'amend' | 'overwrite' — finance_amendments' verb; overwrite = approved record.
  p_action           text,
  p_resolve          boolean,
  p_admin_response   text,
  -- { "statusFrom": "Open", "statusTo": "Resolved", "resolutionType": "Fixed" }
  -- — display labels for the version row; the vocabularies live in TypeScript.
  p_labels           jsonb,
  p_actor_id         uuid,
  p_actor_name       text,
  p_actor_role       text,
  p_ip_address       text,
  p_entry_date       date default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_ticket   finance_tickets%rowtype;
    v_after    finance_tickets%rowtype;
    v_edit     jsonb;
    v_result   jsonb;
    v_field    text;
    v_label    text;
    v_money    boolean;
    v_old      text;
    v_new      text;
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

    for v_edit in select value from jsonb_array_elements(p_edits) loop
      v_field    := v_edit ->> 'field';
      v_money    := coalesce((v_edit ->> 'money')::boolean, false);
      v_label    := coalesce(nullif(v_edit ->> 'label', ''), v_field);
      v_expected := v_edit ->> 'expected';

      v_result := amend_finance_record(
        v_ticket.reference_type, v_ticket.reference_id, v_field, v_edit ->> 'value',
        p_reason, p_actor_id, p_actor_name, p_entry_date);

      v_old    := v_result ->> 'originalValue';
      v_new    := v_result ->> 'newValue';
      v_ref_no := coalesce(v_result ->> 'referenceNo', v_ticket.reference_no);

      -- The optimistic check. amend_finance_record read `v_old` from the row it
      -- then updated, inside this transaction, so it is the value the change
      -- actually replaced — not a value read earlier by the API.
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
        p_action, v_field, v_old, v_new, (v_result ->> 'difference')::numeric,
        p_reason, p_actor_id, coalesce(p_actor_name, ''), p_ip_address
      );

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'record.' || v_field,
        'label', v_ref_no || ' · ' || v_label,
        'old', case when v_money and v_old ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_old::numeric, 'FM999,999,999,990.00')
                    else nullif(v_old, '') end,
        'new', case when v_money and v_new ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then to_char(v_new::numeric, 'FM999,999,999,990.00')
                    else nullif(v_new, '') end
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
  $$;

revoke all on function correct_finance_record_for_query(uuid, integer, jsonb, text, text, boolean, text, jsonb, uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function correct_finance_record_for_query(uuid, integer, jsonb, text, text, boolean, text, jsonb, uuid, text, text, text, date)
  to service_role;
