-- Sessions and accounts are the API's own, and only its own.
--
-- The three functions below were written to work on two kinds of database: one
-- that also had a separate `auth` schema holding a second copy of every account
-- and session, and one that did not. This database is the second kind and has
-- no other: an account is a row in `users`, its password is in
-- `user_credentials`, and a signed-in device is a row in `auth_sessions`. So
-- the half of each function that looked for the other schema is removed, and
-- the comments that described it say what is true now.
--
-- Same names, same arguments, same return values, same grants: nothing that
-- calls them changes.

-- ── Ending sessions ─────────────────────────────────────────────────────────
create or replace function public.revoke_auth_session(p_auth_session_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
  declare
    ended integer := 0;
  begin
    if p_auth_session_id is null then return false; end if;

    update public.auth_sessions
       set revoked_at = now()
     where id = p_auth_session_id and revoked_at is null;
    get diagnostics ended = row_count;

    return ended > 0;
  end;
  $$;

comment on function public.revoke_auth_session(uuid) is
  'End one signed-in device: marks the session with this id revoked. True if it was still open.';

create or replace function public.revoke_all_auth_sessions(
  p_user_id uuid,
  p_keep_auth_session_id uuid default null
)
  returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
  declare
    ended integer := 0;
  begin
    if p_user_id is null then return 0; end if;

    update public.auth_sessions
       set revoked_at = now()
     where user_id = p_user_id
       and revoked_at is null
       and (p_keep_auth_session_id is null or id <> p_keep_auth_session_id);
    get diagnostics ended = row_count;

    return ended;
  end;
  $$;

comment on function public.revoke_all_auth_sessions(uuid, uuid) is
  'End every signed-in device of one user, optionally keeping one session. Returns how many were ended.';

-- ── Deleting an account ─────────────────────────────────────────────────────
--
-- The user's credentials, sessions and tokens go with the `users` row (on
-- delete cascade). Business records keep their *_name columns and lose only the
-- link to the user (on delete set null).
create or replace function public.delete_user_account(p_user_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  begin
    if not exists (select 1 from public.users where id = p_user_id) then
      return false;
    end if;

    perform set_config('app.allow_user_purge', 'on', true);
    delete from public.users where id = p_user_id;
    perform set_config('app.allow_user_purge', 'off', true);
    return true;
  end;
  $$;

-- ── What the tables say about themselves ────────────────────────────────────
comment on table public.login_attempts is
  'Failed sign-in attempts: the address that was typed, why it was refused, and the IP, resolved city and parsed browser it came from. Reported by the client, from an endpoint that cannot require a token — and therefore forgeable, which is why it is evidence for a person and never an input to a lockout. Never contains a password, a hash of one, or any other credential material.';

comment on table public.login_sessions is
  'Login history and active sessions: who signed in, from which IP, resolved city and parsed browser, how long it lasted, whether it looked unusual, and who revoked it. Opened, pinged and closed by the client once it has signed in. Evidence for a human and a handle for an admin — never an authorisation input.';

comment on column public.login_sessions.auth_session_id is
  'The sign-in session this row describes: auth_sessions.id, read off the verified access token. The handle revoke_auth_session() ends it by. Null for sessions opened before migration 98.';
