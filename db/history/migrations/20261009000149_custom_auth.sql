-- 149: the API's own sign-in — credentials, sessions and refresh tokens.
--
-- WHY THIS EXISTS. Until now nobody signed in to THIS system: the browser and
-- the phone signed in to Supabase Auth and showed the API the token they were
-- given. The password, the session and the role the API trusted all lived in
-- the `auth` schema, which the application does not own and which does not
-- exist on a plain Postgres. This migration gives the API somewhere of its own
-- to keep those three things, so that it can issue and check tokens itself.
--
-- IT ADDS; IT TAKES NOTHING AWAY. Supabase Auth keeps working exactly as it
-- does today. The API accepts both kinds of token while the web and mobile apps
-- are moved over, and only then is the old path switched off. Every statement
-- here is safe to run on a database that still has the `auth` schema and on one
-- that never had it.
--
-- ── THE FOUR TABLES ────────────────────────────────────────────────────────
--
--   user_credentials       one password hash per user
--   auth_sessions          one row per signed-in device; what "sign this
--                          device out" ends
--   auth_refresh_tokens    the chain of refresh tokens a session has been
--                          issued, each usable once
--   password_reset_tokens  single-use links mailed to an administrator who
--                          forgot their password
--
-- NOTHING SECRET IS STORED IN A FORM THAT CAN BE USED. A password is a bcrypt
-- hash. A refresh token and a reset token are stored as the SHA-256 of the
-- value the client holds, so a copy of this database — a backup, a dump on a
-- laptop — cannot be replayed against the API.
--
-- THE HASH IS IN ITS OWN TABLE, not a column on `users`. `GET /api/users`
-- returns whole `users` rows, and the row-level-security policy on `users` lets
-- a signed-in browser read its own row through Supabase's REST endpoint for as
-- long as that endpoint exists. A column there would have been one `select *`
-- away from the network.
-- ---------------------------------------------------------------------------

create table if not exists user_credentials (
  user_id             uuid        primary key references users(id) on delete cascade,
  -- bcrypt, `$2a$` / `$2b$`. The hashes Supabase Auth made are this format and
  -- are copied in below as they are: nobody is asked to choose a new password.
  password_hash       text        not null,
  password_changed_at timestamptz not null default now()
);

comment on table user_credentials is
  'One bcrypt password hash per user, for the API''s own sign-in. Separate from users so that no query for a user row can return it.';

create table if not exists auth_sessions (
  -- Carried in every access token as the `sid` claim, and recorded on
  -- login_sessions.auth_session_id — the same column that held the Supabase
  -- session id — so Login History and per-device revocation need no change.
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  -- 'web' or 'mobile': which app signed in. Informational.
  client       text        not null default 'web',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  -- Pushed forward each time the session is refreshed; a device left unused
  -- past it has to sign in again.
  expires_at   timestamptz not null,
  -- Set by sign-out, by an administrator ending the session, and by the reuse
  -- of a spent refresh token. A revoked session is never revived.
  revoked_at   timestamptz
);

create index if not exists auth_sessions_user_live_idx on auth_sessions (user_id) where revoked_at is null;
create index if not exists auth_sessions_expires_at_idx on auth_sessions (expires_at);

comment on table auth_sessions is
  'One row per signed-in device. Its id is the `sid` claim of the access tokens issued for it and is what login_sessions.auth_session_id records.';

create table if not exists auth_refresh_tokens (
  -- SHA-256 (hex) of the token the client holds.
  token_hash text        primary key,
  session_id uuid        not null references auth_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- A refresh token is exchanged once for a new one. Seeing a spent token
  -- again, later than a short grace period, means two parties hold the chain —
  -- one of them is not the user — and the whole session is ended.
  used_at    timestamptz
);

create index if not exists auth_refresh_tokens_session_idx on auth_refresh_tokens (session_id);

comment on table auth_refresh_tokens is
  'The refresh tokens issued for a session, stored as SHA-256. Each is single-use; reuse of a spent one ends the session.';

create table if not exists password_reset_tokens (
  token_hash text        primary key,
  user_id    uuid        not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index if not exists password_reset_tokens_user_idx on password_reset_tokens (user_id);

comment on table password_reset_tokens is
  'Single-use password reset links, stored as SHA-256 of the token in the link.';

-- Row-level security ON with NO policy is "nobody, through Supabase's REST
-- endpoint": the anon and authenticated roles can reach nothing here. The API
-- connects as a role that bypasses RLS. The explicit revoke says the same thing
-- a second way, because these are the four tables where being wrong about it
-- matters most.
alter table user_credentials      enable row level security;
alter table auth_sessions         enable row level security;
alter table auth_refresh_tokens   enable row level security;
alter table password_reset_tokens enable row level security;

revoke all on table user_credentials, auth_sessions, auth_refresh_tokens, password_reset_tokens
  from public, anon, authenticated;

-- ── Carry the existing passwords over ───────────────────────────────────────
--
-- Supabase Auth stores bcrypt in auth.users.encrypted_password. Copied as they
-- are, every account signs in to the API with the password it already has.
--
-- Run again at any time before the old path is switched off: `do update` picks
-- up a password that was changed through Supabase Auth in the meantime. (While
-- both paths are live the API writes a new password to both places itself; this
-- is the catch-all for anything that did not go through the API.)
--
-- Skipped entirely on a database with no `auth` schema, which is what this one
-- becomes.
do $$
begin
  if to_regclass('auth.users') is not null then
    execute $sql$
      insert into public.user_credentials (user_id, password_hash, password_changed_at)
      select u.id, a.encrypted_password, coalesce(a.updated_at, now())
        from public.users u
        join auth.users a on a.id = u.id
       where a.encrypted_password ~ '^\$2[aby]\$'
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            password_changed_at = excluded.password_changed_at
        where public.user_credentials.password_hash is distinct from excluded.password_hash
    $sql$;
  end if;
end $$;

-- ── Ending sessions ─────────────────────────────────────────────────────────
--
-- The two functions Login History calls to sign a device out (migration 98),
-- rewritten to end the API's own session as well as the Supabase one. Same
-- names, same arguments, same return values, so nothing that calls them
-- changes. The Supabase half is reached through `execute`, guarded by
-- to_regclass: on a database without the `auth` schema it is simply not run,
-- and the function still compiles.
--
-- Still SECURITY DEFINER with a pinned search_path, for the reason migration 98
-- gives: while auth.sessions exists it belongs to another role.
-- ---------------------------------------------------------------------------
create or replace function revoke_auth_session(p_auth_session_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
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
  $$;

revoke all on function revoke_auth_session(uuid) from public;
grant execute on function revoke_auth_session(uuid) to service_role;

comment on function revoke_auth_session(uuid) is
  'End one signed-in device: revokes the API session with this id and, while Supabase Auth is still present, deletes the GoTrue session with the same id. True if either existed.';

create or replace function revoke_all_auth_sessions(
  p_user_id uuid,
  p_keep_auth_session_id uuid default null
)
  returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
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
  $$;

revoke all on function revoke_all_auth_sessions(uuid, uuid) from public;
grant execute on function revoke_all_auth_sessions(uuid, uuid) to service_role;

comment on function revoke_all_auth_sessions(uuid, uuid) is
  'End every signed-in device of one user, optionally keeping one session. Covers API sessions and, while Supabase Auth is still present, GoTrue sessions. Returns how many were ended.';

-- ── Deleting an account ─────────────────────────────────────────────────────
--
-- Migration 124's function, with the Supabase half made conditional in the same
-- way. The user's credentials, sessions and tokens go with the `users` row
-- (on delete cascade above).
create or replace function delete_user_account(p_user_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, app
  as $$
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
  $$;

revoke all on function delete_user_account(uuid) from public, anon, authenticated;
grant execute on function delete_user_account(uuid) to service_role;
