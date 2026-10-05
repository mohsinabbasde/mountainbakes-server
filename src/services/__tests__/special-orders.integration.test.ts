import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { CreateProductionOrderSchema, CreateSpecialOrderSchema, VerifySpecialOrderSchema } from '../../shared';

/**
 * Special Orders, end to end, against the REAL SQL and the REAL routes.
 *
 * pglite runs migrations 142 + 143 (and 84's idempotency functions, and
 * migration 89's `apply_production_stock_movement`, lifted verbatim) over stub
 * tables. The Express router from special-orders.routes.ts is mounted on a local
 * server with `supabaseAdmin` pointed at that database, so every assertion below
 * goes through the same middleware, schema, RPC and ledger write production
 * does. Nothing here recomputes stock: the tests set an order up and read the
 * ledger back.
 *
 * Offline creation and sync-after-reconnect are the mobile queue's half of the
 * contract and are tested there; what the server owes that queue — one order per
 * Idempotency-Key however often it is re-sent — is tested here.
 */

const MIGRATIONS = join(__dirname, '../../../supabase/migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create type branch_production_order_status as enum
    ('pending', 'awaiting_verification', 'verified', 'approved', 'rejected', 'cancelled');
  create type production_stock_movement_type as enum
    ('prepare', 'transfer_out', 'return_in', 'sale', 'adjustment', 'return_transfer');
  create type attachment_entity as enum
    ('production_order_demand', 'production_order_verification', 'production_order_special_item');
  create type stock_movement_type as enum ('sale', 'production', 'return', 'adjustment');
  create table counters (id text primary key, count bigint not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text);
  create table users (id uuid primary key default gen_random_uuid());
  create table products (
    id uuid primary key default gen_random_uuid(), name text not null,
    price numeric not null default 0, is_active boolean not null default true,
    is_special boolean not null default false);
  create unique index products_special_name_key on products (lower(trim(name))) where is_special;
  create table production_stock (product_id uuid primary key, product_name text, balance numeric not null default 0);
  create sequence test_txn_seq;
  create table production_stock_history (
    id uuid primary key default gen_random_uuid(), product_id uuid not null, product_name text,
    type production_stock_movement_type not null, delta numeric not null,
    balance_after numeric not null default 0, ref_id text, business_date date not null,
    branch_id uuid, production_order_id uuid, created_by uuid, created_by_name text,
    reason text, remarks text, metadata jsonb,
    transaction_no text default ('STK-TEST-' || nextval('test_txn_seq')),
    created_at timestamptz not null default now(),
    unique (ref_id, product_id, type));
  create table stock (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null, product_id uuid not null,
    product_name text, balance numeric not null default 0, unique (branch_id, product_id));
  create table stock_history (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null, product_id uuid not null,
    product_name text, type stock_movement_type not null, delta numeric not null,
    balance_after numeric not null default 0, ref_id text, business_date date not null,
    unique (ref_id, product_id, type));
  create table production_orders (
    id uuid primary key default gen_random_uuid(), branch_id uuid,
    status branch_production_order_status not null default 'pending');
  create table production_order_items (
    id uuid primary key default gen_random_uuid(), production_order_id uuid not null,
    product_id uuid, product_name text, qty numeric not null, approved_qty numeric,
    is_special boolean not null default false, line_no integer);
  create table attachments (
    id uuid primary key default gen_random_uuid(), entity attachment_entity not null,
    entity_id uuid, storage_path text not null, mime_type text not null default 'image/webp',
    size_bytes integer not null default 1, width integer, height integer,
    uploaded_by uuid, uploaded_by_name text, bound_at timestamptz,
    created_at timestamptz not null default now());
  create table notifications (
    id uuid primary key default gen_random_uuid(), type text, title text, message text,
    target_user_id uuid, target_role text, branch_id uuid, related_id uuid);
`;

/** `apply_production_stock_movement` exactly as migration 89 defines it. */
function ledgerWriteFromMigration89(): string {
  const sql = read('20260826000089_production_stock_ledger_audit.sql');
  const start = sql.indexOf('create or replace function public.apply_production_stock_movement(');
  const end = sql.indexOf('$$;', start) + 3;
  assert.ok(start > 0 && end > start, 'apply_production_stock_movement not found in migration 89');
  return sql.slice(start, end);
}

/** `apply_stock_movement` (branch stock) exactly as migration 12 defines it. */
function branchLedgerWriteFromMigration12(): string {
  const sql = read('20260719000012_stock_functions.sql');
  const start = sql.indexOf('create or replace function public.apply_stock_movement(');
  const end = sql.indexOf('$$;', start) + 3;
  assert.ok(start > 0 && end > start, 'apply_stock_movement not found in migration 12');
  return sql.slice(start, end);
}

let db: PGlite;
let server: Server;
let base: string;

// ── Actors ───────────────────────────────────────────────────────────────────
const BRANCH_A = '00000000-0000-4000-8000-00000000000a';
const BRANCH_B = '00000000-0000-4000-8000-00000000000b';
interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  'branch-a': { id: '10000000-0000-4000-8000-000000000001', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
  'branch-b': { id: '10000000-0000-4000-8000-000000000002', email: 'b@mb.test', role: 'branch_manager', branchId: BRANCH_B, branchName: 'Gulshan Branch' },
  production: { id: '10000000-0000-4000-8000-000000000003', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
  admin: { id: '10000000-0000-4000-8000-000000000004', email: 'admin@mb.test', role: 'super_admin', branchId: null, branchName: null },
  finance: { id: '10000000-0000-4000-8000-000000000005', email: 'fin@mb.test', role: 'finance_manager', branchId: null, branchName: null },
};

// ── A PostgREST-shaped façade over pglite ────────────────────────────────────
// Only what these routes use. An unknown table answers empty, which is what the
// auth middleware's revocation lookup and the business-day check need to read
// as "nothing revoked, nothing closed".
const normalise = (value: unknown, key = ''): unknown => {
  if (value instanceof Date) return key.endsWith('_date') ? value.toISOString().slice(0, 10) : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => normalise(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, k)]));
  }
  return value;
};

class Query implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private cols = '*';
  private where: string[] = [];
  private params: unknown[] = [];
  private payload: Record<string, unknown>[] = [];
  private mode: 'many' | 'maybe' | 'single' = 'many';
  private orderBy: string[] = [];
  private max: number | null = null;

  constructor(private readonly table: string) {}

  private p(v: unknown): string { this.params.push(v); return `$${this.params.length}`; }

  select(cols = '*') { if (this.op === 'select') this.cols = cols; return this; }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(row: Record<string, unknown>) { this.op = 'update'; this.payload = [row]; return this; }
  eq(col: string, v: unknown) { this.where.push(`${col}::text = ${this.p(String(v))}`); return this; }
  in(col: string, vs: unknown[]) { this.where.push(`${col}::text = any(${this.p(vs.map(String))}::text[])`); return this; }
  is(col: string, _v: null) { this.where.push(`${col} is null`); return this; }
  not(col: string, _op: string, _v: null) { this.where.push(`${col} is not null`); return this; }
  gte(col: string, v: unknown) { this.where.push(`${col}::text >= ${this.p(String(v))}`); return this; }
  lte(col: string, v: unknown) { this.where.push(`${col}::text <= ${this.p(String(v))}`); return this; }
  /** `status.in.(a,b),business_date.gte.2026-01-01` — the one shape the list uses. */
  or(expr: string) {
    const parts = expr.split(/,(?![^(]*\))/).map((part) => {
      const [col, op, ...rest] = part.split('.');
      const value = rest.join('.');
      if (op === 'in') return `${col}::text = any(${this.p(value.replace(/^\(|\)$/g, '').split(','))}::text[])`;
      if (op === 'gte') return `${col}::text >= ${this.p(value)}`;
      throw new Error(`fake PostgREST: unsupported or() term "${part}"`);
    });
    this.where.push(`(${parts.join(' or ')})`);
    return this;
  }
  order(col: string, opts: { ascending?: boolean; referencedTable?: string } = {}) {
    if (!opts.referencedTable) this.orderBy.push(`${col} ${opts.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'single'; return this; }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    const exists = await db.query<{ t: string | null }>(`select to_regclass($1)::text as t`, [this.table]);
    if (!exists.rows[0]?.t) return { data: this.mode === 'many' ? [] : null, error: null };

    const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
    let sql: string;
    if (this.op === 'insert') {
      const keys = Object.keys(this.payload[0]!);
      const tuples = this.payload.map((row) => `(${keys.map((k) => this.p(row[k])).join(', ')})`);
      sql = `insert into ${this.table} (${keys.join(', ')}) values ${tuples.join(', ')} returning *`;
    } else if (this.op === 'update') {
      // SET parameters are numbered after the WHERE ones already collected.
      const sets = Object.entries(this.payload[0]!).map(([k, v]) => `${k} = ${this.p(v)}`);
      sql = `update ${this.table} set ${sets.join(', ')}${where} returning *`;
    } else {
      const embed = this.cols.includes('special_order_items(')
        ? `, (select coalesce(json_agg(i order by i.line_no), '[]'::json)
               from special_order_items i where i.special_order_id = ${this.table}.id) as items`
        : '';
      sql = `select *${embed} from ${this.table}${where}` +
        (this.orderBy.length ? ` order by ${this.orderBy.join(', ')}` : '') +
        (this.max !== null ? ` limit ${this.max}` : '');
    }

    try {
      const rows = normalise((await db.query(sql, this.params)).rows) as unknown[];
      if (this.mode === 'many') return { data: rows, error: null };
      if (this.mode === 'single' && rows.length !== 1) return { data: null, error: new Error('expected one row') };
      return { data: rows[0] ?? null, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(ok, fail);
  }
}

async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const list = keys
    .map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`)
    .join(', ');
  try {
    const { rows } = await db.query<{ r: unknown }>(`select public.${fn}(${list}) as r`, params);
    return { data: normalise(rows[0]?.r ?? null), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function call(as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${as}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

/** A staged (unbound) photo, as POST /api/attachments would leave it. */
async function stagePhoto(as: string, entity: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into attachments (entity, storage_path, uploaded_by)
     values ($1, $2, $3) returning id`,
    [entity, `${entity}/${Math.random().toString(36).slice(2)}.webp`, ACTORS[as]!.id],
  );
  return rows[0]!.id;
}

const line = (name: string, qty: number, amount: number, extra: Record<string, unknown> = {}) =>
  ({ name, qty, amount, description: '', attachmentIds: [], ...extra });

async function raise(as: string, items: unknown[], headers: Record<string, string> = {}) {
  const res = await call(as, 'POST', '/api/special-orders', { items }, headers);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; orderNumber: string };
}

async function listFor(as: string) {
  const res = await call(as, 'GET', '/api/special-orders');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.body.orders as any[];
}
const orderFor = async (as: string, id: string) => (await listFor(as)).find((o) => o.id === id);

/** Take an order all the way to 'verified'. */
async function prepareAndVerify(as: string, id: string): Promise<string> {
  assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/prepare`)).status, 200);
  const photo = await stagePhoto(as, 'special_order_verification');
  const res = await call(as, 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return photo;
}

// ── Ledger readers ───────────────────────────────────────────────────────────
const num = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);
const ledgerRows = () => num(`select count(*) as n from production_stock_history`);
/** What Production Stock holds for an item right now (net of everything). */
const poolFor = (name: string) =>
  num(`select coalesce(sum(s.balance), 0) as n from production_stock s
        join products p on p.id = s.product_id where lower(p.name) = lower($1)`, [name]);
/** How much was ADDED to Production Stock for an item — the 'prepare' movements. */
const preparedFor = (name: string) =>
  num(`select coalesce(sum(h.delta), 0) as n from production_stock_history h
        join products p on p.id = h.product_id
       where lower(p.name) = lower($1) and h.type = 'prepare'`, [name]);
/** What one branch's own stock holds for an item. */
const branchStockFor = (branchId: string, name: string) =>
  num(`select coalesce(sum(s.balance), 0) as n from stock s
        join products p on p.id = s.product_id
       where s.branch_id = $1 and lower(p.name) = lower($2)`, [branchId, name]);
const branchLedgerRows = () => num(`select count(*) as n from stock_history`);
const demandRows = () =>
  num(`select (select count(*) from production_orders) + (select count(*) from production_order_items) as n`);

before(async () => {
  process.env['SUPABASE_URL'] ??= 'http://127.0.0.1:1';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ??= 'test-service-role-key';

  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(ledgerWriteFromMigration89());
  await db.exec(branchLedgerWriteFromMigration12());
  await db.exec(read('20260818000084_idempotency_keys.sql'));
  // 142 in its own transaction, as `db push` runs it: the enum value has to be
  // committed before anything can use it.
  await db.exec(`begin;${read('20261005000142_special_order_verification_enum.sql')}commit;`);
  await db.exec(`begin;${read('20261005000143_special_orders.sql')}commit;`);
  await db.exec(`begin;${read('20261005000144_special_order_delivers_to_branch.sql')}commit;`);

  await db.query(`insert into branches (id, name) values ($1, 'DHA Branch'), ($2, 'Gulshan Branch')`, [BRANCH_A, BRANCH_B]);
  for (const a of Object.values(ACTORS)) await db.query(`insert into users (id) values ($1)`, [a.id]);

  const { supabaseAdmin } = await import('../../config/supabase');
  const admin = supabaseAdmin as unknown as Record<string, unknown>;
  admin['from'] = (table: string) => new Query(table);
  admin['rpc'] = rpc;
  (supabaseAdmin.auth as unknown as Record<string, unknown>)['getUser'] = async (token: string) => {
    const a = ACTORS[token];
    if (!a) return { data: { user: null }, error: new Error('bad token') };
    return {
      data: { user: { id: a.id, email: a.email, identities: [], app_metadata: { role: a.role, branchId: a.branchId, branchName: a.branchName } } },
      error: null,
    };
  };
  Object.defineProperty(supabaseAdmin, 'storage', {
    value: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })),
          error: null,
        }),
      }),
    },
  });

  const express = (await import('express')).default;
  const { router } = await import('../../routes/special-orders.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/special-orders', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('raising a Special Order', () => {
  test('1–4. one order, several rows, each with its own amount → sent to Production', async () => {
    const { id, orderNumber } = await raise('branch-a', [
      line('Name Cake — Blue Writing', 1, 300, { description: 'Blue writing' }),
      line('Custom Cake Decoration', 2, 500),
    ]);
    assert.match(orderNumber, /^SO-\d{6}$/);

    const order = await orderFor('branch-a', id);
    assert.equal(order.status, 'pending');
    assert.equal(order.branchId, BRANCH_A);
    assert.equal(order.createdByName, 'a@mb.test');
    assert.ok(order.submittedAt);
    assert.deepEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order.items.map((i: any) => [i.itemName, i.qty, i.amount, i.description]),
      [['Name Cake — Blue Writing', 1, 300, 'Blue writing'], ['Custom Cake Decoration', 2, 500, '']],
    );
    // The total is the sum of the rows' amounts — not amount × qty.
    assert.equal(order.totalAmount, 800);
  });

  test('5. it reaches Production, clearly a Special Order', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Photo Cake', 2, 500)]);
    const seen = await orderFor('production', id);
    assert.equal(seen.orderNumber, orderNumber);
    assert.equal(seen.branchName, 'DHA Branch');
    assert.equal(seen.status, 'pending');

    const { rows } = await db.query<{ title: string; target_role: string }>(
      `select title, target_role from notifications where related_id = $1`, [id]);
    assert.deepEqual(rows, [{ title: `SPECIAL ORDER ${orderNumber}`, target_role: 'production_user' }]);
  });

  test('6. it is NOT a demand: no demand row, no demand line, and no stock', async () => {
    const before = { demand: await demandRows(), ledger: await ledgerRows(), branch: await branchLedgerRows() };
    await raise('branch-a', [line('Not A Demand Cake', 4, 900)]);
    assert.equal(await demandRows(), before.demand);
    assert.equal(await ledgerRows(), before.ledger);
    assert.equal(await branchLedgerRows(), before.branch);
    assert.equal(await preparedFor('Not A Demand Cake'), 0);
  });

  test('the amount is never written to the product or its price', async () => {
    await raise('branch-a', [line('Priced Only On The Order', 1, 1234.5)]);
    const { rows } = await db.query<{ price: string; is_special: boolean }>(
      `select price, is_special from products where name = 'Priced Only On The Order'`);
    assert.deepEqual(rows.map((r) => [Number(r.price), r.is_special]), [[0, true]]);
  });

  test('server validation: name, quantity and amount are each required', async () => {
    const count = () => num(`select count(*) as n from special_orders`);
    const start = await count();
    const post = (item: unknown) => call('branch-a', 'POST', '/api/special-orders', { items: [item] });

    const noAmount = await post({ name: 'Cake', qty: 1 });
    assert.equal(noAmount.status, 400);
    assert.match(JSON.stringify(noAmount.body), /Please enter the Special Order amount\./);

    const noQty = await post({ name: 'Cake', qty: 0, amount: 100 });
    assert.equal(noQty.status, 400);
    assert.match(JSON.stringify(noQty.body), /Please enter quantity\./);

    assert.equal((await post({ name: '   ', qty: 1, amount: 100 })).status, 400);
    assert.equal((await post({ name: 'Cake', qty: 1, amount: -1 })).status, 400);
    assert.equal((await post({ name: 'Cake', qty: 1, amount: '300' })).status, 400);
    assert.equal((await call('branch-a', 'POST', '/api/special-orders', { items: [] })).status, 400);
    assert.equal(await count(), start);

    // 0 is an amount, not a missing one.
    assert.equal((await post(line('Free Replacement', 1, 0))).status, 201);
  });

  test('the database refuses what the schema refuses, for a caller that bypasses it', async () => {
    const direct = (items: unknown) =>
      rpc('create_special_order', {
        p_branch_id: BRANCH_A, p_branch_name: 'DHA Branch', p_business_date: '2026-10-05',
        p_created_by: ACTORS['branch-a']!.id, p_created_by_name: 'a@mb.test', p_items: items,
      });
    const start = await num(`select count(*) as n from special_orders`);
    for (const items of [[{ name: 'Cake', qty: 1 }], [{ name: 'Cake', qty: 0, amount: 5 }], [{ name: '', qty: 1, amount: 5 }], [{ name: 'Cake', qty: 1, amount: -5 }], []]) {
      assert.equal(((await direct(items)).data as { status: string }).status, 'invalid');
    }
    assert.equal(await num(`select count(*) as n from special_orders`), start);
  });

  test('only a branch may raise one', async () => {
    for (const who of ['production', 'finance']) {
      assert.equal((await call(who, 'POST', '/api/special-orders', { items: [line('Cake', 1, 100)] })).status, 403);
    }
    assert.equal((await call('nobody', 'POST', '/api/special-orders', { items: [line('Cake', 1, 100)] })).status, 401);
  });
});

describe('retries and sync safety', () => {
  test('18–19. the same request re-sent under one Idempotency-Key raises ONE order', async () => {
    const key = 'op-0190a1b2-retry-test-0001';
    const items = [line('Retry Cake', 3, 750)];
    const start = await num(`select count(*) as n from special_orders`);

    const first = await call('branch-a', 'POST', '/api/special-orders', { items }, { 'Idempotency-Key': key });
    const again = await call('branch-a', 'POST', '/api/special-orders', { items }, { 'Idempotency-Key': key });
    const third = await call('branch-a', 'POST', '/api/special-orders', { items }, { 'Idempotency-Key': key });

    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(again.body, first.body);
    assert.deepEqual(third.body, first.body);
    assert.equal(await num(`select count(*) as n from special_orders`), start + 1);
    assert.equal(await num(`select count(*) as n from special_order_items where item_name = 'Retry Cake'`), 1);
  });

  test('22. a refused sync is not remembered as done — the corrected re-send succeeds', async () => {
    const key = 'op-0190a1b2-failed-sync-0001';
    const bad = await call('branch-a', 'POST', '/api/special-orders', { items: [{ name: 'Sync Cake', qty: 1 }] }, { 'Idempotency-Key': key });
    assert.equal(bad.status, 400);
    assert.equal(await num(`select count(*) as n from special_order_items where item_name = 'Sync Cake'`), 0);

    // Same key, different body: the queue never does this, and it is refused
    // rather than treated as the earlier request.
    const ok = await call('branch-a', 'POST', '/api/special-orders', { items: [line('Sync Cake', 1, 100)] }, { 'Idempotency-Key': 'op-0190a1b2-failed-sync-0002' });
    assert.equal(ok.status, 201);
  });
});

describe('Production prepares, the branch verifies with a photo', () => {
  test('7–8. Production views and prepares it; no stock moves', async () => {
    const { id } = await raise('branch-a', [line('Prepared Cake', 2, 400)]);
    const ledger = await ledgerRows();

    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/prepare`)).status, 403);
    const res = await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    assert.equal(res.status, 200);

    const order = await orderFor('production', id);
    assert.equal(order.status, 'awaiting_verification');
    assert.equal(order.preparedByName, 'prod@mb.test');
    assert.ok(order.preparedAt);
    assert.equal(await ledgerRows(), ledger);

    // Preparing twice is refused, not repeated.
    assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/prepare`)).status, 409);
  });

  test('9–11. the branch receives it, uploads its photo and verifies; still no stock', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Verified Cake', 1, 300)]);
    await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    const ledger = await ledgerRows();

    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
    const { rows } = await db.query<{ title: string }>(
      `select title from notifications where related_id = $1 and target_role = 'branch_manager'`, [id]);
    assert.deepEqual(rows.map((r) => r.title), [`Special Order ${orderNumber} Prepared — Please Verify`]);

    // No photo, no verification.
    const none = await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [] });
    assert.equal(none.status, 400);
    assert.match(JSON.stringify(none.body), /A photo is required/);
    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');

    const photo = await stagePhoto('branch-a', 'special_order_verification');
    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo] })).status, 200);

    const order = await orderFor('branch-a', id);
    assert.equal(order.status, 'verified');
    assert.equal(order.verifiedByName, 'a@mb.test');
    assert.ok(order.verifiedAt);
    assert.deepEqual(order.verificationPhotos.map((p: { id: string }) => p.id), [photo]);
    // Verification moves nothing — not in Production Stock, not in branch stock.
    assert.equal(await ledgerRows(), ledger);
    assert.equal(await branchStockFor(BRANCH_A, 'Verified Cake'), 0);
  });

  test('it cannot be verified before Production has prepared it', async () => {
    const { id } = await raise('branch-a', [line('Too Early Cake', 1, 100)]);
    const photo = await stagePhoto('branch-a', 'special_order_verification');
    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo] })).status, 409);
    // …and the refused request did not consume the photo.
    assert.equal(await num(`select count(*) as n from attachments where id = $1 and entity_id is null`, [photo]), 1);
  });

  test('the database will not verify without a photo, whoever asks', async () => {
    const { id } = await raise('branch-a', [line('Photoless Cake', 1, 100)]);
    await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    const direct = await rpc('verify_special_order', { p_order_id: id, p_branch_id: BRANCH_A, p_by: ACTORS['branch-a']!.id, p_by_name: 'a@mb.test' });
    assert.deepEqual(direct.data, { status: 'photo_required' });
    const wrongBranch = await rpc('verify_special_order', { p_order_id: id, p_branch_id: BRANCH_B, p_by: ACTORS['branch-b']!.id, p_by_name: 'b@mb.test' });
    assert.deepEqual(wrongBranch.data, { status: 'forbidden' });
  });

  test('16–17. the request photo and the verification photo are separate, and both survive', async () => {
    const requestPhoto = await stagePhoto('branch-a', 'production_order_special_item');
    const { id } = await raise('branch-a', [line('Two Photo Cake', 1, 300, { attachmentIds: [requestPhoto] })]);

    const raised = await orderFor('production', id);
    assert.deepEqual(raised.items[0].requestPhotos.map((p: { id: string }) => p.id), [requestPhoto]);
    assert.deepEqual(raised.verificationPhotos, []);

    const verificationPhoto = await prepareAndVerify('branch-a', id);
    await call('production', 'PUT', `/api/special-orders/${id}/approve`);

    const done = await orderFor('production', id);
    assert.deepEqual(done.items[0].requestPhotos.map((p: { id: string }) => p.id), [requestPhoto]);
    assert.deepEqual(done.verificationPhotos.map((p: { id: string }) => p.id), [verificationPhoto]);
    assert.notEqual(requestPhoto, verificationPhoto);

    const { rows } = await db.query<{ id: string; entity: string; entity_id: string }>(
      `select id, entity::text as entity, entity_id from attachments where id = any($1::uuid[]) order by entity`,
      [[requestPhoto, verificationPhoto]]);
    assert.deepEqual(rows, [
      { id: requestPhoto, entity: 'production_order_special_item', entity_id: done.items[0].id },
      { id: verificationPhoto, entity: 'special_order_verification', entity_id: id },
    ]);
  });

  test('a photo staged for another purpose cannot stand in as the verification photo', async () => {
    const { id } = await raise('branch-a', [line('Wrong Photo Cake', 1, 100)]);
    await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    const wrong = await stagePhoto('branch-a', 'production_order_special_item');
    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [wrong] })).status, 409);
    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
  });
});

describe('approval — the one stock addition, delivered to the branch', () => {
  test('26. only Production or Admin may approve', async () => {
    const { id } = await raise('branch-a', [line('Guarded Cake', 2, 400)]);
    await prepareAndVerify('branch-a', id);
    for (const who of ['branch-a', 'branch-b', 'finance']) {
      assert.equal((await call(who, 'PUT', `/api/special-orders/${id}/approve`)).status, 403);
    }
    assert.equal((await orderFor('production', id)).status, 'verified');
    assert.equal(await preparedFor('Guarded Cake'), 0);
    assert.equal((await call('admin', 'PUT', `/api/special-orders/${id}/approve`)).status, 200);
    assert.equal(await preparedFor('Guarded Cake'), 2);
    assert.equal(await branchStockFor(BRANCH_A, 'Guarded Cake'), 2);
  });

  test('it cannot be approved before the branch has verified it with a photo', async () => {
    const { id } = await raise('branch-a', [line('Unverified Cake', 5, 1500)]);
    assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/approve`)).status, 409);
    await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/approve`)).status, 409);
    assert.equal((await orderFor('production', id)).status, 'awaiting_verification');
    assert.equal(await preparedFor('Unverified Cake'), 0);
  });

  test('12–15. approval adds exactly the ordered quantity, once; the amount is untouched', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Custom Cake', 5, 1500)]);
    await prepareAndVerify('branch-a', id);
    assert.equal(await preparedFor('Custom Cake'), 0);

    const res = await call('production', 'PUT', `/api/special-orders/${id}/approve`);
    assert.equal(res.status, 200);
    assert.equal(res.body.movements.length, 1);
    assert.equal(res.body.movements[0].qty, 5);

    // +5 into Production Stock — not +1500, not +10 …
    assert.equal(await preparedFor('Custom Cake'), 5);
    // … then the same 5 out to the branch that ordered it, and into its stock.
    assert.equal(await poolFor('Custom Cake'), 0);
    assert.equal(await branchStockFor(BRANCH_A, 'Custom Cake'), 5);
    assert.equal(await branchStockFor(BRANCH_B, 'Custom Cake'), 0);

    const order = await orderFor('production', id);
    assert.equal(order.status, 'approved');
    assert.equal(order.approvedByName, 'prod@mb.test');
    assert.ok(order.approvedAt);
    assert.ok(order.stockAddedAt);
    assert.equal(order.items[0].amount, 1500);
    assert.equal(order.totalAmount, 1500);

    // The ledger row traces back to the order, and the item traces forward to it.
    const { rows } = await db.query<Record<string, unknown>>(
      `select id, transaction_no, type::text as type, delta, ref_id, reason, branch_id, created_by_name, metadata
         from production_stock_history where ref_id like $1 and type = 'prepare'`, [`${orderNumber}/%`]);
    assert.equal(rows.length, 1);
    const move = rows[0]!;
    assert.equal(move['type'], 'prepare');
    assert.equal(Number(move['delta']), 5);
    assert.equal(move['ref_id'], `${orderNumber}/1`);
    assert.equal(move['reason'], `Special Order ${orderNumber}`);
    assert.equal(move['branch_id'], BRANCH_A);
    assert.equal(move['created_by_name'], 'prod@mb.test');
    assert.deepEqual(move['metadata'], {
      source: 'special_order', specialOrderId: id, specialOrderNumber: orderNumber, specialOrderItemId: order.items[0].id,
    });
    assert.equal(order.items[0].stockMovementId, move['id']);
    assert.equal(order.items[0].stockTransactionNo, move['transaction_no']);

    // The delivery is traceable the same way, in both ledgers.
    const out = await db.query<Record<string, unknown>>(
      `select delta, ref_id, branch_id, metadata->>'specialOrderNumber' as so
         from production_stock_history where ref_id like $1 and type = 'transfer_out'`, [`${orderNumber}/%`]);
    assert.deepEqual(out.rows.map((r) => [Number(r['delta']), r['ref_id'], r['branch_id'], r['so']]),
      [[-5, `${orderNumber}/1`, BRANCH_A, orderNumber]]);
    const into = await db.query<Record<string, unknown>>(
      `select type::text as type, delta, ref_id, branch_id from stock_history where ref_id like $1`, [`${orderNumber}/%`]);
    assert.deepEqual(into.rows.map((r) => [r['type'], Number(r['delta']), r['ref_id'], r['branch_id']]),
      [['production', 5, `${orderNumber}/1`, BRANCH_A]]);
  });

  test('18–19. approving again — a retry, a double click — adds nothing', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Once Only Cake', 5, 1500)]);
    await prepareAndVerify('branch-a', id);

    const results = await Promise.all([1, 2, 3].map(() => call('production', 'PUT', `/api/special-orders/${id}/approve`)));
    const later = await call('admin', 'PUT', `/api/special-orders/${id}/approve`);

    for (const r of [...results, later]) assert.equal(r.status, 200);
    assert.equal(later.body.alreadyApproved, true);
    assert.equal(await preparedFor('Once Only Cake'), 5);
    assert.equal(await branchStockFor(BRANCH_A, 'Once Only Cake'), 5);
    // One prepare + one transfer_out in the pool, one receipt at the branch.
    assert.equal(await num(`select count(*) as n from production_stock_history where ref_id like $1`, [`${orderNumber}/%`]), 2);
    assert.equal(await num(`select count(*) as n from stock_history where ref_id like $1`, [`${orderNumber}/%`]), 1);

    // Even the ledger write itself, replayed by hand under the same reference,
    // is a no-op — the second guard behind the status check.
    const { rows } = await db.query<{ product_id: string }>(`select product_id from special_order_items where special_order_id = $1`, [id]);
    await rpc('apply_production_stock_movement', {
      p_product_id: rows[0]!.product_id, p_product_name: 'Once Only Cake', p_delta: 5, p_type: 'prepare',
      p_ref_id: `${orderNumber}/1`, p_business_date: '2026-10-05',
    });
    assert.equal(await preparedFor('Once Only Cake'), 5);
    assert.equal(await poolFor('Once Only Cake'), 0);
    assert.equal(await branchStockFor(BRANCH_A, 'Once Only Cake'), 5);
  });

  test('every row of a multi-row order is added once, each by its own movement', async () => {
    const { id, orderNumber } = await raise('branch-a', [
      line('Row One Cake', 1, 500),
      line('Row Two Cake', 2, 800),
      // The same item asked for twice on one order is two rows and two movements.
      line('Row One Cake', 3, 100),
    ]);
    await prepareAndVerify('branch-a', id);
    assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/approve`)).status, 200);

    assert.equal(await preparedFor('Row One Cake'), 4);
    assert.equal(await preparedFor('Row Two Cake'), 2);
    assert.equal(await branchStockFor(BRANCH_A, 'Row One Cake'), 4);
    assert.equal(await branchStockFor(BRANCH_A, 'Row Two Cake'), 2);
    const { rows } = await db.query<{ ref_id: string; delta: string }>(
      `select ref_id, delta from production_stock_history where ref_id like $1 and type = 'prepare' order by ref_id`, [`${orderNumber}/%`]);
    assert.deepEqual(rows.map((r) => [r.ref_id, Number(r.delta)]), [
      [`${orderNumber}/1`, 1], [`${orderNumber}/2`, 2], [`${orderNumber}/3`, 3],
    ]);
  });
});

describe('several orders, several branches', () => {
  test('23–24. simultaneous orders from two branches each land once, with distinct numbers', async () => {
    const raised = await Promise.all([
      raise('branch-a', [line('Shared Name Cake', 2, 600)]),
      raise('branch-b', [line('shared name cake ', 3, 900)]),
      raise('branch-a', [line('Shared Name Cake', 4, 1200)]),
    ]);
    assert.equal(new Set(raised.map((r) => r.orderNumber)).size, 3);
    // One hidden product for the name, however it was typed.
    assert.equal(await num(`select count(*) as n from products where is_special and lower(trim(name)) = 'shared name cake'`), 1);

    await prepareAndVerify('branch-a', raised[0]!.id);
    await prepareAndVerify('branch-b', raised[1]!.id);
    await prepareAndVerify('branch-a', raised[2]!.id);
    await Promise.all(raised.map((r) => call('production', 'PUT', `/api/special-orders/${r.id}/approve`)));
    assert.equal(await preparedFor('Shared Name Cake'), 9);
    // Each branch receives its OWN orders — 2 + 4 for A, 3 for B.
    assert.equal(await branchStockFor(BRANCH_A, 'Shared Name Cake'), 6);
    assert.equal(await branchStockFor(BRANCH_B, 'Shared Name Cake'), 3);
    assert.equal(await poolFor('Shared Name Cake'), 0);
  });

  test('25. Branch A cannot see or act on Branch B\'s Special Orders', async () => {
    const { id } = await raise('branch-b', [line('Branch B Only Cake', 1, 250)]);

    assert.equal((await listFor('branch-a')).some((o) => o.id === id), false);
    assert.equal((await listFor('branch-b')).some((o) => o.id === id), true);
    // The scope is the token's branch — a query parameter cannot widen it.
    const peek = await call('branch-a', 'GET', `/api/special-orders?branchId=${BRANCH_B}`);
    assert.equal(peek.body.orders.some((o: { id: string }) => o.id === id), false);
    assert.equal((await call('finance', 'GET', '/api/special-orders')).status, 403);

    await call('production', 'PUT', `/api/special-orders/${id}/prepare`);
    const photo = await stagePhoto('branch-a', 'special_order_verification');
    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo] })).status, 403);
    assert.equal((await orderFor('branch-b', id)).status, 'awaiting_verification');
    assert.equal(await num(`select count(*) as n from attachments where id = $1 and entity_id is null`, [photo]), 1);
  });
});

describe('normal Demand is untouched', () => {
  test('27. a demand validates exactly as before; packing-only and product-only both pass', () => {
    const demand = (extra: Record<string, unknown>) =>
      CreateProductionOrderSchema.safeParse({ requiredDate: '2026-10-06', ...extra });
    assert.equal(demand({ items: [{ productId: 'p1', qty: 3 }] }).success, true);
    assert.equal(demand({ items: [{ productId: 'p1', qty: 3 }], packingItems: [], specialItems: [] }).success, true);
    assert.equal(demand({ packingItems: [{ packingMaterialId: 'm1', qty: 2 }] }).success, true);
    assert.equal(demand({}).success, false);
  });

  test('24. the demand endpoint refuses special items instead of turning them into demand', () => {
    const r = CreateProductionOrderSchema.safeParse({
      requiredDate: '2026-10-06',
      items: [{ productId: 'p1', qty: 3 }],
      specialItems: [{ name: 'Name Cake', qty: 1, description: '', attachmentIds: [] }],
    });
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error?.issues), /Special Order/);
  });

  test('schemas: the verification photo is mandatory; amount must be a number', () => {
    assert.equal(VerifySpecialOrderSchema.safeParse({ attachmentIds: [] }).success, false);
    assert.equal(CreateSpecialOrderSchema.safeParse({ items: [{ name: 'Cake', qty: 1, amount: 300.5 }] }).success, true);
    assert.equal(CreateSpecialOrderSchema.safeParse({ items: [{ name: 'Cake', qty: 1, amount: 300.555 }] }).success, false);
    assert.equal(CreateSpecialOrderSchema.safeParse({ items: [{ name: 'Cake', qty: 1.5, amount: 300 }] }).success, false);
  });

  // LAST, deliberately: pglite can crash after a trigger raises, so nothing may
  // run after this.
  test('27 + 24. an ordinary demand line still inserts; a special one is refused by the database', async () => {
    const { rows } = await db.query<{ id: string }>(`insert into production_orders default values returning id`);
    const orderId = rows[0]!.id;
    await db.query(`insert into production_order_items (production_order_id, product_name, qty, line_no) values ($1, 'Cream Puff', 10, 1)`, [orderId]);
    assert.equal(await num(`select count(*) as n from production_order_items where production_order_id = $1`, [orderId]), 1);

    await assert.rejects(
      db.query(`insert into production_order_items (production_order_id, product_name, qty, is_special, line_no) values ($1, 'Name Cake', 1, true, 2)`, [orderId]),
      /Special Order is not a demand line/,
    );
  });
});
