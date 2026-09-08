/**
 * Data Engine — build and run the Supabase query for a resolved list query.
 *
 * Order of application is the security argument:
 *
 *   scope (from the JWT) → soft delete → caller filters → search → sort → range
 *
 * Scope goes first and is ANDed with everything after it, so a caller's own
 * filters can only narrow the rows their role already allows. Nothing here
 * accepts a column name from the request; `parseListQuery` has already mapped
 * every field to the column the resource config declared, and `where.ts`
 * turns the lot into one condition tree.
 */
import { supabaseAdmin } from '../config/supabase';
import type { PaginatedResponse } from '../shared';
import { rowToApi } from '../utils/case';
import type { AuthUser, ResolvedListQuery, ResourceConfig, ScopeRule } from './types';
import { applyCondition, buildCondition, type FilterableQuery } from './where';

export type { FilterableQuery } from './where';

export async function resolveScope<Row>(config: ResourceConfig<Row>, user: AuthUser): Promise<ScopeRule[]> {
  return (await config.scope?.(user)) ?? [];
}

/**
 * Everything but the page window: scope, soft delete, filters, search, sort.
 * Shared by the list and export paths so the two can never disagree about
 * which rows are "the filtered set"; the aggregate path uses the same
 * `buildCondition` tree rendered as SQL.
 */
export function buildFilteredQuery<Q extends FilterableQuery, Row>(
  query: Q,
  config: ResourceConfig<Row>,
  resolved: Omit<ResolvedListQuery, 'page' | 'pageSize'>,
  scopeRules: ScopeRule[],
  opts: { sort?: boolean } = { sort: true },
): Q {
  query = applyCondition(query, buildCondition(config, resolved, scopeRules));

  // `sort: false` is the count-only shape (HEAD, `select id`): no ordering at
  // all, including embedded relations — PostgREST refuses an order on an
  // embed the select does not include.
  if (opts.sort === false) return query;

  if (resolved.sort) {
    query = query.order(resolved.sort.column, { ascending: resolved.sort.ascending, nullsFirst: false });
    // A stable tiebreaker so two rows with the same sort value never swap
    // pages between requests.
    const tie = config.tiebreaker ?? { column: 'id', ascending: true };
    if (resolved.sort.column !== tie.column) query = query.order(tie.column, { ascending: tie.ascending });
  }

  for (const embed of config.embedOrder ?? []) {
    query = query.order(embed.column, { referencedTable: embed.referencedTable, ascending: embed.ascending ?? true });
  }

  return query;
}

export function paginate<T>(rows: T[], total: number, page: number, pageSize: number): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    data: rows,
    page,
    pageSize,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** Run one page. Rows come back camelCase and, if configured, transformed. */
export async function runListQuery<Row>(
  config: ResourceConfig<Row>,
  resolved: ResolvedListQuery,
  user: AuthUser,
): Promise<PaginatedResponse<Row>> {
  const scopeRules = await resolveScope(config, user);
  const base = supabaseAdmin.from(config.table).select(config.select ?? '*', { count: 'exact' });
  let query = buildFilteredQuery(base as unknown as FilterableQuery, config, resolved, scopeRules);

  const fromRow = (resolved.page - 1) * resolved.pageSize;
  query = query.range(fromRow, fromRow + resolved.pageSize - 1);

  const { data, error, count } = await (query as unknown as typeof base);
  if (error) {
    // PGRST103: the page starts past the last row — the set shrank under a
    // pager that still points at page 6. That is an empty page with an honest
    // total, not a failure; the client resets to a page that exists.
    if ((error as { code?: string }).code === 'PGRST103' && resolved.page > 1) {
      const head = supabaseAdmin.from(config.table).select('id', { count: 'exact', head: true });
      const counted = buildFilteredQuery(head as unknown as FilterableQuery, config, resolved, scopeRules, { sort: false });
      const { count: total, error: countError } = await (counted as unknown as typeof head);
      if (countError) throw countError;
      return paginate([] as Row[], total ?? 0, resolved.page, resolved.pageSize);
    }
    throw error;
  }

  const camel = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) =>
    rowToApi<Record<string, unknown>>(row),
  );
  const rows = (config.transform ? config.transform(camel, user) : camel) as Row[];
  return paginate(rows, count ?? 0, resolved.page, resolved.pageSize);
}

/**
 * Every row of the filtered set, for exports. Walks the result in 1 000-row
 * windows (PostgREST's default max) up to `maxRows`, so a 9 000-row export is
 * nine requests rather than one that the API's row limit silently truncates.
 */
export async function runFullQuery<Row>(
  config: ResourceConfig<Row>,
  resolved: Omit<ResolvedListQuery, 'page' | 'pageSize'>,
  user: AuthUser,
  maxRows: number,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const WINDOW = 1000;
  const out: Record<string, unknown>[] = [];
  const scopeRules = await resolveScope(config, user);

  for (let offset = 0; offset < maxRows; offset += WINDOW) {
    const base = supabaseAdmin.from(config.table).select(config.select ?? '*');
    let query = buildFilteredQuery(base as unknown as FilterableQuery, config, resolved, scopeRules);
    const windowEnd = Math.min(offset + WINDOW, maxRows);
    query = query.range(offset, windowEnd - 1);
    const { data, error } = await (query as unknown as typeof base);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch.map((row) => rowToApi<Record<string, unknown>>(row)));
    if (batch.length < windowEnd - offset) break;
  }

  const rows = (config.transform ? config.transform(out, user) : out) as Row[];
  // Hit the ceiling with a full final window: there may be more rows.
  return { rows, truncated: out.length >= maxRows };
}
