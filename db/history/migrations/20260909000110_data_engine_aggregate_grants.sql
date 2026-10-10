-- 110: let the API's service role actually call the Data Engine aggregate.
--
-- Migration 108 revoked EXECUTE on all three functions from `public`, `anon`
-- and `authenticated`, so a browser holding a Supabase JWT cannot reach them
-- and count rows its role may not see. That part was right and stays.
--
-- What it got wrong: `service_role` was never granted EXECUTE on the two
-- helpers in the `app` schema, and revoking the PUBLIC grant is what it had
-- been relying on. `public.data_engine_aggregate` kept working — Supabase's
-- default privileges on the `public` schema grant it to service_role
-- explicitly — but its first call into `app.data_engine_condition` failed with
--
--   42501: permission denied for function data_engine_condition
--
-- so every non-count aggregate 500'd. Observed immediately after 108 was
-- applied, which is how this file came to exist.
--
-- The fix is an explicit grant to service_role, NOT `security definer` on the
-- aggregate. That function builds dynamic SQL; running it as its owner would
-- make the table allowlist and the information_schema column checks the only
-- thing standing between a caller and arbitrary reads. Keeping it
-- `security invoker` means it can never do more than the role that called it,
-- and the API is the only role that may call it at all.

grant execute on function app.data_engine_condition(text, jsonb) to service_role;
grant execute on function app.data_engine_literal(jsonb) to service_role;
grant execute on function public.data_engine_aggregate(text, jsonb, jsonb, text[]) to service_role;

-- Re-assert the other half, so this file is a complete statement of who may
-- call these and can be read on its own.
revoke execute on function app.data_engine_condition(text, jsonb) from public, anon, authenticated;
revoke execute on function app.data_engine_literal(jsonb) from public, anon, authenticated;
revoke execute on function public.data_engine_aggregate(text, jsonb, jsonb, text[]) from public, anon, authenticated;
