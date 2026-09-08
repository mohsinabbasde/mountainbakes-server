/**
 * Data Engine — server-side resource configuration.
 *
 * A RESOURCE is one table (or view) published through `GET /api/data/:resource`
 * with an explicit allowlist of what a caller may search, filter, sort and
 * export. The registry (`./registry.ts`) is the only place a resource is
 * declared; a route handler never builds a list query by hand.
 *
 * Security model, in one paragraph: the service-role client bypasses RLS, so
 * every rule lives here. A caller names FIELDS (camelCase API keys), never
 * columns; the engine maps a field to its column only if the resource lists it,
 * and only with the operators its kind permits. Who may read the resource at
 * all is `roles`; what SUBSET they may read is `scope()`, computed from the
 * verified JWT — a branch user's `branchId` comes from `req.user`, and no query
 * parameter can widen it.
 */
import type { AuthRequest } from '../middleware/auth';
import type { FilterOperator, SortState, UserRole } from '../shared';

export type AuthUser = NonNullable<AuthRequest['user']>;

/** Database-facing kind of a field. Decides which operators are legal. */
export type FieldKind =
  | 'text'
  | 'enum'
  | 'uuid'
  | 'number'
  | 'boolean'
  /** A Postgres `date` column — compared as a plain calendar date. */
  | 'date'
  /**
   * A `timestamptz` column. A date-only value (`YYYY-MM-DD`) sent for it is
   * widened to the whole day: the Karachi calendar day by default, or the
   * 2 AM→2 AM business day when `businessDay` is set on the field.
   */
  | 'timestamp';

export interface FieldDef {
  /** API-facing name, camelCase. What the client sends and receives. */
  key: string;
  /** Column in `table`. Defaults to `camelToSnake(key)`. */
  column?: string;
  kind: FieldKind;
  /**
   * For `timestamp` fields: interpret date-only bounds on the business day
   * (`businessDayBounds`, 2:00 AM Karachi rollover) rather than the calendar
   * day. This is the ONLY business-date rule the engine knows; it is the one
   * from `shared/utils/timezone.ts`.
   */
  businessDay?: boolean;
  /** Restrict operators further than the kind allows. */
  operators?: FilterOperator[];
}

/**
 * A row filter applied BEFORE any caller-supplied filter. Produced by
 * `ResourceConfig.scope()` from the authenticated user.
 *
 * Structured rather than a raw PostgREST string so the SAME rule can be
 * rendered as a PostgREST filter for the list endpoint and as SQL for the
 * aggregate function — one scope, two renderers, no way for them to drift.
 */
export type ScopeRule =
  | { column: string; op: 'eq' | 'neq'; value: string | number | boolean }
  | { column: string; op: 'in'; value: Array<string | number> }
  | { column: string; op: 'is'; value: null }
  | { column: string; op: 'not'; value: null }
  /** OR of the listed rules. */
  | { any: ScopeRule[] }
  /** AND of the listed rules — for grouping inside `any`. */
  | { all: ScopeRule[] };

/** Thrown by `scope()` to refuse the request outright. */
export class ScopeDenied extends Error {
  status = 403;
  constructor(message = 'Forbidden') {
    super(message);
  }
}

export type CacheProfile =
  /** Reference data — products, branches, categories. Client caches for minutes. */
  | 'static'
  /** Anything a sale or approval can change within the minute. */
  | 'live';

export interface ResourceConfig<Row = Record<string, unknown>> {
  /** Table or view the engine reads. Never taken from the request. */
  table: string;
  /** PostgREST select string. Defaults to `*`. May embed relations. */
  select?: string;
  /**
   * Ordering for embedded relations named in `select` — PostgREST makes no
   * ordering promise for an embed on its own, and a receipt's lines must not
   * come back shuffled.
   */
  embedOrder?: Array<{ column: string; referencedTable: string; ascending?: boolean }>;
  /** Roles that may read this resource at all. */
  roles: readonly UserRole[];
  /**
   * Per-user row restriction. Called with the verified JWT identity. Return
   * `[]` for "everything the role may see"; throw {@link ScopeDenied} to
   * refuse. Rules here are ANDed with — and cannot be removed by — the
   * caller's own filters.
   */
  scope?: (user: AuthUser) => ScopeRule[] | Promise<ScopeRule[]>;
  /** Every field a caller may filter on. */
  fields: readonly FieldDef[];
  /** Field keys the free-text `search` term matches with ILIKE. */
  searchableFields?: readonly string[];
  /** Field keys the caller may `sort` by. */
  sortableFields?: readonly string[];
  defaultSort?: SortState;
  /**
   * Second sort key so rows with equal primary values keep a stable order
   * between page requests. Defaults to `id` ascending.
   */
  tiebreaker?: { column: string; ascending: boolean };
  /**
   * Soft-deleted rows carry `deleted_at`. When set, the engine excludes them
   * unless the caller is allowed to and asks with `includeDeleted=1`.
   */
  softDelete?: { column?: string; mayInclude?: readonly UserRole[] };
  /** Field keys that may be aggregated (`sum` / `avg` / `min` / `max`). */
  aggregatableFields?: readonly string[];
  /** Field keys that may be used as `groupBy` in an aggregate request. */
  groupableFields?: readonly string[];
  /**
   * Post-process a page of rows before they are returned. Runs AFTER the
   * snake→camel conversion. For redaction, derived labels, or reshaping into
   * the type an existing page component already expects.
   */
  transform?: (rows: Record<string, unknown>[], user: AuthUser) => Row[];
  /** Export sheet layout. Omit to disable `/export` for this resource. */
  export?: {
    fileName: string;
    /** Column order and headings. `key` is a field of the TRANSFORMED row. */
    columns: Array<{ key: string; header: string; width?: number }>;
    /** Hard ceiling on rows in one export. Default 10 000. */
    maxRows?: number;
  };
  cache?: CacheProfile;
}

/** One caller filter after validation against the resource's fields. */
export interface ResolvedFilter {
  field: FieldDef;
  column: string;
  op: FilterOperator;
  value: string | string[] | null;
}

/** Everything the builder needs, fully validated. */
export interface ResolvedListQuery {
  page: number;
  pageSize: number;
  search: string;
  filters: ResolvedFilter[];
  sort: { column: string; ascending: boolean } | null;
  includeDeleted: boolean;
}
