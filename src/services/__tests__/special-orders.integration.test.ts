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
 * pglite runs migrations 142–145 (and 84's idempotency functions, and
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
  gt(col: string, v: unknown) { this.where.push(`${col} > ${this.p(v)}`); return this; }
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

const prepare = (id: string, body?: unknown) => call('production', 'PUT', `/api/special-orders/${id}/prepare`, body);

/** The branch's Verify & Approve, with a freshly staged photo. */
async function verify(as: string, id: string, items?: { itemId: string; receivedQty: number }[], headers: Record<string, string> = {}) {
  const photo = await stagePhoto(as, 'special_order_verification');
  const res = await call(as, 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo], ...(items ? { items } : {}) }, headers);
  return { res, photo };
}

/** Prepared in full by Production, then verified in full by the branch. */
async function prepareAndVerify(as: string, id: string): Promise<string> {
  assert.equal((await prepare(id)).status, 200);
  const { res, photo } = await verify(as, id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return photo;
}

// ── Ledger readers ───────────────────────────────────────────────────────────
const num = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);
const ledgerRows = () => num(`select count(*) as n from production_stock_history`);
const productsOf = `(select product_id from special_order_items where lower(item_name) = lower($1))`;
/** What Production Stock holds for an item right now (net of everything). */
const poolFor = (name: string) =>
  num(`select coalesce(sum(balance), 0) as n from production_stock where product_id in ${productsOf}`, [name]);
/** How much was ADDED to Production Stock for an item — the 'prepare' movements. */
const preparedFor = (name: string) =>
  num(`select coalesce(sum(delta), 0) as n from production_stock_history
        where type = 'prepare' and product_id in ${productsOf}`, [name]);
/** What one branch's own stock holds for an item. */
const branchStockFor = (branchId: string, name: string) =>
  num(`select coalesce(sum(balance), 0) as n from stock
        where branch_id = $2 and product_id in ${productsOf}`, [name, branchId]);
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
  await db.exec(`begin;${read('20261005000145_special_order_prepared_and_verified.sql')}commit;`);

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
  const { router: productsRouter } = await import('../../routes/products.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/special-orders', router);
  app.use('/api/products', productsRouter);
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
    assert.equal(await poolFor('Not A Demand Cake'), 0);
  });

  test('24. each line gets its own hidden product, priced Amount ÷ Qty; no other price moves', async () => {
    await db.query(`insert into products (name, price) values ('Catalogue Cake', 900)`);
    const { id, orderNumber } = await raise('branch-a', [line('Till Priced Cake', 2, 3000), line('Till Priced Cake', 4, 1000)]);

    const { rows } = await db.query<{ name: string; price: string; is_special: boolean }>(
      `select p.name, p.price, p.is_special from special_order_items i join products p on p.id = i.product_id
        where i.special_order_id = $1 order by i.line_no`, [id]);
    assert.deepEqual(rows.map((r) => [r.name, Number(r.price), r.is_special]), [
      [`Till Priced Cake — ${orderNumber}/1`, 1500, true],
      [`Till Priced Cake — ${orderNumber}/2`, 250, true],
    ]);
    // The agreed amount is the record, stored as entered.
    const order = await orderFor('branch-a', id);
    assert.deepEqual(order.items.map((i: { amount: number }) => i.amount), [3000, 1000]);
    // A later order of the same name at another amount changes neither.
    await raise('branch-b', [line('Till Priced Cake', 1, 9999)]);
    assert.deepEqual((await orderFor('branch-a', id)).items.map((i: { amount: number }) => i.amount), [3000, 1000]);
    assert.equal(await num(`select price as n from products where name = $1`, [`Till Priced Cake — ${orderNumber}/1`]), 1500);
    assert.equal(await num(`select price as n from products where name = 'Catalogue Cake'`), 900);
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

describe('Production prepares — Production Stock, automatically', () => {
  test('7–8. preparing adds the prepared quantity to Production Stock, once; nothing reaches the branch', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Prepared Cake', 2, 3000)]);

    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/prepare`)).status, 403);
    assert.equal((await prepare(id)).status, 200);

    const order = await orderFor('production', id);
    assert.equal(order.status, 'awaiting_verification');
    assert.equal(order.preparedByName, 'prod@mb.test');
    assert.ok(order.preparedAt);
    assert.equal(order.items[0].qty, 2);
    assert.equal(order.items[0].preparedQty, 2);
    assert.equal(order.items[0].verifiedQty, null);

    assert.equal(await poolFor('Prepared Cake'), 2);
    assert.equal(await branchStockFor(BRANCH_A, 'Prepared Cake'), 0);

    // Traceable both ways: ledger row → order, item → ledger row.
    const { rows } = await db.query<Record<string, unknown>>(
      `select id, transaction_no, type::text as type, delta, ref_id, reason, branch_id, created_by_name, metadata
         from production_stock_history where ref_id like $1`, [`${orderNumber}/%`]);
    assert.equal(rows.length, 1);
    const move = rows[0]!;
    assert.deepEqual([move['type'], Number(move['delta']), move['ref_id'], move['reason'], move['branch_id'], move['created_by_name']],
      ['prepare', 2, `${orderNumber}/1`, `Special Order ${orderNumber}`, BRANCH_A, 'prod@mb.test']);
    assert.deepEqual(move['metadata'], {
      source: 'special_order', specialOrderId: id, specialOrderNumber: orderNumber, specialOrderItemId: order.items[0].id,
    });
    assert.equal(order.items[0].stockMovementId, move['id']);
    assert.equal(order.items[0].stockTransactionNo, move['transaction_no']);

    // Preparing twice — a retry, a second click — is refused and adds nothing.
    assert.equal((await prepare(id)).status, 409);
    assert.equal(await poolFor('Prepared Cake'), 2);
    assert.equal(await num(`select count(*) as n from production_stock_history where ref_id like $1`, [`${orderNumber}/%`]), 1);
  });

  test('21. Production prepares fewer than requested: both quantities are kept, stock gets the prepared one', async () => {
    const { id } = await raise('branch-a', [line('Short Cake', 5, 5000)]);
    const itemId = (await orderFor('production', id)).items[0].id;

    assert.equal((await prepare(id, { items: [{ itemId, preparedQty: -1 }] })).status, 400);
    assert.equal((await prepare(id, { items: [{ itemId, preparedQty: 0 }] })).status, 400);
    assert.equal((await orderFor('production', id)).status, 'pending');
    assert.equal(await poolFor('Short Cake'), 0);

    assert.equal((await prepare(id, { items: [{ itemId, preparedQty: 4 }] })).status, 200);
    const item = (await orderFor('production', id)).items[0];
    assert.deepEqual([item.qty, item.preparedQty, item.amount], [5, 4, 5000]);
    assert.equal(await poolFor('Short Cake'), 4);
  });

  test('every row of a multi-row order is booked once, by its own movement', async () => {
    const { id, orderNumber } = await raise('branch-a', [
      line('Row One Cake', 1, 500),
      line('Row Two Cake', 2, 800),
      line('Row One Cake', 3, 100),
    ]);
    assert.equal((await prepare(id)).status, 200);
    assert.equal(await poolFor('Row One Cake'), 4);
    assert.equal(await poolFor('Row Two Cake'), 2);
    const { rows } = await db.query<{ ref_id: string; delta: string }>(
      `select ref_id, delta from production_stock_history where ref_id like $1 order by ref_id`, [`${orderNumber}/%`]);
    assert.deepEqual(rows.map((r) => [r.ref_id, Number(r.delta)]), [
      [`${orderNumber}/1`, 1], [`${orderNumber}/2`, 2], [`${orderNumber}/3`, 3],
    ]);
  });
});

describe('the branch verifies & approves with a photo — Branch Stock, automatically', () => {
  test('9–12. verification needs a photo; with one, the received quantity lands in branch stock', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Verified Cake', 2, 3000)]);
    await prepare(id);

    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
    const { rows } = await db.query<{ title: string }>(
      `select title from notifications where related_id = $1 and target_role = 'branch_manager'`, [id]);
    assert.deepEqual(rows.map((r) => r.title), [`Special Order ${orderNumber} Prepared — Please Verify`]);

    // No photo, no verification, no stock.
    const none = await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [] });
    assert.equal(none.status, 400);
    assert.match(JSON.stringify(none.body), /A photo is required/);
    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
    assert.equal(await branchStockFor(BRANCH_A, 'Verified Cake'), 0);

    const { res, photo } = await verify('branch-a', id);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const order = await orderFor('branch-a', id);
    assert.equal(order.status, 'approved');
    assert.equal(order.verifiedByName, 'a@mb.test');
    assert.equal(order.approvedByName, 'a@mb.test');
    assert.ok(order.verifiedAt && order.approvedAt && order.stockAddedAt);
    assert.deepEqual(order.verificationPhotos.map((p: { id: string }) => p.id), [photo]);
    assert.deepEqual([order.items[0].qty, order.items[0].preparedQty, order.items[0].verifiedQty, order.items[0].amount], [2, 2, 2, 3000]);

    // +2 at the branch; the same 2 have left Production Stock.
    assert.equal(await branchStockFor(BRANCH_A, 'Verified Cake'), 2);
    assert.equal(await branchStockFor(BRANCH_B, 'Verified Cake'), 0);
    assert.equal(await poolFor('Verified Cake'), 0);
    assert.equal(await preparedFor('Verified Cake'), 2);

    // The branch stock movement carries the order's reference.
    const into = await db.query<Record<string, unknown>>(
      `select type::text as type, delta, ref_id, branch_id from stock_history where ref_id like $1`, [`${orderNumber}/%`]);
    assert.deepEqual(into.rows.map((r) => [r['type'], Number(r['delta']), r['ref_id'], r['branch_id']]),
      [['production', 2, `${orderNumber}/1`, BRANCH_A]]);
    const out = await db.query<Record<string, unknown>>(
      `select delta, metadata->>'specialOrderNumber' as so from production_stock_history
        where ref_id like $1 and type = 'transfer_out'`, [`${orderNumber}/%`]);
    assert.deepEqual(out.rows.map((r) => [Number(r['delta']), r['so']]), [[-2, orderNumber]]);
  });

  test('16, 30. Verify & Approve tapped again — or re-sent — adds nothing', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Once Only Cake', 4, 2000)]);
    await prepare(id);

    const key = 'op-0190a1b2-verify-once-0001';
    const photo = await stagePhoto('branch-a', 'special_order_verification');
    const body = { attachmentIds: [photo] };
    const first = await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, body, { 'Idempotency-Key': key });
    const replay = await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, body, { 'Idempotency-Key': key });
    const secondTap = await verify('branch-a', id);            // a fresh request, no key
    const burst = await Promise.all([1, 2, 3].map(() => verify('branch-a', id)));

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    for (const r of [secondTap, ...burst]) {
      assert.equal(r.res.status, 200);
      assert.equal(r.res.body.alreadyVerified, true);
    }

    assert.equal(await branchStockFor(BRANCH_A, 'Once Only Cake'), 4);
    assert.equal(await poolFor('Once Only Cake'), 0);
    assert.equal(await num(`select count(*) as n from stock_history where ref_id like $1`, [`${orderNumber}/%`]), 1);
    assert.equal(await num(`select count(*) as n from production_stock_history where ref_id like $1`, [`${orderNumber}/%`]), 2);

    // Even the ledger writes themselves, replayed by hand, are no-ops.
    const { rows } = await db.query<{ product_id: string }>(`select product_id from special_order_items where special_order_id = $1`, [id]);
    await rpc('apply_stock_movement', {
      p_branch_id: BRANCH_A, p_product_id: rows[0]!.product_id, p_product_name: 'Once Only Cake', p_delta: 4,
      p_type: 'production', p_ref_id: `${orderNumber}/1`, p_business_date: '2026-10-05',
    });
    assert.equal(await branchStockFor(BRANCH_A, 'Once Only Cake'), 4);
  });

  test('22. received quantity: never more than prepared; fewer is recorded, and the rest stays with Production', async () => {
    const { id } = await raise('branch-a', [line('Mismatch Cake', 10, 8000)]);
    const itemId = (await orderFor('production', id)).items[0].id;
    await prepare(id, { items: [{ itemId, preparedQty: 8 }] });

    const tooMany = await verify('branch-a', id, [{ itemId, receivedQty: 9 }]);
    assert.equal(tooMany.res.status, 400);
    assert.match(JSON.stringify(tooMany.res.body), /cannot be more than the 8 prepared/);
    assert.equal((await verify('branch-a', id, [{ itemId, receivedQty: -1 }])).res.status, 400);
    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
    assert.equal(await branchStockFor(BRANCH_A, 'Mismatch Cake'), 0);
    assert.equal(await poolFor('Mismatch Cake'), 8);

    assert.equal((await verify('branch-a', id, [{ itemId, receivedQty: 7 }])).res.status, 200);
    const item = (await orderFor('branch-a', id)).items[0];
    // Requested, prepared and verified are three separate figures.
    assert.deepEqual([item.qty, item.preparedQty, item.verifiedQty, item.amount], [10, 8, 7, 8000]);
    assert.equal(await branchStockFor(BRANCH_A, 'Mismatch Cake'), 7);
    assert.equal(await poolFor('Mismatch Cake'), 1);
  });

  test('it cannot be verified before Production has prepared it', async () => {
    const { id } = await raise('branch-a', [line('Too Early Cake', 1, 100)]);
    const { res, photo } = await verify('branch-a', id);
    assert.equal(res.status, 409);
    assert.equal(await branchStockFor(BRANCH_A, 'Too Early Cake'), 0);
    // …and the refused request did not consume the photo.
    assert.equal(await num(`select count(*) as n from attachments where id = $1 and entity_id is null`, [photo]), 1);
  });

  test('the database will not verify without a photo, or for the wrong branch, whoever asks', async () => {
    const { id } = await raise('branch-a', [line('Photoless Cake', 1, 100)]);
    await prepare(id);
    const direct = await rpc('verify_special_order', { p_order_id: id, p_branch_id: BRANCH_A, p_by: ACTORS['branch-a']!.id, p_by_name: 'a@mb.test' });
    assert.deepEqual(direct.data, { status: 'photo_required' });
    const wrongBranch = await rpc('verify_special_order', { p_order_id: id, p_branch_id: BRANCH_B, p_by: ACTORS['branch-b']!.id, p_by_name: 'b@mb.test' });
    assert.deepEqual(wrongBranch.data, { status: 'forbidden' });
    assert.equal(await branchStockFor(BRANCH_A, 'Photoless Cake'), 0);
  });

  test('the request photo and the verification photo are separate, and both survive', async () => {
    const requestPhoto = await stagePhoto('branch-a', 'production_order_special_item');
    const { id } = await raise('branch-a', [line('Two Photo Cake', 1, 300, { attachmentIds: [requestPhoto] })]);

    const raised = await orderFor('production', id);
    assert.deepEqual(raised.items[0].requestPhotos.map((p: { id: string }) => p.id), [requestPhoto]);
    assert.deepEqual(raised.verificationPhotos, []);

    const verificationPhoto = await prepareAndVerify('branch-a', id);

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
    await prepare(id);
    const wrong = await stagePhoto('branch-a', 'production_order_special_item');
    assert.equal((await call('branch-a', 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [wrong] })).status, 409);
    assert.equal((await orderFor('branch-a', id)).status, 'awaiting_verification');
    assert.equal(await branchStockFor(BRANCH_A, 'Wrong Photo Cake'), 0);
  });

  test('only the branch verifies; Production cannot approve a new order on its behalf', async () => {
    const { id } = await raise('branch-a', [line('Guarded Cake', 2, 400)]);
    await prepare(id);
    for (const who of ['production', 'admin', 'finance']) {
      const photo = await stagePhoto('branch-a', 'special_order_verification');
      const r = await call(who, 'PUT', `/api/special-orders/${id}/verify`, { attachmentIds: [photo] });
      assert.ok(r.status === 403, `${who} → ${r.status}`);
    }
    // The legacy approval has nothing to do with an order that is not 'verified'.
    assert.equal((await call('production', 'PUT', `/api/special-orders/${id}/approve`)).status, 409);
    assert.equal(await branchStockFor(BRANCH_A, 'Guarded Cake'), 0);
    assert.equal(await poolFor('Guarded Cake'), 2);
  });
});

describe('available for sale at the branch that holds it', () => {
  test('13. the till list shows a verified Special Order item to its own branch only, at Amount ÷ Qty', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Sellable Cake', 2, 3000)]);
    const name = `Sellable Cake — ${orderNumber}/1`;
    const till = async (as: string) =>
      (await call(as, 'GET', '/api/products?isActive=true&sellable=true')).body.products as { name: string; price: number | string }[];

    // Not before it is in branch stock.
    await prepare(id);
    assert.equal((await till('branch-a')).some((p) => p.name === name), false);

    await verify('branch-a', id);
    const mine = (await till('branch-a')).find((p) => p.name === name);
    assert.ok(mine, 'the item is offered to the branch that holds it');
    assert.equal(Number(mine.price), 1500);
    assert.equal((await till('branch-b')).some((p) => p.name === name), false);

    // Never in the ordinary catalogue, for anyone.
    const catalogue = (await call('branch-a', 'GET', '/api/products?isActive=true')).body.products as { name: string }[];
    assert.equal(catalogue.some((p) => p.name === name), false);
  });

  test('14. a sale takes it out of branch stock, and it leaves the till when it is gone', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Sold Cake', 2, 3000)]);
    await prepareAndVerify('branch-a', id);
    const { rows } = await db.query<{ product_id: string }>(`select product_id from special_order_items where special_order_id = $1`, [id]);
    const productId = rows[0]!.product_id;
    // What the existing sale path books for one unit: a 'sale' movement on the
    // branch ledger, against the same product the Special Order put there.
    const sell = (ref: string) => rpc('apply_stock_movement', {
      p_branch_id: BRANCH_A, p_product_id: productId, p_product_name: 'Sold Cake', p_delta: -1,
      p_type: 'sale', p_ref_id: ref, p_business_date: '2026-10-05',
    });

    await sell('sale-1');
    assert.equal(await branchStockFor(BRANCH_A, 'Sold Cake'), 1);
    // The amount agreed on the order is untouched by the sale.
    assert.equal((await orderFor('branch-a', id)).items[0].amount, 3000);

    await sell('sale-2');
    assert.equal(await branchStockFor(BRANCH_A, 'Sold Cake'), 0);
    const till = (await call('branch-a', 'GET', '/api/products?isActive=true&sellable=true')).body.products as { name: string }[];
    assert.equal(till.some((p) => p.name === `Sold Cake — ${orderNumber}/1`), false);
  });
});

describe('orders verified before migration 145', () => {
  test('a legacy "verified" order still finishes through Production approval, once', async () => {
    const { id } = await raise('branch-a', [line('Legacy Cake', 3, 900)]);
    // The state migration 143 left such an order in: verified, nothing booked.
    await db.query(`update special_orders set status = 'verified', verified_at = now() where id = $1`, [id]);
    await db.query(
      `insert into attachments (entity, entity_id, storage_path, uploaded_by) values ('special_order_verification', $1, $2, $3)`,
      [id, `legacy/${id}.webp`, ACTORS['branch-a']!.id]);

    for (const who of ['branch-a', 'finance']) {
      assert.equal((await call(who, 'PUT', `/api/special-orders/${id}/approve`)).status, 403);
    }
    const results = await Promise.all([1, 2].map(() => call('production', 'PUT', `/api/special-orders/${id}/approve`)));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal((await call('admin', 'PUT', `/api/special-orders/${id}/approve`)).body.alreadyApproved, true);

    assert.equal(await preparedFor('Legacy Cake'), 3);
    assert.equal(await poolFor('Legacy Cake'), 0);
    assert.equal(await branchStockFor(BRANCH_A, 'Legacy Cake'), 3);
  });

  test('146: an order approved under 143 (pool only) is delivered to its branch — once, however often it runs', async () => {
    const { id, orderNumber } = await raise('branch-a', [line('Stranded Cake', 1, 3900)]);
    const { rows } = await db.query<{ product_id: string }>(`select product_id from special_order_items where special_order_id = $1`, [id]);
    // Exactly what migration 143's approval left behind: approved, +1 in the pool, nothing at the branch.
    await db.query(`update special_orders set status = 'approved', approved_at = now(), approved_by_name = 'prod@mb.test' where id = $1`, [id]);
    await rpc('apply_production_stock_movement', {
      p_product_id: rows[0]!.product_id, p_product_name: 'Stranded Cake', p_delta: 1, p_type: 'prepare',
      p_ref_id: `${orderNumber}/1`, p_business_date: '2026-10-05',
    });
    const others = await num(`select coalesce(sum(balance), 0) as n from stock`);

    const fix = read('20261005000146_deliver_stranded_special_orders.sql');
    await db.exec(fix);
    await db.exec(fix);

    assert.equal(await branchStockFor(BRANCH_A, 'Stranded Cake'), 1);
    assert.equal(await poolFor('Stranded Cake'), 0);
    assert.equal(await preparedFor('Stranded Cake'), 1);
    assert.equal(await num(`select count(*) as n from stock_history where ref_id = $1`, [`${orderNumber}/1`]), 1);
    const item = (await orderFor('branch-a', id)).items[0];
    assert.deepEqual([item.qty, item.preparedQty, item.verifiedQty], [1, 1, 1]);
    // Every order that WAS delivered properly is left exactly as it was.
    assert.equal(await num(`select coalesce(sum(balance), 0) as n from stock`), others + 1);
  });

  test('an order prepared before 145 (no stock booked) is booked in full when the branch verifies', async () => {
    const { id } = await raise('branch-a', [line('Half Way Cake', 2, 600)]);
    await db.query(`update special_orders set status = 'awaiting_verification', prepared_at = now() where id = $1`, [id]);

    assert.equal((await verify('branch-a', id)).res.status, 200);
    const item = (await orderFor('branch-a', id)).items[0];
    assert.deepEqual([item.qty, item.preparedQty, item.verifiedQty], [2, 2, 2]);
    assert.equal(await preparedFor('Half Way Cake'), 2);
    assert.equal(await poolFor('Half Way Cake'), 0);
    assert.equal(await branchStockFor(BRANCH_A, 'Half Way Cake'), 2);
  });
});

describe('several orders, several branches', () => {
  test('simultaneous orders from two branches each land once, in their own branch', async () => {
    const raised = await Promise.all([
      raise('branch-a', [line('Shared Name Cake', 2, 600)]),
      raise('branch-b', [line('shared name cake', 3, 900)]),
      raise('branch-a', [line('Shared Name Cake', 4, 1200)]),
    ]);
    assert.equal(new Set(raised.map((r) => r.orderNumber)).size, 3);

    await prepareAndVerify('branch-a', raised[0]!.id);
    await prepareAndVerify('branch-b', raised[1]!.id);
    await prepareAndVerify('branch-a', raised[2]!.id);

    assert.equal(await preparedFor('Shared Name Cake'), 9);
    assert.equal(await branchStockFor(BRANCH_A, 'Shared Name Cake'), 6);
    assert.equal(await branchStockFor(BRANCH_B, 'Shared Name Cake'), 3);
    assert.equal(await poolFor('Shared Name Cake'), 0);
  });

  test('23, 25. Branch A cannot see or act on Branch B\'s Special Orders', async () => {
    const { id } = await raise('branch-b', [line('Branch B Only Cake', 1, 250)]);

    assert.equal((await listFor('branch-a')).some((o) => o.id === id), false);
    assert.equal((await listFor('branch-b')).some((o) => o.id === id), true);
    // The scope is the token's branch — a query parameter cannot widen it.
    const peek = await call('branch-a', 'GET', `/api/special-orders?branchId=${BRANCH_B}`);
    assert.equal(peek.body.orders.some((o: { id: string }) => o.id === id), false);
    assert.equal((await call('finance', 'GET', '/api/special-orders')).status, 403);

    await prepare(id);
    const { res, photo } = await verify('branch-a', id);
    assert.equal(res.status, 403);
    assert.equal((await orderFor('branch-b', id)).status, 'awaiting_verification');
    assert.equal(await branchStockFor(BRANCH_A, 'Branch B Only Cake'), 0);
    assert.equal(await branchStockFor(BRANCH_B, 'Branch B Only Cake'), 0);
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
