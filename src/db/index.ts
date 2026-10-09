import { SqlQueryBuilder } from './builder';
import { catalog } from './catalog';
import { prismaExecutor } from './prisma';
import { runRpc } from './rpc';
import { ShadowBuilder, shadowRpc } from './shadow';
import type { Db, DbResult, Executor, QueryBuilder } from './types';

/**
 * The database, as the rest of the API sees it.
 *
 *     const db = dbFor('orders');
 *     const { data, error } = await db.from('orders').select('*').eq('id', id).maybeSingle();
 *     const { data, error } = await db.rpc('commit_sale', { p_order, p_items });
 *
 * The call chain is the one supabase-js has, on purpose: moving a file off
 * `supabaseAdmin` is then a change to what the calls are made ON, and nothing
 * about how they are written or how their results are read.
 *
 * WHERE A CALL GOES is decided per module (the name given to `dbFor`), so the
 * move can be made — and undone — a few modules at a time with a config change
 * and no deploy:
 *
 *   postgrest  through supabase-js to PostgREST, exactly as before. The default.
 *   shadow     as `postgrest`, and every READ is also run through the SQL
 *              layer and compared; a difference is logged and the PostgREST
 *              result is what the caller gets. Writes are never run twice.
 *   sql        the SQL layer, on Prisma's connection. PostgREST is not involved.
 *
 *   DB_BACKEND          the default for every module: postgrest | shadow | sql
 *   DB_SHADOW_MODULES   comma-separated module names (or *) to run in shadow
 *   DB_SQL_MODULES      comma-separated module names (or *) to run on sql
 *
 * A module named in DB_SQL_MODULES is on sql whatever else is set.
 *
 * New code that is not a port of an existing call should not come here at all:
 * it uses Prisma Client (`getPrisma()` in ./prisma), with its typed models and
 * `$transaction`.
 */

export type Backend = 'postgrest' | 'shadow' | 'sql';

/** PostgREST's `max-rows`: the most rows one read returns, whatever it asked for. */
const maxRows = () => Number(process.env.DB_MAX_ROWS) || 1000;

let executor: Executor = prismaExecutor;

/** Tests run the SQL layer on pglite instead of a server. */
export function setExecutor(next: Executor): void {
  executor = next;
}

function listed(name: string, value: string | undefined): boolean {
  if (!value) return false;
  const names = value.split(',').map((s) => s.trim());
  return names.includes('*') || names.includes(name);
}

export function backendFor(module: string): Backend {
  if (listed(module, process.env.DB_SQL_MODULES)) return 'sql';
  if (listed(module, process.env.DB_SHADOW_MODULES)) return 'shadow';
  const fallback = (process.env.DB_BACKEND || 'postgrest').trim();
  return fallback === 'sql' || fallback === 'shadow' ? fallback : 'postgrest';
}

/**
 * Loaded only when a call actually goes to PostgREST: config/supabase.ts
 * throws on import without its two env vars, and once every module is on `sql`
 * those vars — and this function — go away.
 */
function postgrest(): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supabaseAdmin } = require('../config/supabase') as { supabaseAdmin: unknown };
  return supabaseAdmin as Db;
}

const sql: Db = {
  from: (table) => new SqlQueryBuilder(executor, table, maxRows()),
  rpc: <T>(fn: string, args?: Record<string, unknown>) => runRpc<T>(executor, fn, args, maxRows()),
};

export function dbFor(module: string): Db {
  return {
    from(table: string): QueryBuilder {
      const backend = backendFor(module);
      if (backend === 'sql') return sql.from(table);
      const live = postgrest().from(table);
      return backend === 'shadow' ? new ShadowBuilder(module, table, live, () => sql.from(table)) : live;
    },
    rpc<T>(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult<T>> {
      const backend = backendFor(module);
      if (backend === 'sql') return sql.rpc<T>(fn, args);
      const live = postgrest().rpc<T>(fn, args);
      if (backend !== 'shadow') return live;
      // Only a function that cannot write is safe to call a second time.
      const readOnly = (catalog().functions[fn] ?? []).every((f) => f.volatility !== 'v');
      return readOnly ? shadowRpc(module, fn, live, () => sql.rpc(fn, args)) : live;
    },
  };
}

export { getPrisma, disconnectPrisma } from './prisma';
export { DbError } from './types';
export type { Db, DbResult, Executor, QueryBuilder } from './types';
