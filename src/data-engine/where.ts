/**
 * Data Engine — the condition tree.
 *
 * Scope, soft delete, caller filters and search all reduce to ONE tree of
 * `and` / `or` / leaf conditions. The list endpoint renders it as PostgREST
 * filters; the aggregate endpoint ships it, as JSON, to `data_engine_aggregate`
 * (migration 108), which renders it as SQL. Building both from the same tree is
 * what guarantees a dashboard card and the table under it count the same rows.
 */
import { businessDayBounds, karachiDayBounds } from '../shared';
import type { ResolvedFilter, ResolvedListQuery, ResourceConfig, ScopeRule } from './types';

export type LeafOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'ilike'
  | 'null'
  | 'notnull';

export type Leaf = { column: string; op: LeafOp; value?: unknown };
export type Condition = Leaf | { and: Condition[] } | { or: Condition[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayBounds(value: string, businessDay: boolean | undefined) {
  return businessDay ? businessDayBounds(value) : karachiDayBounds(value);
}

function castScalar(f: ResolvedFilter, value: string): unknown {
  switch (f.field.kind) {
    case 'number':
      return Number(value);
    case 'boolean':
      return value === 'true';
    default:
      return value;
  }
}

/** ILIKE pattern for a person's search term: wildcards escaped, wrapped in %. */
export function ilikePattern(raw: string): string {
  const term = raw.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
  return `%${term}%`;
}

export function scopeToCondition(rule: ScopeRule): Condition {
  if ('any' in rule) return { or: rule.any.map(scopeToCondition) };
  if ('all' in rule) return { and: rule.all.map(scopeToCondition) };
  switch (rule.op) {
    case 'is':
      return { column: rule.column, op: 'null' };
    case 'not':
      return { column: rule.column, op: 'notnull' };
    default:
      return { column: rule.column, op: rule.op, value: rule.value };
  }
}

export function filterToCondition(f: ResolvedFilter): Condition {
  const col = f.column;
  const isTimestamp = f.field.kind === 'timestamp';

  if (f.op === 'null' || f.op === 'notnull') return { column: col, op: f.op };

  if (Array.isArray(f.value)) {
    if (f.op === 'between') {
      const [a, b] = f.value as [string, string];
      if (isTimestamp) {
        return {
          and: [
            { column: col, op: 'gte', value: ISO_DATE.test(a) ? dayBounds(a, f.field.businessDay).fromISO : a },
            { column: col, op: 'lte', value: ISO_DATE.test(b) ? dayBounds(b, f.field.businessDay).toISO : b },
          ],
        };
      }
      return {
        and: [
          { column: col, op: 'gte', value: castScalar(f, a) },
          { column: col, op: 'lte', value: castScalar(f, b) },
        ],
      };
    }
    return { column: col, op: f.op === 'in' ? 'in' : 'nin', value: f.value.map((v) => castScalar(f, v)) };
  }

  const value = f.value as string;

  if (isTimestamp && ISO_DATE.test(value)) {
    // A whole day, on the resource's calendar (business or Karachi civil day).
    const { fromISO, toISO } = dayBounds(value, f.field.businessDay);
    switch (f.op) {
      case 'eq':
        return { and: [{ column: col, op: 'gte', value: fromISO }, { column: col, op: 'lte', value: toISO }] };
      case 'gte':
        return { column: col, op: 'gte', value: fromISO };
      case 'gt':
        return { column: col, op: 'gt', value: toISO };
      case 'lte':
        return { column: col, op: 'lte', value: toISO };
      case 'lt':
        return { column: col, op: 'lt', value: fromISO };
      default:
        break;
    }
  }

  if (f.op === 'like' || f.op === 'ilike') return { column: col, op: 'ilike', value: ilikePattern(value) };
  return { column: col, op: f.op as LeafOp, value: castScalar(f, value) };
}

function columnOfKey(config: ResourceConfig<unknown>, key: string): string {
  const field = config.fields.find((fd) => fd.key === key);
  return field?.column ?? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * The whole filtered set, as one tree:
 *
 *   AND( scope…, soft-delete, filters…, OR(search columns…) )
 */
export function buildCondition<Row>(
  config: ResourceConfig<Row>,
  resolved: Omit<ResolvedListQuery, 'page' | 'pageSize' | 'sort'>,
  scopeRules: ScopeRule[],
): { and: Condition[] } {
  const parts: Condition[] = scopeRules.map(scopeToCondition);

  if (config.softDelete && !resolved.includeDeleted) {
    parts.push({ column: config.softDelete.column ?? 'deleted_at', op: 'null' });
  }

  for (const f of resolved.filters) parts.push(filterToCondition(f));

  const search = resolved.search.trim();
  const searchable = config.searchableFields ?? [];
  if (search && searchable.length > 0) {
    const pattern = ilikePattern(search);
    parts.push({ or: searchable.map((key) => ({ column: columnOfKey(config, key), op: 'ilike', value: pattern })) });
  }

  return { and: parts };
}

// ---------------------------------------------------------------------------
// PostgREST rendering
// ---------------------------------------------------------------------------

/** The slice of PostgREST's filter builder the engine uses. */
export interface FilterableQuery {
  eq(column: string, value: unknown): this;
  neq(column: string, value: unknown): this;
  gt(column: string, value: unknown): this;
  gte(column: string, value: unknown): this;
  lt(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  in(column: string, values: readonly unknown[]): this;
  ilike(column: string, pattern: string): this;
  is(column: string, value: boolean | null): this;
  not(column: string, operator: string, value: unknown): this;
  or(filters: string): this;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string },
  ): this;
  range(from: number, to: number): this;
  limit(count: number): this;
}

/**
 * A value inside PostgREST's logic-tree syntax. Anything that could be read as
 * syntax — a comma, a parenthesis, a dot, whitespace — is double-quoted, which
 * PostgREST accepts for every operator.
 */
function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  return /[,.()"\s:]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

/** ILIKE inside the logic tree spells its wildcard `*`, not `%`. */
function likeValue(pattern: string): string {
  return quoteValue(pattern.replace(/%/g, '*'));
}

function renderLeaf(leaf: Leaf): string {
  switch (leaf.op) {
    case 'null':
      return `${leaf.column}.is.null`;
    case 'notnull':
      return `${leaf.column}.not.is.null`;
    case 'in':
      return `${leaf.column}.in.(${(leaf.value as unknown[]).map(quoteValue).join(',')})`;
    case 'nin':
      return `${leaf.column}.not.in.(${(leaf.value as unknown[]).map(quoteValue).join(',')})`;
    case 'ilike':
      return `${leaf.column}.ilike.${likeValue(String(leaf.value))}`;
    default:
      return `${leaf.column}.${leaf.op}.${quoteValue(leaf.value)}`;
  }
}

function renderLogic(node: Condition): string {
  if ('and' in node) return `and(${node.and.map(renderLogic).join(',')})`;
  if ('or' in node) return `or(${node.or.map(renderLogic).join(',')})`;
  return renderLeaf(node);
}

/** Apply a top-level leaf with the typed builder method — no string quoting to get wrong. */
function applyLeaf<Q extends FilterableQuery>(query: Q, leaf: Leaf): Q {
  switch (leaf.op) {
    case 'eq':
      return query.eq(leaf.column, leaf.value);
    case 'neq':
      return query.neq(leaf.column, leaf.value);
    case 'gt':
      return query.gt(leaf.column, leaf.value);
    case 'gte':
      return query.gte(leaf.column, leaf.value);
    case 'lt':
      return query.lt(leaf.column, leaf.value);
    case 'lte':
      return query.lte(leaf.column, leaf.value);
    case 'in':
      return query.in(leaf.column, leaf.value as unknown[]);
    case 'nin':
      return query.not(leaf.column, 'in', `(${(leaf.value as unknown[]).map(quoteValue).join(',')})`);
    case 'ilike':
      return query.ilike(leaf.column, String(leaf.value));
    case 'null':
      return query.is(leaf.column, null);
    case 'notnull':
      return query.not(leaf.column, 'is', null);
  }
}

/** Apply the tree to a PostgREST query. The root is always an AND list. */
export function applyCondition<Q extends FilterableQuery>(query: Q, root: { and: Condition[] }): Q {
  for (const node of root.and) {
    if ('and' in node) query = applyCondition(query, node);
    else if ('or' in node) query = query.or(node.or.map(renderLogic).join(','));
    else query = applyLeaf(query, node);
  }
  return query;
}
