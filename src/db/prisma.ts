import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Executor } from './types';

/**
 * The one Prisma client, and with it the one connection pool to Postgres.
 *
 * CREATED ON FIRST USE, NOT ON IMPORT, so that a script or a test which never
 * queries can load the modules that would.
 *
 * DATABASE_URL is the API's own login on the Postgres server (the `mb_api` role
 * — see infra/railway/api-role.ts), not the administrator's.
 */

let client: PrismaClient | null = null;

/**
 * Queries the API makes are cut off at this. The `mb_api` role carries the same
 * limit; this is the one that still holds if the URL names a different role.
 */
const STATEMENT_TIMEOUT_MS = 8_000;

function poolConfig() {
  const raw = (process.env.DATABASE_URL || '').trim();
  if (!raw) throw new Error('DATABASE_URL is not set — the Postgres connection the API serves from');
  const url = new URL(raw);

  // TLS without certificate verification — libpq's `sslmode=require`, which is
  // what every other connection this backend makes to these databases uses.
  // Both hosts present certificates signed by their own CA. The `sslmode` in
  // the URL is taken off because node-postgres reads `require` as "verify",
  // and would then refuse the connection.
  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const ssl = mode === 'disable' || (local && !mode) ? false : { rejectUnauthorized: false };

  return {
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.DB_POOL_MAX) || 10,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
}

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({ adapter: new PrismaPg(poolConfig()) });
  return client;
}

/** Tests hand in a client over pglite instead of a server. */
export function setPrisma(next: PrismaClient): void {
  client = next;
}

/** The query layer's SQL, run on Prisma's connection. */
export const prismaExecutor: Executor = {
  query: (sql, params) => getPrisma().$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params),
};

export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
