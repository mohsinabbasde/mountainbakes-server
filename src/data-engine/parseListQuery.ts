/**
 * Data Engine — turn `req.query` into a validated {@link ResolvedListQuery}.
 *
 * Wire format (identical to what the client keeps in its own URL):
 *
 *   page=2  pageSize=50  search=cake  sort=createdAt:desc  includeDeleted=1
 *   status=completed                 → eq
 *   createdAt.gte=2026-09-01         → operator after a dot
 *   status.in=pending&status.in=ready → repeated param for list operators
 *   amount.between=100&amount.between=500
 *   notes.null=1                     → unary operators take any truthy value
 *
 * Every filter names a FIELD from the resource config, never a column. An
 * unknown field, a disallowed operator, or a malformed value is a 400 with the
 * field named — not a PostgREST error about a column the caller was never told
 * existed.
 */
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  FILTER_OPERATORS,
  PAGE_SIZES,
  type FilterOperator,
  type UserRole,
} from '../shared';
import { camelToSnake } from '../utils/case';
import type { FieldDef, FieldKind, ResolvedFilter, ResolvedListQuery, ResourceConfig } from './types';

export class ListQueryError extends Error {
  status = 400;
  constructor(
    message: string,
    public details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
  }
}

const RESERVED = new Set(['page', 'pageSize', 'search', 'sort', 'includeDeleted', 'resource']);

/** Operators each kind of field accepts, before any per-field narrowing. */
const OPERATORS_BY_KIND: Record<FieldKind, FilterOperator[]> = {
  text: ['eq', 'neq', 'like', 'ilike', 'in', 'nin', 'null', 'notnull'],
  enum: ['eq', 'neq', 'in', 'nin', 'null', 'notnull'],
  uuid: ['eq', 'neq', 'in', 'nin', 'null', 'notnull'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'null', 'notnull'],
  boolean: ['eq', 'neq', 'null', 'notnull'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'null', 'notnull'],
  timestamp: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'null', 'notnull'],
};

export function operatorsFor(field: FieldDef): FilterOperator[] {
  const base = OPERATORS_BY_KIND[field.kind];
  return field.operators ? base.filter((op) => field.operators!.includes(op)) : base;
}

export function columnOf(field: FieldDef): string {
  return field.column ?? camelToSnake(field.key);
}

const LIST_OPERATORS = new Set<FilterOperator>(['in', 'nin', 'between']);
const UNARY_OPERATORS = new Set<FilterOperator>(['null', 'notnull']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ReservedSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), {
      message: `pageSize must be one of ${PAGE_SIZES.join(', ')}`,
    })
    .default(DEFAULT_PAGE_SIZE),
  search: z.string().trim().max(200).default(''),
  sort: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]*:(asc|desc)$/, 'sort must look like field:asc or field:desc')
    .optional(),
  includeDeleted: z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).optional(),
});

/** Normalise a raw query value into a list of strings. */
function asStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(asStrings);
  if (raw === undefined || raw === null) return [];
  return [String(raw)];
}

function checkScalar(field: FieldDef, op: FilterOperator, value: string): string {
  switch (field.kind) {
    case 'number':
      if (!/^-?\d+(\.\d+)?$/.test(value)) throw fieldError(field.key, `${field.key} must be a number`);
      return value;
    case 'boolean':
      if (value !== 'true' && value !== 'false') throw fieldError(field.key, `${field.key} must be true or false`);
      return value;
    case 'uuid':
      if (!UUID.test(value)) throw fieldError(field.key, `${field.key} must be an id`);
      return value;
    case 'date':
      if (!ISO_DATE.test(value)) throw fieldError(field.key, `${field.key} must be YYYY-MM-DD`);
      return value;
    case 'timestamp':
      if (!ISO_DATE.test(value) && !ISO_TIMESTAMP.test(value)) {
        throw fieldError(field.key, `${field.key} must be a date or ISO timestamp`);
      }
      return value;
    case 'text':
      if (value.length > 200) throw fieldError(field.key, `${field.key} is too long`);
      // LIKE patterns are built by the engine; the caller sends plain text.
      return op === 'like' || op === 'ilike' ? value.replace(/[%_\\]/g, ' ').trim() : value;
    case 'enum':
      if (!/^[A-Za-z0-9_\-.:]{1,64}$/.test(value)) throw fieldError(field.key, `${field.key} has an invalid value`);
      return value;
  }
}

function fieldError(field: string, message: string): ListQueryError {
  return new ListQueryError('Validation error', [{ field, message }]);
}

/**
 * Validate and resolve a request's query string against a resource.
 *
 * @param query   `req.query` (Express extended parser: repeated keys → arrays)
 * @param config  the resource being read
 * @param role    the caller's role, for `includeDeleted` permission
 */
export function parseListQuery(
  query: Record<string, unknown>,
  config: ResourceConfig,
  role: UserRole,
): ResolvedListQuery {
  const reserved = ReservedSchema.safeParse({
    page: query.page,
    pageSize: query.pageSize,
    search: query.search,
    sort: query.sort,
    includeDeleted: query.includeDeleted,
  });
  if (!reserved.success) {
    throw new ListQueryError(
      'Validation error',
      reserved.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    );
  }

  const fieldsByKey = new Map(config.fields.map((f) => [f.key, f] as const));

  // --- sort ---------------------------------------------------------------
  let sort: ResolvedListQuery['sort'] = null;
  const sortSpec = reserved.data.sort;
  if (sortSpec) {
    const [key, dir] = sortSpec.split(':') as [string, 'asc' | 'desc'];
    if (!config.sortableFields?.includes(key)) throw fieldError('sort', `Cannot sort by ${key}`);
    const field = fieldsByKey.get(key);
    sort = { column: field ? columnOf(field) : camelToSnake(key), ascending: dir === 'asc' };
  } else if (config.defaultSort) {
    const field = fieldsByKey.get(config.defaultSort.key);
    sort = {
      column: field ? columnOf(field) : camelToSnake(config.defaultSort.key),
      ascending: config.defaultSort.direction === 'asc',
    };
  }

  // --- search --------------------------------------------------------------
  const search = reserved.data.search;
  if (search && !(config.searchableFields && config.searchableFields.length > 0)) {
    throw fieldError('search', 'This resource is not searchable');
  }

  // --- filters -------------------------------------------------------------
  const filters: ResolvedFilter[] = [];
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (RESERVED.has(rawKey)) continue;
    const dot = rawKey.indexOf('.');
    const key = dot === -1 ? rawKey : rawKey.slice(0, dot);
    const opName = dot === -1 ? 'eq' : rawKey.slice(dot + 1);

    const field = fieldsByKey.get(key);
    if (!field) throw fieldError(key, `Unknown filter ${key}`);
    if (!(FILTER_OPERATORS as readonly string[]).includes(opName)) {
      throw fieldError(key, `Unknown operator ${opName}`);
    }
    const op = opName as FilterOperator;
    if (!operatorsFor(field).includes(op)) throw fieldError(key, `${key} does not support ${op}`);

    const values = asStrings(rawValue)
      // A single param may carry a comma list for `in`/`nin`/`between`.
      .flatMap((v) => (LIST_OPERATORS.has(op) ? v.split(',') : [v]))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

    if (UNARY_OPERATORS.has(op)) {
      filters.push({ field, column: columnOf(field), op, value: null });
      continue;
    }
    if (values.length === 0) continue; // an empty filter is no filter

    if (LIST_OPERATORS.has(op)) {
      if (op === 'between' && values.length !== 2) {
        throw fieldError(key, `${key} between needs exactly two values`);
      }
      if (values.length > 100) throw fieldError(key, `${key} has too many values`);
      filters.push({
        field,
        column: columnOf(field),
        op,
        value: values.map((v) => checkScalar(field, op, v)),
      });
    } else {
      if (values.length > 1) throw fieldError(key, `${key} accepts one value for ${op}`);
      filters.push({ field, column: columnOf(field), op, value: checkScalar(field, op, values[0]!) });
    }
  }

  // --- soft delete ---------------------------------------------------------
  const wantsDeleted = reserved.data.includeDeleted === '1' || reserved.data.includeDeleted === 'true';
  const includeDeleted = Boolean(
    wantsDeleted && config.softDelete && (config.softDelete.mayInclude ?? []).includes(role),
  );

  return {
    page: reserved.data.page,
    pageSize: reserved.data.pageSize,
    search,
    filters,
    sort,
    includeDeleted,
  };
}
