/**
 * The shapes the query layer shares with its callers.
 *
 * They are deliberately the shapes supabase-js already returns — `{ data,
 * error, count }`, an error with `code` / `message` / `details` / `hint` — so
 * that a call site moved from `supabaseAdmin.from(...)` to `db.from(...)` reads
 * its result exactly as it did before.
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
 * Named `PostgrestError` because that is what supabase-js names its own, and
 * the name is part of what a caller could have observed.
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
   `data` is `any` because it always has been: the supabase-js client was never
   given a schema type, so every call site already treats rows as untyped. */
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
 * The part of supabase-js's query builder this codebase uses — nothing more.
 * Awaiting it runs the query. Every method mutates the builder and returns it,
 * as supabase-js's does, so `query = query.eq(...)` and helpers that take a
 * builder and hand one back keep working.
 *
 * `R` is what `data` is when the query succeeds: a list of rows, until
 * `.single()` or `.maybeSingle()` makes it one row. Rows themselves are `any`,
 * as they were with supabase-js.
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

/** What a caller holds: the two verbs supabase-js gave it. */
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
