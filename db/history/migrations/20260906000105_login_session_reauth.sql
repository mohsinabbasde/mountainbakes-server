-- ---------------------------------------------------------------------------
-- 105: 'reauth' — a session ended because the browser authenticated again.
--
-- Until now a login_sessions row could end three ways: the person signed out
-- ('logout'), the tab went quiet ('expired', reserved), or an admin ended it
-- ('revoked'). A fourth happens in practice and had no name: the browser
-- obtained a NEW GoTrue session while the old row was still live. Concretely,
-- "Connect Google account" — GoTrue's identity-link flow issues a fresh session
-- with the Google identity attached and sends the browser back to the
-- dashboard, where the client offers up the id of the row it already held.
--
-- The API used to accept that offer: same user, not ended, seen recently, so
-- it resumed the PASSWORD row — and the Browser email column stayed "Not
-- recorded" for a browser that had, that very second, signed in with Google.
-- Nothing was wrong with the Google identity, the column or the frontend;
-- the row the screen showed was simply the old one.
--
-- The API now also compares the row's auth_session_id with the token's. On a
-- mismatch the old row is closed with this reason and a new row is opened
-- with whatever identity the new token carries. Two rows, both true: one
-- password session that ended when the person re-authenticated, one Google
-- session that began then. 'logout' would have said the person signed out,
-- which they did not; leaving the row to expire would have shown two live
-- sessions from one browser for ten minutes on the Active Sessions screen.
--
-- Pure constraint widening — no data changes, no backfill.
-- ---------------------------------------------------------------------------
alter table login_sessions
  drop constraint login_sessions_end_reason_known;

alter table login_sessions
  add constraint login_sessions_end_reason_known check (
    end_reason is null or end_reason in ('logout', 'expired', 'revoked', 'reauth')
  );
