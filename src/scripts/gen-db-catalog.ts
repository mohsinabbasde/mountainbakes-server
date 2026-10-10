import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG_QUERY, shapeCatalog } from '../db/catalog-query';
import { pgConnectionEnv } from '../services/backup/postgresBackup';

/**
 * Write src/db/catalog.generated.json — what the query layer in src/db knows
 * about the database: every table's columns and their types, the foreign keys
 * between tables, and every function's arguments and return shape.
 *
 *   pnpm db:catalog
 *
 * PostgREST keeps the same thing in memory and calls it the schema cache. It is
 * what lets `.eq('branch_id', id)` become `branch_id = $1::uuid`, what resolves
 * `items:order_items(...)` to the right join, and what lets `rpc('commit_sale',
 * args)` cast each argument to the type the function declares. It is also the
 * allowlist: a table, column or function that is not in this file cannot appear
 * in generated SQL at all.
 *
 * READ ONLY against the database. Re-run after every migration, together with
 * `pnpm prisma:pull`.
 */

function psqlJson(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `set search_path = ''; ${CATALOG_QUERY};`], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => reject(new Error(`could not start psql: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim());
      const detail = err.trim().split('\n').slice(-6).join('\n').split(env.PGPASSWORD || '\u0000').join('***');
      reject(new Error(`psql failed (exit ${code}):\n${detail}`));
    });
  });
}

/** Stable key order, so the file only changes when the database does. */
function sorted(value: unknown, keepOrder = false): unknown {
  if (Array.isArray(value)) return value.map((v) => sorted(v));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!keepOrder) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sorted(v, k === 'columns')]));
  }
  return value;
}

async function main() {
  const url = (process.env.DIRECT_DATABASE_URL || '').trim();
  if (!url) throw new Error('DIRECT_DATABASE_URL is required — a session-mode connection to the database to describe');
  const env = pgConnectionEnv(url);
  if (!new URL(url).searchParams.get('sslmode')) env.PGSSLMODE = 'prefer';

  const shaped = shapeCatalog(JSON.parse(await psqlJson(env)));

  const catalog = sorted(shaped);
  const file = path.join(__dirname, '..', 'db', 'catalog.generated.json');
  await writeFile(file, `${JSON.stringify(catalog, null, 1)}\n`);
  console.log(
    `[db:catalog] ${env.PGHOST}/${env.PGDATABASE}: ${Object.keys(shaped.tables).length} tables, ` +
      `${shaped.foreignKeys.length} foreign keys, ${Object.keys(shaped.functions).length} functions → src/db/catalog.generated.json`,
  );
}

main().catch((err) => {
  console.error('[db:catalog]', err instanceof Error ? err.message : err);
  process.exit(1);
});
