/**
 * The shapes the query layer shares with its callers.
 *
 * A query never throws for a database error. It resolves to `{ data, error,
 * count }`, and the error carries `code` / `message` / `details` / `hint` —
 * the shape every call site in the API is written against.
 */

/**
 * A failed query.
 *
 * `code` is the Postgres SQLSTATE verbatim (`23505`, `P0001`, the custom codes
 * the SQL functions raise) and `message` is the text Postgres raised, untouched:
 * several routes send a function's `raise exception` message straight to the
 * person at the till, and a prefix added here would end up on their screen.
 *
 * The few `PGRST…` codes are for conditions PostgREST detected itself rather
 * than Postgres — more than one row for `.single()`, a page past the last row —
 * and are reproduced because call sites branch on them.
 *
 * Named `PostgrestError` because that is the name these errors have always had
 * in logs and in anything that checks `error.name`.
 */
export class DbError extends Error {
  code: string;
  details: string | null;
  hint: string | null;

  constructor(fields: { message: string; code?: string; details?: string | null; hint?: string | null }) {
    super(fields.message);
    this.name = 'PostgrestError';
    this.code = fields.code ?? '';
    this.details = fields.details ?? null;
    this.hint = fields.hint ?? null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any --
   `data` is `any` because it always has been: this chain was never given a
   schema type, so every call site treats rows as untyped. Typed access is what
   Prisma Client is for. */
export interface DbResult<T = any> {
  data: T | null;
  error: DbError | null;
  count: number | null;
  status: number;
  statusText: string;
}

export interface SelectOptions {
  count?: 'exact';
  head?: boolean;
}

export interface WriteOptions {
  count?: 'exact';
}

export interface UpsertOptions extends WriteOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

export interface OrderOptions {
  ascending?: boolean;
  nullsFirst?: boolean;
  referencedTable?: string;
}

/**
 * The query builder: a PostgREST-style call chain, and only the part of one
 * this codebase uses. Awaiting it runs the query. Every method mutates the
 * builder and returns it, so `query = query.eq(...)` and helpers that take a
 * builder and hand one back work.
 *
 * `R` is what `data` is when the query succeeds: a list of rows, until
 * `.single()` or `.maybeSingle()` makes it one row. Rows themselves are `any`.
 */
export interface QueryBuilder<R = any[]> extends PromiseLike<DbResult<R>> {
  select(columns?: string, options?: SelectOptions): QueryBuilder<any[]>;
  insert(values: Record<string, unknown> | Record<string, unknown>[], options?: WriteOptions): QueryBuilder<R>;
  update(values: Record<string, unknown>, options?: WriteOptions): QueryBuilder<R>;
  upsert(values: Record<string, unknown> | Record<string, unknown>[], options?: UpsertOptions): QueryBuilder<R>;
  delete(options?: WriteOptions): QueryBuilder<R>;

  eq(column: string, value: unknown): QueryBuilder<R>;
  neq(column: string, value: unknown): QueryBuilder<R>;
  gt(column: string, value: unknown): QueryBuilder<R>;
  gte(column: string, value: unknown): QueryBuilder<R>;
  lt(column: string, value: unknown): QueryBuilder<R>;
  lte(column: string, value: unknown): QueryBuilder<R>;
  like(column: string, pattern: string): QueryBuilder<R>;
  ilike(column: string, pattern: string): QueryBuilder<R>;
  in(column: string, values: readonly unknown[]): QueryBuilder<R>;
  is(column: string, value: boolean | null): QueryBuilder<R>;
  not(column: string, operator: string, value: unknown): QueryBuilder<R>;
  or(filters: string): QueryBuilder<R>;

  order(column: string, options?: OrderOptions): QueryBuilder<R>;
  range(from: number, to: number): QueryBuilder<R>;
  limit(count: number): QueryBuilder<R>;

  single(): QueryBuilder<any>;
  maybeSingle(): QueryBuilder<any>;
}

/** What a caller holds: a table to query, or a function to call. */
export interface Db {
  from(table: string): QueryBuilder;
  rpc<T = any>(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult<T>>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Where generated SQL goes. One implementation runs it on Prisma's connection;
 * the tests supply one over pglite.
 *
 * `query` returns plain rows with `json` columns already parsed, and throws
 * whatever the driver throws — turning that into a `DbError` is `toDbError`'s
 * job, in one place, not each executor's.
 */
export interface Executor {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}
