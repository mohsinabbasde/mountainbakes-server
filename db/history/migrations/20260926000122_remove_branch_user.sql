-- 122: remove the shift account (`branch_user`) — the role, every account that
-- holds it, and the request queue that opened them (migrations 65 and 66).
--
-- The owner's decision: shift accounts are gone entirely. A branch is worked by
-- its branch manager's login; Admin no longer creates shift logins and a
-- manager no longer requests them.
--
-- ─── The accounts are DELETED, not deactivated ───────────────────────────────
-- Deleting from auth.users cascades to public.users (core, 02) and from there
-- only to what was personal to the login: chat membership, notification reads,
-- push subscriptions, notifications addressed to that one user. Every business
-- record a shift account touched — sales, expenses, demands, daily sale records,
-- cash deposits, audit rows — references users ON DELETE SET NULL and keeps the
-- denormalised name it was written with, so the history still says who did it.
--
-- ─── The enum value stays ────────────────────────────────────────────────────
-- Postgres cannot drop a value from an enum in place, and rebuilding `user_role`
-- would mean re-typing every column and policy that uses it. The value is
-- instead made unassignable: `users_no_branch_user` refuses it on the one table
-- that grants a role. Likewise the two notification_type values from 65 stay in
-- the type with no rows left using them.
--
-- Safe in one `db push` transaction: 'branch_user' was added by migration 65,
-- committed long ago, so naming it here is not the 55P04 case.
-- ---------------------------------------------------------------------------

-- 0. The request queue table goes first. Deleting the accounts sets its
--    created_user_id to null (on delete set null), which branch_user_requests_decided_ck
--    refuses for an approved request — the first db push failed on exactly that.
drop table if exists branch_user_requests;

-- 0b. Let the delete through the append-only finance tables.
--    ON DELETE SET NULL is an UPDATE on the referencing row, and six append-only
--    tables refuse every UPDATE — the first db push of this file failed on an
--    attachment a shift account had uploaded. Each of those triggers is split
--    into a DELETE trigger (unchanged — still refused) and an UPDATE trigger
--    that stands aside while `app.allow_user_purge` is on. The flag is set only
--    around the deletes below, and by delete_user_account() (migration 124).
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

select set_config('app.allow_user_purge', 'on', false);

-- 1. The accounts. auth.users → public.users cascades (02).
delete from auth.users
 where id in (select id from public.users where role = 'branch_user');
-- A profile row without an auth user cannot sign in, but must not linger either.
delete from public.users where role = 'branch_user';
select set_config('app.allow_user_purge', 'off', false);

-- Broadcasts addressed to the role, and the two notification kinds the queue sent.
delete from notifications where target_role = 'branch_user';
delete from notifications where type::text in ('branch_user_requested', 'branch_user_reviewed');

-- 2. The role can never be assigned again.
alter table users drop constraint if exists users_no_branch_user;
alter table users add constraint users_no_branch_user check (role <> 'branch_user');

-- 3. The shift label (66). Its check constraint goes with the column.
alter table users drop constraint if exists users_shift_only_for_branch_user;
alter table users drop column if exists shift;

-- 4. The rest of the request queue (66); its table was dropped in step 0.
drop function if exists next_branch_user_request_number();
-- The 'branch_user_request' counters row stays: counters refuses every delete
-- (migration 46, counters_no_delete) and one unused row costs nothing — the
-- second db push of this file failed on exactly that.
drop type if exists branch_user_request_status;
drop type if exists branch_shift;

comment on constraint users_no_branch_user on users is
  'Shift accounts were removed by migration 122. The user_role enum keeps the value only because Postgres cannot drop it.';
