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
-- so deleting anyone who ever touched Finance would fail. Migration 122 (step
-- 0b) split each of those triggers so the UPDATE one stands aside while
-- `app.allow_user_purge` is on — 122 needed it first, for the shift accounts.
-- The flag is transaction-local here (set_config(…, true), as in migrations
-- 61/62), so the window never outlives the one delete.
-- ---------------------------------------------------------------------------

-- The delete itself. Returns false when no such user exists.
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
