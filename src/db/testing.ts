import { setCatalog, type Catalog } from './catalog';
import { CATALOG_QUERY, shapeCatalog } from './catalog-query';
import { setExecutor } from './index';
import type { Executor } from './types';

/**
 * Run the query layer against pglite — a real Postgres, in memory, in the test
 * process — instead of a server.
 *
 *     const db = new PGlite();
 *     await db.exec(stubTablesAndTheMigrationUnderTest);
 *     await usePglite(db);
 *     // every db.from(...) / db.rpc(...) in the code under test now runs on `db`
 *
 * The catalog is read from that database, with the same query that describes
 * the real one, so a test only has to create the tables it uses. Call it again
 * after creating more.
 *
 * Structural type on purpose: pglite is a devDependency and this file must not
 * be what pulls it into the running API.
 */
interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export function pgliteExecutor(db: PgliteLike): Executor {
  return { query: async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows };
}

export async function usePglite(db: PgliteLike): Promise<void> {
  await db.exec(`set search_path = ''`);
  let raw: unknown;
  try {
    raw = (await db.query<{ json_build_object: unknown }>(CATALOG_QUERY)).rows[0]!.json_build_object;
  } finally {
    await db.exec('reset search_path');
  }
  setCatalog(shapeCatalog(raw as Parameters<typeof shapeCatalog>[0]) as unknown as Catalog);
  setExecutor(pgliteExecutor(db));
}
