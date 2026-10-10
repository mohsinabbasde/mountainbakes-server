-- ---------------------------------------------------------------------------
-- 98: Login & Active Session security.
--
-- Migration 85 built the login history as EVIDENCE — a row a human reads to
-- answer "when did this account sign in, and from where". This migration turns
-- it into something an admin can also ACT on: identify the account by a stable
-- staff number rather than an email address, tell one browser apart from
-- another, notice that the same account is live in three countries at once, and
-- actually end a session rather than relabel it.
--
-- What has NOT changed, and must not:
--
--   * Nothing here authorises anything. `login_sessions` is still read-only
--     input to a person's judgement, never to an access check. Every field that
--     originates on a client is still untrustworthy and still annotated as such.
--   * Duration and state are still DERIVED on read, never stored. A stored
--     `status` column would need a sweeper to move ACTIVE → EXPIRED, and every
--     scheduler in this app is switched off (see server.ts), so that column
--     would be wrong for exactly the sessions it exists to describe. The spec
--     this was built from asks for a five-value status; four of those five are
--     computed in `derive()` and the fifth (`SUSPICIOUS`) is a flag, because a
--     suspicious session is still an ACTIVE one and collapsing the two would
--     hide it from the active list an admin is looking at.
--   * RLS stays on with NO policies. The service-role API remains the only
--     reader, and that matters more after this migration than before it: these
--     rows now carry an admin's revocation trail.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The Mountain Bakes staff ID — `MBU-000125`.
--
-- WHY THE PREFIX IS NOT `MB-`. `MB-######` has meant a SALES ORDER since
-- migration 03 (`orders.order_number`, counter seeded at 124). Minting staff IDs
-- into the same namespace would make "MB-000125" ambiguous everywhere it is most
-- likely to be quoted — global search, an audit-log `details` string, a support
-- call — and no amount of context recovers which record was meant. `MBU-` keeps
-- the familiar shape and the six-digit padding of every other entity code in the
-- schema (EXP-, DMD-, PRC-, STK-) while staying unambiguous.
--
-- The counter-row UPDATE ... RETURNING is used rather than a SEQUENCE for the
-- reason migration 03 gives: a sequence leaves gaps on rollback. Because the
-- column default is VOLATILE, ADD COLUMN rewrites the table and evaluates it once
-- per existing row — so every account that already exists is back-filled with its
-- own unique number here, and every account created later is numbered without any
-- application code allocating one.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values ('users', 0) on conflict (id) do nothing;

create or replace function next_user_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'users' returning count into next_count;
    if not found then raise exception 'counters row "users" is missing'; end if;
    return 'MBU-' || lpad(next_count::text, 6, '0');
  end;
  $$;

alter table users
  add column user_code text not null unique default next_user_number();

comment on column users.user_code is
  'Mountain Bakes staff ID, MBU-000125. Human-readable, stable for the life of the account, and the identifier the security screens are read by so an email address does not have to be. Distinct from orders.order_number (MB-######) on purpose.';


-- ---------------------------------------------------------------------------
-- 2. Identity on the session row.
--
-- Denormalised alongside `user_email` for the reason 85 denormalised that one:
-- `user_id` is `on delete set null`, and deleting a staff account must not erase
-- the record of when it was used. After that delete the code is the only handle
-- left that reads like a person.
--
-- `auth_session_id` is the GoTrue session behind this row — the `session_id`
-- claim carried in the access token, copied off the VERIFIED token server-side
-- and never accepted from a body. It is what makes revocation real: without it
-- an admin can only relabel our own bookkeeping row, and the browser it was
-- meant to eject carries on refreshing its token indefinitely. Nullable, because
-- a token minted before this shipped has no claim to copy and a session opened
-- from one is still worth recording.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column user_code       text,
  add column auth_session_id uuid;

comment on column login_sessions.auth_session_id is
  'The GoTrue session this row describes (`session_id` claim, read off the verified access token). The handle revoke_auth_session() deletes by. Null for sessions opened before migration 98.';


-- ---------------------------------------------------------------------------
-- 3. Device, parsed once at insert.
--
-- The raw `user_agent` stays exactly as it was and remains the source of truth;
-- these are a PARSE of it, stored rather than computed on read for one reason —
-- an admin needs to filter and search by browser, and a filter that cannot be
-- expressed in SQL becomes a full-table fetch into the client. Parsing once at
-- insert also means every reader agrees, where a per-client regex drifts.
--
-- A user agent is a self-declaration and a famously dishonest one (Edge claims
-- to be Chrome, which claims to be Safari). These columns are therefore a
-- best-effort reading of an untrusted string, which is why the detail view still
-- shows the raw agent underneath them: a wrong guess stays visibly a guess.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column browser         text,
  add column browser_version text,
  add column os              text,
  add column os_version      text,
  add column device_type     text;

comment on column login_sessions.device_type is
  'desktop | mobile | tablet | bot | unknown. Parsed from user_agent at insert; the raw string is kept alongside because this is a guess.';


-- ---------------------------------------------------------------------------
-- 4. Timezone, resolved with the rest of the geo block.
--
-- Filled from the same IP lookup as country/city/region, in the same fail-open
-- way — a lookup that errors or is rate-limited leaves it null and the login is
-- still recorded. It is the IANA name of where the IP resolves to, NOT the
-- browser's own `Intl.DateTimeFormat().resolvedOptions().timeZone`: the browser's
-- value is client-reported and trivially edited, and a session claiming to be in
-- Karachi from a London address is precisely the disagreement worth being able
-- to see.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column timezone text;


-- ---------------------------------------------------------------------------
-- 5. Suspicion — a FLAG, not a state.
--
-- Set at session start by the detector in login-security.service.ts and never
-- cleared automatically. Deliberately orthogonal to active/ended/expired: a
-- suspicious session is still a live one, and folding it into the state would
-- drop it out of the Active Sessions list — the one screen an admin opens
-- BECAUSE it is suspicious.
--
-- `suspicious_reason` is prose written for a person, not a code to branch on.
-- The detector's rules are heuristics over VPNs, mobile carriers, corporate
-- proxies and an IP-geolocation database that is regularly wrong by a country;
-- a flag here means "worth a look", never "this account is compromised", and
-- nothing in the app is allowed to act on it automatically.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column is_suspicious    boolean not null default false,
  add column suspicious_reason text;


-- ---------------------------------------------------------------------------
-- 6. Revocation — who ended somebody else's session, and when.
--
-- Separate from `ended_at` on purpose. `ended_at` means the user left; these
-- mean an admin removed them, and conflating the two would erase the only
-- distinction the audit trail is kept for. A revoked row therefore carries BOTH:
-- `ended_at` so every duration calculation keeps working untouched, and
-- `revoked_at` / `revoked_by` so the history says who did it.
--
-- `end_reason` grows a third value for the same reason. 'expired' has still
-- never been written by any code path — it exists for a sweeper that does not
-- exist — and 'revoked' now joins 'logout' as the second value that is.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column revoked_at      timestamptz,
  add column revoked_by      uuid references users (id) on delete set null,
  add column revoked_by_name text,
  add column revoke_reason   text;

alter table login_sessions
  drop constraint login_sessions_end_reason_known;

alter table login_sessions
  add constraint login_sessions_end_reason_known check (
    end_reason is null or end_reason in ('logout', 'expired', 'revoked')
  );

-- A revoked row must name its revoker, and an un-revoked one must not pretend to
-- have been revoked. Cheap to state, and it is what stops a half-written
-- revocation reading as a complete one in the audit trail.
alter table login_sessions
  add constraint login_sessions_revocation_complete check (
    (revoked_at is null and revoked_by_name is null)
    or (revoked_at is not null and revoked_by_name is not null)
  );


-- ---------------------------------------------------------------------------
-- 7. Back-fill.
--
-- Existing rows get their owner's brand-new code. Sessions whose user was
-- already deleted keep a null code and their denormalised email, which is the
-- honest answer — there is no account left to have a number.
--
-- Device columns are deliberately NOT back-filled. Parsing thousands of historic
-- user agents in a migration would be slow, would bake one revision of the
-- parser into the data permanently, and buys nothing: the raw string is still on
-- every one of those rows, and the detail view reads it.
-- ---------------------------------------------------------------------------
update login_sessions s
   set user_code = u.user_code
  from users u
 where u.id = s.user_id
   and s.user_code is null;


-- ---------------------------------------------------------------------------
-- 8. Indexes.
--
-- Each backs a filter the Login History screen actually offers, and nothing
-- else. `login_at desc` is the second column on every one of them because the
-- list is always "most recent first" — an index on the filter column alone would
-- still leave a sort of the whole matching set.
--
-- The partial indexes are partial because the interesting rows are rare: a
-- handful of sessions are open at any moment, and a suspicious one is rarer
-- still. Holding the index to those rows keeps it small enough to stay in cache.
-- ---------------------------------------------------------------------------
create index login_sessions_user_code_idx on login_sessions (user_code, login_at desc)
  where user_code is not null;

create index login_sessions_country_idx on login_sessions (country, login_at desc)
  where country is not null;

create index login_sessions_suspicious_idx on login_sessions (login_at desc)
  where is_suspicious;

-- Revocation looks a row up by the GoTrue session it belongs to, and the
-- suspicion detector asks "has this account used this browser before".
create index login_sessions_auth_session_idx on login_sessions (auth_session_id)
  where auth_session_id is not null;

create index login_sessions_browser_idx on login_sessions (user_id, browser, os)
  where user_id is not null;


-- ---------------------------------------------------------------------------
-- 9. Actually ending a session.
--
-- A Supabase ACCESS token is stateless: nothing server-side can withdraw one
-- that has already been issued, and it stays valid until it expires. What CAN be
-- withdrawn is the session behind it — delete the `auth.sessions` row and the
-- refresh token cascades away with it (GoTrue's `auth.refresh_tokens.session_id`
-- is ON DELETE CASCADE), so the next refresh fails and the browser is out for
-- good.
--
-- That leaves a window of up to one access-token lifetime in which a revoked
-- browser can still call the API. The API closes it from the other side: the
-- ping every open tab already sends answers 403 on a revoked row and the client
-- signs itself out, so the practical lag is the two-minute ping tick, not the
-- hour. Neither half is sufficient alone — the ping can be ignored by a tampered
-- client, and the GoTrue delete is invisible until a refresh is due — and
-- together they cover each other. Both are documented at their call sites.
--
-- SECURITY DEFINER because `auth.sessions` belongs to the `supabase_auth_admin`
-- role and is not reachable by the service-role client through PostgREST at all.
-- The function therefore runs as ITS OWNER, which is the role that applies this
-- migration — `postgres` on Supabase, which holds the grants on the auth schema.
-- If a future `supabase db push` runs as something narrower, this is the
-- statement that fails, and it fails loudly at push rather than quietly at
-- runtime. Verify after the first deploy by revoking a session and confirming
-- the browser cannot refresh its token; a `revoked: 1, authSessionsEnded: 0`
-- from the API on a session that clearly had a live GoTrue row is the symptom.
-- The function is the entire hole punched through that wall, so it is kept as
-- narrow as it can be: it takes a session id, it deletes at most one row, it
-- returns whether it found one, and EXECUTE is revoked from every role except
-- service_role. `search_path` is pinned so no caller-controlled schema can
-- shadow `auth` — a SECURITY DEFINER function without that pin is the classic
-- privilege-escalation hole.
-- ---------------------------------------------------------------------------
create or replace function revoke_auth_session(p_auth_session_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
  declare removed integer;
  begin
    if p_auth_session_id is null then return false; end if;

    delete from auth.sessions where id = p_auth_session_id;
    get diagnostics removed = row_count;
    return removed > 0;
  end;
  $$;

revoke all on function revoke_auth_session(uuid) from public;
grant execute on function revoke_auth_session(uuid) to service_role;

comment on function revoke_auth_session(uuid) is
  'Delete one GoTrue session so its refresh token dies. service_role only. Returns false when the session was already gone, which is a normal outcome, not an error.';

/*
 * Every session for one account except, optionally, one.
 *
 * NOT a loop over the function above, and the difference is the point: this
 * deletes by `user_id`, so it also catches sessions `login_sessions` never
 * recorded — one opened before migration 85 shipped, one whose /start call was
 * lost to a dropped connection, one from a client that never called the API at
 * all. "Sign out everywhere" that only signs out the sessions we happen to know
 * about is a promise the button cannot keep.
 *
 * `p_keep_auth_session_id` is what lets an admin revoke their own account's
 * other devices without ejecting the browser they are sitting at.
 */
create or replace function revoke_all_auth_sessions(
  p_user_id uuid,
  p_keep_auth_session_id uuid default null
)
  returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
  declare removed integer;
  begin
    if p_user_id is null then return 0; end if;

    delete from auth.sessions
     where user_id = p_user_id
       and (p_keep_auth_session_id is null or id <> p_keep_auth_session_id);
    get diagnostics removed = row_count;
    return removed;
  end;
  $$;

revoke all on function revoke_all_auth_sessions(uuid, uuid) from public;
grant execute on function revoke_all_auth_sessions(uuid, uuid) to service_role;

comment on function revoke_all_auth_sessions(uuid, uuid) is
  'Delete every GoTrue session for one account, optionally sparing one. Deletes by user_id rather than by recorded session so it also reaches sessions login_sessions never saw. service_role only.';


comment on table login_sessions is
  'Login history and active sessions: who signed in, from which IP, resolved city and parsed browser, how long it lasted, whether it looked unusual, and who revoked it. Opened, pinged and closed by the client because a static-export app signs in to Supabase directly and the API never sees the login. Evidence for a human and a handle for an admin — never an authorisation input.';
