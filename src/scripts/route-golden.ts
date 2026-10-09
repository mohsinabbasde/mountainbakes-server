import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type Router } from 'express';
import { firstDifference } from '../db/shadow';

/**
 * Route goldens: every GET route of the API, answered once with the database
 * calls going through PostgREST and once with them going through the SQL layer
 * in src/db, and the two answers compared.
 *
 *   pnpm db:routes                 every module on the SQL layer
 *   pnpm db:routes orders,stock    only those modules on it (as DB_SQL_MODULES)
 *   pnpm db:routes --shadow        every module in shadow mode instead: answers
 *                                  must not change at all, and the mismatches
 *                                  shadow mode would log in production are shown
 *
 * `pnpm db:diff` compares the two paths one database call at a time. This
 * compares them through the real route handlers — the scoping, the paging, the
 * mapping to the response the clients receive — for each kind of user. A module
 * is ready to be switched when its routes are identical here.
 *
 * HOW. The API is started three times, each in its own process so that no
 * in-memory cache carries an answer from one run into the next: twice on
 * PostgREST and once on SQL. Two PostgREST runs that disagree with EACH OTHER
 * mark a response as one that changes by itself (it embeds the current time, or
 * a signed URL); those are compared by status only.
 *
 * Sign-in is replaced by a stub: the bearer token is the identity. Only GET is
 * exercised, but some GET handlers do write (they create the day's record on
 * first read), so this runs against a SCRATCH database only and refuses
 * anything that is not on this machine.
 *
 *   GOLDEN_DATABASE_URL    the scratch database
 *   GOLDEN_POSTGREST_URL   a PostgREST serving that database
 *   GOLDEN_POSTGREST_JWT   a service_role token PostgREST accepts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Identity {
  id: string;
  email: string;
  role: string;
  branchId: string | null;
  branchName: string | null;
}

interface Answer {
  status: number;
  type: string;
  body: unknown;
}

type Answers = Record<string, Answer>;

/** Query strings tried on every list route; a route ignores the ones it does not read. */
const VARIANTS = [
  '',
  '?page=2&pageSize=7&limit=7&offset=7',
  '?search=a&q=a',
  '?from=2026-09-01&to=2026-10-08&startDate=2026-09-01&endDate=2026-10-08&date=2026-10-01&businessDate=2026-10-01&month=2026-09',
  '?sortBy=createdAt&sortDir=asc&sort=created_at&order=asc&includeDeleted=true&status=all',
];

function local(url: string | undefined, what: string): URL {
  if (!url) throw new Error(`${what} is required`);
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    throw new Error(`${what} is ${u.hostname}. Route goldens only run against a database on this machine.`);
  }
  return u;
}

// ── one run: start the API on one backend and record every GET ──────────────

/** supabase-js expects PostgREST under /rest/v1; nothing else Supabase offers exists here. */
function startGateway(postgrest: URL): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/rest/v1')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"not available in the golden harness"}');
      return;
    }
    const upstream = http.request(
      { host: postgrest.hostname, port: postgrest.port, method: req.method, path: req.url.replace('/rest/v1', '') || '/', headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function firstId(body: unknown): string | null {
  const lists: unknown[] = [];
  if (Array.isArray(body)) lists.push(body);
  else if (body && typeof body === 'object') {
    for (const v of Object.values(body as Record<string, unknown>)) if (Array.isArray(v)) lists.push(v);
  }
  for (const list of lists) {
    const first = (list as unknown[])[0] as { id?: unknown } | undefined;
    if (first && typeof first.id === 'string') return first.id;
  }
  return null;
}

async function record(outFile: string): Promise<void> {
  const dbUrl = local(process.env.GOLDEN_DATABASE_URL, 'GOLDEN_DATABASE_URL');
  const postgrest = local(process.env.GOLDEN_POSTGREST_URL, 'GOLDEN_POSTGREST_URL');
  const gateway = await startGateway(postgrest);

  process.env.SUPABASE_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.GOLDEN_POSTGREST_JWT || '';
  process.env.DATABASE_URL = dbUrl.toString();
  // Error messages are part of what is compared; production masks them.
  process.env.NODE_ENV = 'test';

  // What shadow mode would have written to the production log.
  const shadowLines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[db-shadow]')) shadowLines.push(args[0]);
    else warn(...args);
  };

  const { supabaseAdmin } = await import('../config/supabase');
  (supabaseAdmin.auth as any).getUser = async (token: string) => {
    try {
      const who = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Identity;
      return {
        data: { user: { id: who.id, email: who.email, app_metadata: { role: who.role, branchId: who.branchId, branchName: who.branchName }, identities: [] } },
        error: null,
      };
    } catch {
      return { data: { user: null }, error: { message: 'bad token' } };
    }
  };

  // One of each kind of user the scratch copy has, in a stable order.
  const { dbFor } = await import('../db');
  const db = dbFor('golden');
  const { data: users, error } = await db
    .from('users')
    .select('id, email, role, branch_id')
    .eq('status', 'active')
    .order('role')
    .order('id');
  if (error) throw new Error(`could not read users: ${error.message}`);
  const { data: branches } = await db.from('branches').select('id, name');
  const branchName = new Map((branches ?? []).map((b: any) => [b.id, b.name]));
  const identities: Identity[] = [];
  for (const u of users ?? []) {
    if (identities.some((i) => i.role === u.role)) continue;
    identities.push({ id: u.id, email: u.email, role: u.role, branchId: u.branch_id, branchName: branchName.get(u.branch_id) ?? null });
  }

  // Mounted without app.ts's global rate limit, which this would exhaust at once.
  const { setupRoutes } = await import('../routes/index');
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  const routes: string[] = [];
  const recorder = {
    use(prefix: string, router: Router) {
      for (const layer of (router as any).stack ?? []) {
        if (layer.route?.methods?.get) routes.push(`${prefix}${layer.route.path === '/' ? '' : layer.route.path}`);
      }
      app.use(prefix, router);
    },
  };
  setupRoutes(recorder as unknown as Express);
  app.use(errorHandler);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const answers: Answers = {};
  const get = async (who: Identity, url: string): Promise<Answer> => {
    const token = Buffer.from(JSON.stringify(who)).toString('base64url');
    const res = await fetch(base + url, { headers: { authorization: `Bearer ${token}` } });
    const type = (res.headers.get('content-type') || '').split(';')[0]!;
    // A file (xlsx, pdf) embeds the time it was made; its bytes are not compared.
    const body = type === 'application/json' ? await res.json().catch(() => null) : `<${(await res.arrayBuffer()).byteLength > 0 ? 'file' : 'empty'}>`;
    const answer = { status: res.status, type, body };
    answers[`${who.role} GET ${url}`] = answer;
    return answer;
  };

  const plain = routes.filter((r) => !r.includes(':')).sort();
  const withOneParam = routes.filter((r) => (r.match(/:/g) ?? []).length === 1).sort();
  for (const who of identities) {
    const ids = new Map<string, string>();
    for (const route of plain) {
      for (const variant of VARIANTS) {
        const answer = await get(who, route + variant);
        const id = variant === '' && answer.status === 200 ? firstId(answer.body) : null;
        if (id) ids.set(route, id);
      }
    }
    // `/api/orders/:id` is asked for the first order `/api/orders` listed —
    // or, failing that, an id nobody has, which still exercises the lookup.
    for (const route of withOneParam) {
      const parent = [...ids.keys()].filter((p) => route.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
      const id = (parent && ids.get(parent)) || '00000000-0000-4000-8000-000000000000';
      await get(who, route.replace(/:[A-Za-z_]+\??/, id));
    }
  }

  // Shadow comparisons run after the response has gone; let the last ones land.
  const { shadowStats } = await import('../db/shadow');
  if (process.env.DB_SHADOW_MODULES) await new Promise((resolve) => setTimeout(resolve, 2000));

  await writeFile(
    outFile,
    JSON.stringify({ routes: routes.length, identities: identities.map((i) => i.role), answers, shadow: { ...shadowStats(), lines: shadowLines } }),
  );
  server.close();
  gateway.close();
  const { disconnectPrisma } = await import('../db');
  await disconnectPrisma();
}

// ── the comparison: three runs ──────────────────────────────────────────────

function child(env: Record<string, string>, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', __filename, '--record', outFile], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`recording run failed (exit ${code}):\n${err.split('\n').slice(-15).join('\n')}`))));
  });
}

async function compare(): Promise<void> {
  local(process.env.GOLDEN_DATABASE_URL, 'GOLDEN_DATABASE_URL');
  local(process.env.GOLDEN_POSTGREST_URL, 'GOLDEN_POSTGREST_URL');
  const shadow = process.argv.includes('--shadow');
  const modules = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '*';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-golden-'));
  const file = (n: string) => path.join(dir, `${n}.json`);

  try {
    const off = { DB_BACKEND: 'postgrest', DB_SQL_MODULES: '', DB_SHADOW_MODULES: '' };
    console.log(`[db:routes] recording: PostgREST, PostgREST again, then ${shadow ? 'shadow' : 'SQL'} for modules ${modules} …`);
    await child(off, file('a1'));
    await child(off, file('a2'));
    await child({ ...off, ...(shadow ? { DB_SHADOW_MODULES: modules } : { DB_SQL_MODULES: modules }) }, file('b'));

    const load = async (n: string) =>
      JSON.parse(await readFile(file(n), 'utf8')) as {
        routes: number;
        identities: string[];
        answers: Answers;
        shadow: { compared: number; mismatched: number; lines: string[] };
      };
    const [a1, a2, b] = [await load('a1'), await load('a2'), await load('b')];

    const keys = Object.keys(a1.answers);
    const byStatus: Record<number, number> = {};
    let unstable = 0;
    const different: string[] = [];
    // The same rows in another order. SQL leaves the order of rows that tie on
    // the requested sort unspecified, and the two paths plan the query
    // differently; reported, but it is not the SQL layer returning other data.
    const reordered: string[] = [];
    for (const key of keys) {
      const live = a1.answers[key]!;
      const again = a2.answers[key];
      const sql = b.answers[key];
      byStatus[live.status] = (byStatus[live.status] ?? 0) + 1;
      if (!sql || !again) {
        different.push(`${key}\n    was not requested in every run (an earlier answer differed)`);
        continue;
      }
      if (live.status !== sql.status) {
        different.push(`${key}\n    status ${live.status} on PostgREST, ${sql.status} on SQL`);
        continue;
      }
      // Compared as ordered everywhere: what a client receives includes its order.
      const ordered = () => true;
      if (firstDifference(live.body, again.body, ordered, 'body')) {
        unstable++;
        continue;
      }
      const where = firstDifference(live.body, sql.body, ordered, 'body');
      if (where?.endsWith('(order)')) reordered.push(`${key}\n    same rows, different order at ${where.replace('(order)', '')}`);
      else if (where) different.push(`${key}\n    differs at ${where}`);
    }
    for (const key of Object.keys(b.answers)) {
      if (!(key in a1.answers)) different.push(`${key}\n    was only requested on SQL (an earlier answer differed)`);
    }

    console.log(`[db:routes] ${a1.routes} GET routes × ${a1.identities.length} users (${a1.identities.join(', ')}) → ${keys.length} requests`);
    console.log(`[db:routes] statuses on PostgREST: ${Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join('  ')}`);
    if (unstable) console.log(`[db:routes] ${unstable} responses change between two PostgREST runs; compared by status only`);
    for (const d of different.slice(0, 60)) console.log(`\n✗ ${d}`);
    for (const d of reordered.slice(0, 30)) console.log(`\n~ ${d}`);
    if (shadow) {
      console.log(`\n[db:routes] shadow mode compared ${b.shadow.compared} reads and would have logged ${b.shadow.mismatched} mismatches`);
      const kinds = new Map<string, number>();
      for (const line of b.shadow.lines) kinds.set(line, (kinds.get(line) ?? 0) + 1);
      for (const [line, n] of [...kinds].sort((x, y) => y[1] - x[1]).slice(0, 40)) console.log(`  ${n}×  ${line}`);
    }
    console.log(
      `\n${keys.length - different.length - reordered.length} of ${keys.length} responses identical` +
        (reordered.length ? `, ${reordered.length} with tied rows in another order` : '') +
        (different.length ? `, ${different.length} DIFFERENT` : ''),
    );
    process.exitCode = different.length ? 1 : 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const recordTo = process.argv.indexOf('--record');
(recordTo !== -1 ? record(process.argv[recordTo + 1]!) : compare()).catch((err) => {
  console.error('[db:routes]', err instanceof Error ? err.message : err);
  process.exit(1);
});
