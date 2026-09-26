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

-- 1. The accounts. auth.users → public.users cascades (02).
delete from auth.users
 where id in (select id from public.users where role = 'branch_user');
-- A profile row without an auth user cannot sign in, but must not linger either.
delete from public.users where role = 'branch_user';

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
delete from counters where id = 'branch_user_request';
drop type if exists branch_user_request_status;
drop type if exists branch_shift;

comment on constraint users_no_branch_user on users is
  'Shift accounts were removed by migration 122. The user_role enum keeps the value only because Postgres cannot drop it.';
