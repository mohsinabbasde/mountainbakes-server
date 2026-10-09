import type { DbResult, QueryBuilder } from './types';

/**
 * Shadow mode: prove the SQL layer on production's own reads before any of
 * them depend on it.
 *
 * A read made through a module in shadow mode is answered by PostgREST, as it
 * always was. Afterwards — off the request's path, so the caller never waits
 * on it — the same call chain is replayed through the SQL layer and the two
 * results are compared. A difference is logged; nothing else happens.
 *
 * WHAT IS LOGGED, AND WHAT NEVER IS. A mismatch line names the module, the
 * table, the shape of the call (method names and column names) and WHERE the
 * results differ — never a value from either result. These are sales, salaries
 * and customers' phone numbers, and a log is not somewhere they belong.
 *
 * WRITES ARE NOT SHADOWED. Running an insert twice is two inserts. Writes are
 * verified before a module is switched, against a scratch copy of the database.
 */

type Call = [method: string, args: unknown[]];

const WRITES = new Set(['insert', 'upsert', 'update', 'delete']);

const stats = { compared: 0, mismatched: 0, tieOrder: 0 };
const SUMMARY_EVERY = 500;

function report(module: string, target: string, shape: string, problem: string): void {
  stats.mismatched++;
  console.warn(`[db-shadow] MISMATCH module=${module} ${target} ${problem} call=${shape}`);
}

function tally(): void {
  stats.compared++;
  if (stats.compared % SUMMARY_EVERY === 0) {
    console.log(`[db-shadow] ${stats.compared} reads compared, ${stats.mismatched} mismatched, ${stats.tieOrder} with tied rows in another order`);
  }
}

export function shadowStats(): Readonly<typeof stats> {
  return stats;
}

/** Key order is not part of a row; member order is part of a list only when one was asked for. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The first place two results differ, as a path, or null when they agree.
 * `ordered(key)` says whether a list under that key was explicitly ordered; one
 * that was not may legitimately come back in a different order.
 */
export function firstDifference(a: unknown, b: unknown, ordered: (key: string) => boolean, path = '', key = ''): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    let different: string | null = null;
    for (let i = 0; i < a.length && !different; i++) different = firstDifference(a[i], b[i], ordered, `${path}[${i}]`, '');
    if (!different) return null;
    if (canonical(a) !== canonical(b)) return different;
    return ordered(key) ? `${path}(order)` : null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (!(k in ao) || !(k in bo)) return `${path}.${k}(missing)`;
      const d = firstDifference(ao[k], bo[k], ordered, `${path}.${k}`, k);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : path || '(value)';
}

/**
 * Whether two lists of the same rows differ only in how rows that TIE on the
 * requested sort were arranged — `order('business_date')` over several rows of
 * one date. SQL does not define that order and PostgREST does not return it
 * consistently from one request to the next, so it is not a difference between
 * the two paths. True only when the sort columns are in the rows and read the
 * same, position by position, on both sides.
 */
export function onlyTiesReordered(a: unknown, b: unknown, sortColumns: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || sortColumns.length === 0) return false;
  const keyOf = (row: unknown) => {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    return sortColumns.every((c) => c in r) ? JSON.stringify(sortColumns.map((c) => r[c])) : null;
  };
  return a.every((row, i) => {
    const key = keyOf(row);
    return key !== null && key === keyOf(b[i]);
  });
}

export function compareResults(
  module: string,
  target: string,
  shape: string,
  live: DbResult,
  mirror: DbResult,
  ordered: (key: string) => boolean,
  sortColumns: string[] = [],
): void {
  tally();
  const liveCode = live.error ? live.error.code || 'error' : null;
  const mirrorCode = mirror.error ? mirror.error.code || 'error' : null;
  // A failed count-only request comes back from PostgREST with no body (it is
  // an HTTP HEAD), so supabase-js has an error with no code to give. Any error
  // on the SQL side agrees with it.
  const bodiless = liveCode === 'error' && mirrorCode !== null;
  if (liveCode !== mirrorCode && !bodiless) return report(module, target, shape, `error postgrest=${liveCode} sql=${mirrorCode}`);
  if (live.error) return;
  if ((live.count ?? null) !== (mirror.count ?? null)) return report(module, target, shape, 'count differs');
  const different = firstDifference(live.data, mirror.data, ordered, 'data');
  if (!different) return;
  if (different === 'data(order)' && onlyTiesReordered(live.data, mirror.data, sortColumns)) {
    stats.tieOrder++;
    return;
  }
  report(module, target, shape, `at ${different}`);
}

/** The call's shape: methods and the column each was applied to — no values. */
function describe(calls: Call[]): string {
  return calls
    .map(([method, args]) => {
      const first = args[0];
      const named = ['select', 'or', 'insert', 'upsert', 'update', 'range', 'limit'].includes(method) ? '' : typeof first === 'string' ? first : '';
      return named ? `${method}(${named})` : method;
    })
    .join('.');
}

/* eslint-disable @typescript-eslint/no-explicit-any -- drives two builders through one untyped call list */
export class ShadowBuilder implements QueryBuilder<any> {
  private readonly calls: Call[] = [];

  constructor(
    private readonly module: string,
    private readonly table: string,
    private live: any,
    private readonly mirror: () => QueryBuilder<any>,
  ) {}

  private forward(method: string, args: unknown[]): this {
    this.calls.push([method, args]);
    this.live = this.live[method](...args);
    return this;
  }

  select(...a: unknown[]) { return this.forward('select', a); }
  insert(...a: unknown[]) { return this.forward('insert', a); }
  update(...a: unknown[]) { return this.forward('update', a); }
  upsert(...a: unknown[]) { return this.forward('upsert', a); }
  delete(...a: unknown[]) { return this.forward('delete', a); }
  eq(...a: unknown[]) { return this.forward('eq', a); }
  neq(...a: unknown[]) { return this.forward('neq', a); }
  gt(...a: unknown[]) { return this.forward('gt', a); }
  gte(...a: unknown[]) { return this.forward('gte', a); }
  lt(...a: unknown[]) { return this.forward('lt', a); }
  lte(...a: unknown[]) { return this.forward('lte', a); }
  like(...a: unknown[]) { return this.forward('like', a); }
  ilike(...a: unknown[]) { return this.forward('ilike', a); }
  in(...a: unknown[]) { return this.forward('in', a); }
  is(...a: unknown[]) { return this.forward('is', a); }
  not(...a: unknown[]) { return this.forward('not', a); }
  or(...a: unknown[]) { return this.forward('or', a); }
  order(...a: unknown[]) { return this.forward('order', a); }
  range(...a: unknown[]) { return this.forward('range', a); }
  limit(...a: unknown[]) { return this.forward('limit', a); }
  single() { return this.forward('single', []); }
  maybeSingle() { return this.forward('maybeSingle', []); }

  then<R1 = DbResult, R2 = never>(
    onfulfilled?: ((value: DbResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const answered = Promise.resolve(this.live as PromiseLike<DbResult>).then((result) => {
      if (!this.calls.some(([m]) => WRITES.has(m))) void this.compare(result);
      return result;
    });
    return answered.then(onfulfilled, onrejected);
  }

  /** Nothing that goes wrong in here may reach the request that triggered it. */
  private async compare(live: DbResult): Promise<void> {
    try {
      let mirror: any = this.mirror();
      for (const [method, args] of this.calls) mirror = mirror[method](...args);
      const result = (await mirror) as DbResult;

      const orderedKeys = new Set<string>();
      const sortColumns: string[] = [];
      for (const [method, args] of this.calls) {
        if (method !== 'order') continue;
        const ref = (args[1] as { referencedTable?: string } | undefined)?.referencedTable;
        if (ref) orderedKeys.add(ref);
        else sortColumns.push(String(args[0]));
      }
      compareResults(
        this.module,
        `table=${this.table}`,
        describe(this.calls),
        live,
        result,
        (key) => (key === '' ? sortColumns.length > 0 : orderedKeys.has(key)),
        sortColumns,
      );
    } catch (e) {
      report(this.module, `table=${this.table}`, describe(this.calls), `sql layer threw ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function shadowRpc<T>(
  module: string,
  fn: string,
  live: PromiseLike<DbResult<T>>,
  mirror: () => PromiseLike<DbResult>,
): PromiseLike<DbResult<T>> {
  return Promise.resolve(live).then((result) => {
    void (async () => {
      try {
        compareResults(module, `rpc=${fn}`, 'rpc', result, await mirror(), () => false);
      } catch (e) {
        report(module, `rpc=${fn}`, 'rpc', `sql layer threw ${e instanceof Error ? e.name : 'error'}`);
      }
    })();
    return result;
  });
}
