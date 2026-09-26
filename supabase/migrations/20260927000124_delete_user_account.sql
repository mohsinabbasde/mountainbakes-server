-- 124: permanently delete a user — Admin → Users → ⋯ → Delete.
--
-- Until now "Delete" only deactivated (status inactive + auth ban), the same as
-- "Deactivate". The owner wants Delete to remove the account for good: gone from
-- the list and from the database.
--
-- ─── What a delete touches ───────────────────────────────────────────────────
-- Same shape as migration 122: deleting from auth.users cascades to
-- public.users (core, 02) and from there only to what was personal to the
-- login (chat membership, notification reads, push subscriptions, notifications
-- addressed to that one user). Every business record references users
-- ON DELETE SET NULL and keeps the denormalised *_name it was written with, so
-- history still says who did it.
--
-- ─── Why a function, and why the triggers change ─────────────────────────────
-- ON DELETE SET NULL is an UPDATE on the referencing row, and six append-only
-- tables refuse every UPDATE:
--   salary_revisions.changed_by, finance_audit_logs.actor_id,
--   attachments.uploaded_by, finance_ticket_messages.author_id,
--   finance_amendments.admin_id, finance_ticket_versions.changed_by
-- so deleting anyone who ever touched Finance would fail. Each of those
-- triggers is split into a DELETE trigger (unchanged — still refused) and an
-- UPDATE trigger that stands aside while `app.allow_user_purge` is on. The flag
-- is transaction-local (set_config(…, true), as in migrations 61/62) and only
-- delete_user_account() sets it, so the window never outlives the one delete.
-- ---------------------------------------------------------------------------

-- 1. The six append-only triggers.

drop trigger if exists salary_revisions_no_change on salary_revisions;
create trigger salary_revisions_no_delete
  before delete on salary_revisions
  for each row execute function app.salary_revisions_immutable();
create trigger salary_revisions_no_update
  before update on salary_revisions
  for each row
  when (coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.salary_revisions_immutable();

drop trigger if exists finance_audit_no_change on finance_audit_logs;
create trigger finance_audit_no_delete
  before delete on finance_audit_logs
  for each row execute function app.finance_audit_immutable();
create trigger finance_audit_no_update
  before update on finance_audit_logs
  for each row
  when (coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.finance_audit_immutable();

drop trigger if exists attachments_immutable on attachments;
create trigger attachments_no_delete
  before delete on attachments
  for each row execute function app.attachments_immutable();
create trigger attachments_immutable
  before update on attachments
  for each row
  when (coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.attachments_immutable();

drop trigger if exists finance_amendments_immutable on finance_amendments;
create trigger finance_amendments_no_delete
  before delete on finance_amendments
  for each row execute function app.finance_amendments_append_only();
create trigger finance_amendments_immutable
  before update on finance_amendments
  for each row
  when (coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.finance_amendments_append_only();

-- These two already stand aside for a ticket cascade (94/106); that stays.
drop trigger if exists finance_ticket_messages_immutable on finance_ticket_messages;
create trigger finance_ticket_messages_no_delete
  before delete on finance_ticket_messages
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on')
  execute function app.finance_ticket_messages_append_only();
create trigger finance_ticket_messages_immutable
  before update on finance_ticket_messages
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on'
        and coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.finance_ticket_messages_append_only();

drop trigger if exists finance_ticket_versions_immutable on finance_ticket_versions;
create trigger finance_ticket_versions_no_delete
  before delete on finance_ticket_versions
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on')
  execute function app.finance_ticket_versions_append_only();
create trigger finance_ticket_versions_immutable
  before update on finance_ticket_versions
  for each row
  when (coalesce(current_setting('app.allow_ticket_cascade', true), 'off') <> 'on'
        and coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
  execute function app.finance_ticket_versions_append_only();

-- 2. The delete itself. Returns false when no such user exists.
create or replace function delete_user_account(p_user_id uuid) returns boolean
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    v_found boolean;
  begin
    select exists (select 1 from public.users where id = p_user_id)
        or exists (select 1 from auth.users where id = p_user_id)
      into v_found;
    if not v_found then
      return false;
    end if;

    perform set_config('app.allow_user_purge', 'on', true);
    delete from auth.users where id = p_user_id;
    -- A profile row whose auth user is already gone must not linger either.
    delete from public.users where id = p_user_id;
    perform set_config('app.allow_user_purge', 'off', true);
    return true;
  end;
  $$;

revoke all on function delete_user_account(uuid) from public, anon, authenticated;
grant execute on function delete_user_account(uuid) to service_role;
