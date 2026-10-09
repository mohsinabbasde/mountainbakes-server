import { DbError, type DbResult } from './types';

/**
 * Whatever a driver threw, as the error a call site already knows how to read.
 *
 * Prisma wraps a failed raw query in its own error (P2010) and keeps what
 * Postgres said underneath, at `meta.driverAdapterError.cause`. That inner
 * record is unwrapped here so `code` is the SQLSTATE and `message` is the raised
 * text — the two things routes branch on and show to people. node-postgres and
 * pglite (the tests) put the same fields directly on the error.
 *
 * Anything else — the pool is exhausted, the server is unreachable — has no
 * SQLSTATE and comes back with an empty `code`, as a failed fetch did from
 * supabase-js.
 */
export function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;

  const err = (e ?? {}) as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
    hint?: unknown;
    meta?: { driverAdapterError?: { cause?: Record<string, unknown> } };
  };
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

  const cause = err.meta?.driverAdapterError?.cause;
  if (cause) {
    const code = text(cause['originalCode']) ?? text(cause['code']);
    if (code) {
      return new DbError({
        code,
        message: text(cause['originalMessage']) ?? text(cause['message']) ?? 'database error',
        details: text(cause['detail']),
        hint: text(cause['hint']),
      });
    }
  }

  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
    return new DbError({
      code: err.code,
      message: text(err.message) ?? 'database error',
      details: text(err.detail),
      hint: text(err.hint),
    });
  }

  return new DbError({ message: text(err.message) ?? String(e) });
}

export function failed<T>(error: DbError): DbResult<T> {
  return { data: null, error, count: null, status: 400, statusText: 'Bad Request' };
}

export function ok<T>(data: T | null, count: number | null = null): DbResult<T> {
  return { data, error: null, count, status: 200, statusText: 'OK' };
}

/**
 * `.single()` and `.maybeSingle()` on a result that is not one row. The two
 * wordings are PostgREST's and supabase-js's respectively; both carry PGRST116.
 */
export function notOneRow(rows: number, from: 'server' | 'client'): DbError {
  return from === 'server'
    ? new DbError({
        code: 'PGRST116',
        message: 'Cannot coerce the result to a single JSON object',
        details: `The result contains ${rows} rows`,
      })
    : new DbError({
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: `Results contain ${rows} rows, application/vnd.pgrst.object+json requires 1 row`,
      });
}
