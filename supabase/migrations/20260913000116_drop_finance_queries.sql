-- 116: Remove the Finance Query feature (migration 115) — the standalone
-- finance-record CRUD is being removed at the product owner's request, in
-- favour of the existing Finance Help Desk workflow. This does not touch
-- finance_tickets or any other Help Desk table.

drop trigger if exists finance_queries_touch on finance_queries;
drop table if exists finance_queries;
drop function if exists next_finance_query_number();
delete from counters where id = 'finance_queries';
