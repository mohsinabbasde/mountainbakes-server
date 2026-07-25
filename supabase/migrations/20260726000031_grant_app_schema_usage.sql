-- 31: grant the client roles USAGE on schema `app`.
--
-- Migration 01 created schema `app` and the JWT claim accessors inside it
-- (`app.jwt_role`, `app.jwt_branch_id`, `app.is_super_admin`). Nothing ever
-- granted `anon` / `authenticated` USAGE on that schema. Postgres does not grant
-- it implicitly: a freshly created schema is reachable only by its owner (the
-- migration runs as `postgres`), regardless of the EXECUTE privilege on the
-- functions inside it — EXECUTE is unusable without USAGE on the containing
-- schema.
--
-- That only ever mattered for the CLIENT-OWNED tables (migration 09, class B),
-- because those are the only policies evaluated with a user JWT — every other
-- table is reached by the Express API with the secret key, which bypasses RLS
-- and therefore never evaluates a policy at all. So the gap stayed invisible
-- until the browser read `notifications` directly:
--
--   notifications_select_own  ->  target_role = app.jwt_role()
--
-- Evaluating that policy as `authenticated` fails with
--   ERROR 42501: permission denied for schema app
-- and PostgREST turns the whole SELECT into an error response. The sibling read
-- of `notification_reads` succeeds in the same breath because its policies use
-- only `auth.uid()` — which is exactly the asymmetry the client sees today
-- ("[notifications] initial load failed" with the read-set loading fine).
--
-- Also unblocks the super-admin storage write policies in migration 10, which
-- call `app.is_super_admin()` under the user's JWT for direct-from-browser
-- uploads to the `branding` bucket.
--
-- Exposure: none beyond what the policies already imply. PostgREST only serves
-- the schemas in its `db-schemas` setting (`public`, `graphql_public`), so `app`
-- gains no HTTP surface from this grant; the functions merely become resolvable
-- during policy evaluation. They read `request.jwt.claims` — the caller's own
-- token — so a client can learn nothing from them it did not already send.

grant usage on schema app to anon, authenticated, service_role;

-- Explicit EXECUTE on the accessors the policies call. Postgres already grants
-- EXECUTE to PUBLIC by default, but stating it here means a later
-- `revoke ... from public` sweep (migration 09 did exactly that for
-- app.is_chat_participant) cannot silently break RLS again.
grant execute on function app.jwt_role()       to anon, authenticated;
grant execute on function app.jwt_branch_id()  to anon, authenticated;
grant execute on function app.is_super_admin() to anon, authenticated;
