-- 115: Finance Queries — a simple, standalone finance record.
--
-- This is deliberately NOT the Finance Help Desk ticket system
-- (finance_tickets, migration 60+): a Finance Query IS the finance record —
-- Date, Title, Amount, Category, Branch, Type (income/expense), Comment — one
-- flat row, no reference to another table, no versioning. See
-- ../../frontend/.claude/ProjectMDFiles/chagneQuery.md for the brief this
-- implements.
--
-- Query numbers are gapless via the same counters-row pattern as orders and
-- expenses (migrations 000003, 000024), not a SEQUENCE — same reasoning:
-- sequences leave gaps on rollback.

insert into counters (id, count) values ('finance_queries', 0)
  on conflict (id) do nothing;

create or replace function next_finance_query_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'finance_queries' returning count into next_count;
    if not found then raise exception 'counters row "finance_queries" is missing'; end if;
    return 'FIN-' || lpad(next_count::text, 3, '0');
  end;
  $$;

create table finance_queries (
  id              uuid primary key default gen_random_uuid(),
  query_no        text not null unique default next_finance_query_number(),
  business_date   date not null,
  title           text not null,
  amount          numeric(14,2) not null check (amount > 0),
  -- Free text, like expenses.category: the vocabulary can grow without a
  -- migration, and a historical row keeps whatever was stored even if a
  -- suggested value is later retired.
  category        text not null,
  branch_id       uuid not null references branches (id) on delete restrict,
  branch_name     text,
  -- A single field is how "never both Income and Expense" is enforced — one
  -- flag, not two amount columns.
  type            text not null check (type in ('income', 'expense')),
  comment         text,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references users (id) on delete set null,
  updated_by_name text
);

create index finance_queries_branch_date_idx on finance_queries (branch_id, business_date desc);
create index finance_queries_created_idx     on finance_queries (created_at);
create index finance_queries_type_idx        on finance_queries (type);

create trigger finance_queries_touch before update on finance_queries
  for each row execute function app.touch_updated_at();
