/**
 * Data Engine — the wire contract shared by the API's generic list endpoint
 * (`GET /api/data/:resource`) and the web client's generic table.
 *
 * Everything a page needs to describe a filterable, searchable, sortable,
 * paginated list lives here as TYPES; the server's resource registry decides
 * which fields and operators a caller may actually use. Nothing in this file
 * grants access — it only names the vocabulary.
 *
 * Mirrored byte-for-byte in frontend/src/shared and backend/src/shared.
 */

/** The comparison operators the engine understands. */
export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'ilike',
  'null',
  'notnull',
  'between',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** How a filter is edited and, on the server, which operators it may use. */
export const FILTER_FIELD_TYPES = [
  'text',
  'search',
  'select',
  'multi-select',
  'date',
  'date-range',
  'number',
  'number-range',
  'boolean',
] as const;

export type FilterFieldType = (typeof FILTER_FIELD_TYPES)[number];

export interface FilterOption {
  label: string;
  value: string;
}

/**
 * One filter control, as a page declares it.
 *
 * `key` is the API-facing field name (camelCase). The server maps it onto a
 * database column; the client never sees or sends column names.
 */
export interface FilterConfig {
  key: string;
  label: string;
  type: FilterFieldType;
  /** Static choices for `select` / `multi-select`. Omit when loaded at runtime. */
  options?: FilterOption[];
  /** Placeholder for text and number inputs. */
  placeholder?: string;
  /**
   * Show this filter in the toolbar on desktop (default) or only inside the
   * drawer. A page with many filters keeps the two or three that matter most
   * on the bar and the rest behind "Filters".
   */
  placement?: 'bar' | 'drawer';
}

/** One active filter value, as it travels in the URL and to the API. */
export interface FilterValue {
  key: string;
  op: FilterOperator;
  /** Scalar for most operators; an array for `in` / `nin` / `between`. */
  value: string | string[] | null;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

/** Page sizes the client offers; the server refuses anything else. */
export const PAGE_SIZES = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 20;

/** The complete state of one list view. */
export interface ListQueryState {
  page: number;
  pageSize: PageSize;
  search: string;
  filters: FilterValue[];
  sort: SortState | null;
}

/** What `GET /api/data/:resource` returns. */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Aggregations the `/aggregate` endpoint computes. */
export const AGGREGATE_METRICS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggregateMetric = (typeof AGGREGATE_METRICS)[number];

/** `count` needs no field; the others name the (server-allowlisted) field. */
export interface AggregateRequest {
  metric: AggregateMetric;
  field?: string;
}

export interface AggregateRow {
  /** Present only when `groupBy` was requested. */
  group?: Record<string, string | number | boolean | null>;
  /** Keyed `metric` for count, `metric:field` otherwise, e.g. `sum:grandTotal`. */
  values: Record<string, number | null>;
}

export interface AggregateResponse {
  rows: AggregateRow[];
}

/**
 * What the server publishes about a resource so the client can build its UI
 * without a second copy of the configuration. Served by
 * `GET /api/data/:resource/meta`.
 */
export interface ResourceMeta {
  resource: string;
  searchable: boolean;
  filterable: Array<{ key: string; type: FilterFieldType; operators: FilterOperator[] }>;
  sortable: string[];
  defaultSort: SortState | null;
  exportable: boolean;
  /** Whether the resource's date filters are interpreted on the 2 AM business day. */
  businessDate: boolean;
}
