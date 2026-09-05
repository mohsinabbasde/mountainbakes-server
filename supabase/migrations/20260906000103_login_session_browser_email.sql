-- ---------------------------------------------------------------------------
-- 103: The browser's Google account on a login session.
--
-- The Login History screen is asked to show TWO addresses per row, and they are
-- different facts:
--
--   user_email     — the Mountain Bakes account the session authenticated as
--                    (ahmed@mountainbakes.com). Present on every row since 85.
--   browser_email  — the Google account the person signed in WITH, when they
--                    signed in with Google (arifsiksavi@gmail.com). This column.
--
-- WHAT THIS CAN AND CANNOT BE. A website cannot read which Google account the
-- Chrome profile is signed into: the browser does not expose it, and nothing
-- here tries — no cookies, no profile data, no client-side guessing. The only
-- honest source is a Google identity the person has AUTHENTICATED to Mountain
-- Bakes with, through Supabase Auth's Google provider. So this column is filled
-- by the API from the verified token's identities, only for a session whose
-- `amr` claim says it was opened through OAuth, and is NULL otherwise — a
-- password login, or a project where the Google provider is not enabled.
--
-- NEVER BACK-FILLED, NEVER DEFAULTED. Copying user_email into it would make an
-- unknown look known, which is the one thing a security screen must not do; an
-- old row reads "Not recorded". Nullable text, no index: it is read by row and
-- searched only through the admin's ilike search, which no btree would serve.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column browser_email text;

comment on column login_sessions.browser_email is
  'Verified Google account the session signed in with, read server-side from the authenticated identities when the session was opened through OAuth. Null for a password login or when no Google identity is verified. Distinct from user_email (the Mountain Bakes account) and never copied from it.';
