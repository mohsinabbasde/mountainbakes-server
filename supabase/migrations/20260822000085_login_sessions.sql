-- ---------------------------------------------------------------------------
-- login_sessions — who signed in, from where, and for how long.
--
-- WHY THE CLIENT REPORTS THIS. The app is a static export and signs in by
-- calling Supabase Auth directly from the browser; the API is never in the
-- request path of a login and cannot observe one. So a session is opened by an
-- explicit POST from the client after `signInWithPassword` succeeds, kept alive
-- by the pings the open tab already sends on its 2-minute refresh tick, and
-- closed either by an explicit sign-out or by falling silent.
--
-- THE ROW IS EVIDENCE, NOT AN ACCESS DECISION. Nothing authorises against it.
-- Every field except the timestamps originates on the client or in an
-- untrustworthy header, so a determined account could lie about all of it — the
-- same stance `geofence_logs` takes, and for the same reason. It is here so a
-- human can read it.
--
-- DURATION IS DERIVED, NEVER STORED. `coalesce(ended_at, last_seen_at) -
-- login_at`. Storing a duration column would mean writing it on every ping and
-- would still be wrong for a tab that was closed rather than signed out. There
-- is also deliberately NO cron sweeping stale sessions closed: every scheduler
-- in this app is switched off (see server.ts), so anything depending on one
-- would quietly never run. A session with no recent ping is treated as ended at
-- its last ping when it is READ.
-- ---------------------------------------------------------------------------
create table login_sessions (
  id                uuid primary key default gen_random_uuid(),

  -- `on delete set null` with the identity denormalised alongside, matching
  -- audit_logs and geofence_logs: deleting a staff account must not erase the
  -- history of when that account was used, and the email is the column the
  -- table is actually read by.
  user_id           uuid references users (id) on delete set null,
  user_email        text,
  user_name         text,
  user_role         user_role,
  branch_id         uuid references branches (id) on delete set null,
  branch_name       text,

  -- Device context. `text` rather than `inet` for the reason geofence_logs
  -- gives: an X-Forwarded-For chain is a comma-joined list and `inet` rejects it.
  ip_address        text,
  user_agent        text,

  -- Resolved from ip_address at session start, best-effort and fail-open — a
  -- lookup that errors, times out or is rate-limited leaves these null and the
  -- login is still recorded. Never resolved again afterwards: the answer for an
  -- IP does not change within a session, and re-resolving on every ping would
  -- burn the provider's quota for nothing.
  country           text,
  country_code      text,
  city              text,
  region            text,

  login_at          timestamptz not null default now(),
  -- Bumped by every ping. For a tab that is closed rather than signed out, this
  -- is the only honest end of the session.
  last_seen_at      timestamptz not null default now(),
  -- Set ONLY by an explicit sign-out. A session that simply stopped pinging is
  -- left null here and reported as expired on read — the distinction is real and
  -- worth keeping: one means the user left, the other means the tab did.
  ended_at          timestamptz,
  end_reason        text,

  business_date     date not null,
  created_at        timestamptz not null default now(),

  constraint login_sessions_end_reason_known check (
    end_reason is null or end_reason in ('logout', 'expired')
  )
);

-- The list is always "most recent first", either for everybody (admin) or for
-- one user. Both are served by these two.
create index login_sessions_login_at_idx on login_sessions (login_at desc);
create index login_sessions_user_idx     on login_sessions (user_id, login_at desc);

-- Resuming a session on a page reload looks a live row up by user; keeping it
-- partial holds the index to the handful of sessions that are actually open.
create index login_sessions_open_idx on login_sessions (user_id, last_seen_at desc)
  where ended_at is null;

-- RLS on with NO policies, the same stance as idempotency_keys, finance_tickets
-- and branch_user_requests: the service-role API is the only reader and bypasses
-- RLS. No browser touches this table directly — and here that matters more than
-- usual, because a policy permissive enough for a user to insert their own row
-- would also let them forge one.
alter table login_sessions enable row level security;

comment on table login_sessions is
  'Login history: who signed in, from which IP and resolved city, and how long the session lasted. Opened, pinged and closed by the client because a static-export app signs in to Supabase directly and the API never sees the login. Evidence for a human, never an authorisation input.';
