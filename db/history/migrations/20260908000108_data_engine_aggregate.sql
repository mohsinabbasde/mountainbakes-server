-- 108: Data Engine — server-side aggregation over the same filter tree the
-- generic list endpoint uses.
--
-- PostgREST's aggregate functions are switched off on this database
-- (PGRST123 "Use of aggregate functions is not allowed"), so a dashboard card
-- that wants SUM(grand_total) over "the rows this table is showing" has two
-- options: pull every filtered row down to the API and add them up there, or
-- ask Postgres. This function is the second option.
--
-- What it accepts is deliberately narrow:
--
--   p_table     one of the tables the API's resource registry publishes
--               (`src/data-engine/registry.ts`); anything else is refused
--   p_where     a jsonb tree the API built — {and:[…]}, {or:[…]} or a leaf
--               {column, op, value}. Every column is checked against
--               information_schema before it is interpolated, and every value
--               goes through quote_literal. The API never sends raw SQL.
--   p_metrics   [{metric, column}] — count | sum | avg | min | max
--   p_group_by  columns to GROUP BY, checked the same way
--
-- It is called ONLY by the API's service-role client. EXECUTE is revoked from
-- anon and authenticated so a browser holding a Supabase JWT cannot reach it
-- directly and count rows its role may not see: the scoping lives in the API,
-- which puts the caller's branch/user restriction INTO p_where before calling.
--
-- The table allowlist is a literal here and mirrors the registry by hand.
-- Adding a resource to the registry that should aggregate means adding its
-- table here too; a table missing from this list fails loudly with a clear
-- message rather than quietly returning nothing.

create or replace function app.data_engine_condition(p_table text, p_node jsonb)
  returns text
  language plpgsql
  stable
  as $$
  declare
    v_parts text[] := '{}';
    v_child jsonb;
    v_column text;
    v_op text;
    v_value jsonb;
    v_ident text;
    v_list text[];
    v_item jsonb;
  begin
    if p_node is null or p_node = 'null'::jsonb then
      return 'true';
    end if;

    if p_node ? 'and' then
      for v_child in select * from jsonb_array_elements(p_node -> 'and') loop
        v_parts := array_append(v_parts, app.data_engine_condition(p_table, v_child));
      end loop;
      if coalesce(array_length(v_parts, 1), 0) = 0 then return 'true'; end if;
      return '(' || array_to_string(v_parts, ' and ') || ')';
    end if;

    if p_node ? 'or' then
      for v_child in select * from jsonb_array_elements(p_node -> 'or') loop
        v_parts := array_append(v_parts, app.data_engine_condition(p_table, v_child));
      end loop;
      if coalesce(array_length(v_parts, 1), 0) = 0 then return 'false'; end if;
      return '(' || array_to_string(v_parts, ' or ') || ')';
    end if;

    v_column := p_node ->> 'column';
    v_op := p_node ->> 'op';
    v_value := p_node -> 'value';

    if v_column is null or v_op is null then
      raise exception 'data_engine: malformed condition %', p_node using errcode = '22023';
    end if;

    -- The column must exist on the table. This is the check that makes
    -- format('%I') safe: an identifier is quoted, but it is also REAL.
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_column
    ) then
      raise exception 'data_engine: unknown column % on %', v_column, p_table using errcode = '42703';
    end if;

    v_ident := format('%I', v_column);

    case v_op
      when 'null'    then return v_ident || ' is null';
      when 'notnull' then return v_ident || ' is not null';
      when 'eq'      then return v_ident || ' = '  || app.data_engine_literal(v_value);
      when 'neq'     then return v_ident || ' <> ' || app.data_engine_literal(v_value);
      when 'gt'      then return v_ident || ' > '  || app.data_engine_literal(v_value);
      when 'gte'     then return v_ident || ' >= ' || app.data_engine_literal(v_value);
      when 'lt'      then return v_ident || ' < '  || app.data_engine_literal(v_value);
      when 'lte'     then return v_ident || ' <= ' || app.data_engine_literal(v_value);
      when 'ilike'   then return v_ident || ' ilike ' || app.data_engine_literal(v_value);
      when 'in', 'nin' then
        if jsonb_typeof(v_value) <> 'array' then
          raise exception 'data_engine: % needs an array', v_op using errcode = '22023';
        end if;
        v_list := '{}';
        for v_item in select * from jsonb_array_elements(v_value) loop
          v_list := array_append(v_list, app.data_engine_literal(v_item));
        end loop;
        if coalesce(array_length(v_list, 1), 0) = 0 then
          -- IN () is a syntax error in SQL; the honest answer to "in nothing"
          -- is no rows (and "not in nothing" is every row).
          return case when v_op = 'in' then 'false' else 'true' end;
        end if;
        return v_ident || case when v_op = 'in' then ' in (' else ' not in (' end
               || array_to_string(v_list, ', ') || ')';
      else
        raise exception 'data_engine: unsupported operator %', v_op using errcode = '22023';
    end case;
  end;
  $$;

-- A jsonb scalar as a SQL literal. Strings are quote_literal'd; numbers and
-- booleans pass through as their text; null is NULL. Postgres coerces the
-- unknown-typed literal to the column's type at plan time, so '2026-09-08T…'
-- compares correctly against a timestamptz and '12.5' against a numeric.
create or replace function app.data_engine_literal(p_value jsonb)
  returns text
  language sql
  immutable
  as $$
    select case jsonb_typeof(p_value)
      when 'string'  then quote_literal(p_value #>> '{}')
      when 'number'  then (p_value #>> '{}')
      when 'boolean' then (p_value #>> '{}')
      when 'null'    then 'null'
      else quote_literal(p_value::text)
    end;
  $$;

create or replace function public.data_engine_aggregate(
  p_table text,
  p_where jsonb,
  p_metrics jsonb,
  p_group_by text[] default '{}'
)
  returns setof jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public, app
  as $$
  declare
    -- Mirrors src/data-engine/registry.ts. Keep in step by hand.
    v_allowed constant text[] := array[
      'orders', 'production_orders', 'production_stock_history', 'stock_history',
      'stock_audit_log', 'daily_closing_reports', 'daily_sale_records', 'expenses',
      'finance_income_approvals', 'ledger_entries', 'finance_transactions',
      'finance_tickets', 'finance_audit_logs', 'products', 'customers', 'users',
      'login_sessions', 'login_attempts', 'support_tickets', 'audit_logs'
    ];
    v_select text[] := '{}';
    v_group text[] := '{}';
    v_metric jsonb;
    v_fn text;
    v_col text;
    v_key text;
    v_sql text;
  begin
    if not (p_table = any (v_allowed)) then
      raise exception 'data_engine: table % is not published', p_table using errcode = '42501';
    end if;

    foreach v_col in array coalesce(p_group_by, '{}') loop
      if not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_col
      ) then
        raise exception 'data_engine: unknown group column % on %', v_col, p_table using errcode = '42703';
      end if;
      v_group := array_append(v_group, format('%I', v_col));
      v_select := array_append(v_select, format('%I', v_col));
    end loop;

    if p_metrics is null or jsonb_typeof(p_metrics) <> 'array' or jsonb_array_length(p_metrics) = 0 then
      raise exception 'data_engine: at least one metric is required' using errcode = '22023';
    end if;

    for v_metric in select * from jsonb_array_elements(p_metrics) loop
      v_fn := v_metric ->> 'metric';
      v_col := v_metric ->> 'column';
      if v_fn = 'count' then
        -- array_append, not ||: an untyped literal on the right of || is read
        -- as an array literal and fails on the quotes.
        v_select := array_append(v_select, 'count(*)::bigint as "count"');
        continue;
      end if;
      if v_fn not in ('sum', 'avg', 'min', 'max') then
        raise exception 'data_engine: unsupported metric %', v_fn using errcode = '22023';
      end if;
      if v_col is null or not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = p_table and c.column_name = v_col
      ) then
        raise exception 'data_engine: unknown metric column % on %', v_col, p_table using errcode = '42703';
      end if;
      -- Keyed "sum:column" so the API can hand the row straight back.
      v_key := v_fn || ':' || v_col;
      v_select := array_append(v_select, format('%s(%I) as %I', v_fn, v_col, v_key));
    end loop;

    v_sql := format(
      'select to_jsonb(t) from (select %s from public.%I where %s%s) t',
      array_to_string(v_select, ', '),
      p_table,
      app.data_engine_condition(p_table, p_where),
      case when coalesce(array_length(v_group, 1), 0) > 0
           then ' group by ' || array_to_string(v_group, ', ') || ' order by ' || array_to_string(v_group, ', ')
           else '' end
    );

    return query execute v_sql;
  end;
  $$;

comment on function public.data_engine_aggregate(text, jsonb, jsonb, text[]) is
  'Data Engine aggregation. Called by the API service role only; browsers are revoked below.';

revoke execute on function public.data_engine_aggregate(text, jsonb, jsonb, text[]) from public, anon, authenticated;
revoke execute on function app.data_engine_condition(text, jsonb) from public, anon, authenticated;
revoke execute on function app.data_engine_literal(jsonb) from public, anon, authenticated;
