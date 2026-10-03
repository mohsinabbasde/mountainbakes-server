import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  DEFAULT_RESTRICTION_RULES,
  enforcesProductionStock,
  evalProductionShortage,
  type ProductionShortfall,
} from '../../shared';

/**
 * "Production stock less than demand" at Submit for Verification, against the
 * real stock check: migration 90's `review_production_order_checked` in pglite,
 * over stub tables.
 *
 * Nothing here recomputes availability. The shortfalls are the database's own
 * (pool balance − outstanding demand, this order excluded); the tests only set
 * up demand and stock and read back what the API would be handed. The review
 * itself (`review_production_order`, migration 56) is stubbed to the one thing
 * that matters here — whether it was reached, and with which status.
 */

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create type branch_production_order_status as enum
    ('pending', 'awaiting_verification', 'verified', 'approved', 'rejected');
  create table products (id uuid primary key default gen_random_uuid(), name text not null);
  create table production_stock (product_id uuid primary key, balance numeric not null default 0);
  create table production_orders (
    id uuid primary key default gen_random_uuid(),
    status branch_production_order_status not null default 'pending');
  create table production_order_items (
    id uuid primary key default gen_random_uuid(), production_order_id uuid not null,
    product_id uuid, qty numeric not null, approved_qty numeric);
  create function public.review_production_order(
    p_order_id uuid, p_status branch_production_order_status, p_overrides jsonb, p_reason text,
    p_reviewed_by uuid, p_reviewed_by_name text, p_packing_overrides jsonb default '[]'::jsonb
  ) returns jsonb language plpgsql as $$
    begin
      update production_orders set status = p_status where id = p_order_id and status = 'pending';
      if not found then return jsonb_build_object('status', 'already_reviewed'); end if;
      return jsonb_build_object('status', 'ok');
    end $$;
`;

type Reviewed = { status: 'ok' } | { status: 'insufficient_stock'; shortfalls: ProductionShortfall[] };

let db: PGlite;
const product: Record<string, string> = {};

async function stock(name: string, balance: number) {
  await db.query(
    `insert into production_stock (product_id, balance) values ($1, $2)
     on conflict (product_id) do update set balance = excluded.balance`,
    [product[name], balance],
  );
}

/** A pending demand: { 'Cream Puff': 100, … } */
async function demand(lines: Record<string, number>): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into production_orders default values returning id`);
  const id = rows[0]!.id;
  for (const [name, qty] of Object.entries(lines)) {
    await db.query(`insert into production_order_items (production_order_id, product_id, qty) values ($1, $2, $3)`, [id, product[name], qty]);
  }
  return id;
}

/** What PUT /api/production-orders/:id/review hands the database. */
async function submit(id: string, opts: { enforce?: boolean; approvedItems?: { productId: string; approvedQty: number }[] } = {}): Promise<Reviewed> {
  const { rows } = await db.query<{ r: Reviewed }>(
    `select public.review_production_order_checked(
       p_order_id => $1, p_status => 'awaiting_verification', p_overrides => $2::jsonb, p_reason => null,
       p_reviewed_by => null, p_reviewed_by_name => 'production@mb.test',
       p_packing_overrides => '[]'::jsonb, p_enforce_stock => $3) as r`,
    [id, JSON.stringify(opts.approvedItems ?? []), opts.enforce ?? true],
  );
  return rows[0]!.r;
}

const statusOf = async (id: string) =>
  (await db.query<{ status: string }>(`select status from production_orders where id = $1`, [id])).rows[0]!.status;

/** Product name → less qty, as the warning lists them. */
const less = (r: Reviewed) => {
  assert.equal(r.status, 'insufficient_stock');
  const shortfalls = (r as Extract<Reviewed, { status: 'insufficient_stock' }>).shortfalls;
  return Object.fromEntries(evalProductionShortage(shortfalls)!.shortages!.map((s) => [s.productName, s.short]));
};

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  const migration = readFileSync(join(__dirname, '../../../supabase/migrations/20260826000090_production_available_stock.sql'), 'utf8');
  await db.exec(`begin;${migration}commit;`);
  for (const name of ['Cream Puff', 'Chocolate Balls', 'Lotus Pastry']) {
    const { rows } = await db.query<{ id: string }>(`insert into products (name) values ($1) returning id`, [name]);
    product[name] = rows[0]!.id;
  }
});

beforeEach(async () => {
  await db.exec(`delete from production_order_items; delete from production_orders; delete from production_stock;`);
});

describe('submit for verification — production stock against demand', () => {
  test('1. stock equal to demand → no warning, submission continues', async () => {
    await stock('Cream Puff', 100);
    const id = await demand({ 'Cream Puff': 100 });
    assert.deepEqual(await submit(id), { status: 'ok' });
    assert.equal(await statusOf(id), 'awaiting_verification');
  });

  test('2. more stock than demand → no warning, submission continues', async () => {
    await stock('Cream Puff', 120);
    const id = await demand({ 'Cream Puff': 100 });
    assert.deepEqual(await submit(id), { status: 'ok' });
    assert.equal(await statusOf(id), 'awaiting_verification');
  });

  test('3. short stock → product named, less qty 30, submission stopped', async () => {
    await stock('Cream Puff', 70);
    const id = await demand({ 'Cream Puff': 100 });
    const r = await submit(id);
    assert.deepEqual(less(r), { 'Cream Puff': 30 });
    assert.equal(await statusOf(id), 'pending');

    const notice = evalProductionShortage((r as Extract<Reviewed, { status: 'insufficient_stock' }>).shortfalls)!;
    assert.equal(notice.severity, 'blocking');
    assert.deepEqual(notice.shortages, [{ productName: 'Cream Puff', required: 100, available: 70, short: 30 }]);
  });

  test('4. several short products → each one with its own less qty', async () => {
    await stock('Cream Puff', 70);
    await stock('Chocolate Balls', 30);
    const id = await demand({ 'Cream Puff': 100, 'Chocolate Balls': 50 });
    assert.deepEqual(less(await submit(id)), { 'Cream Puff': 30, 'Chocolate Balls': 20 });
    assert.equal(await statusOf(id), 'pending');
  });

  test('5. mixed → only the short product is reported', async () => {
    await stock('Cream Puff', 100);
    await stock('Lotus Pastry', 40);
    const id = await demand({ 'Cream Puff': 100, 'Lotus Pastry': 50 });
    assert.deepEqual(less(await submit(id)), { 'Lotus Pastry': 10 });
    assert.equal(await statusOf(id), 'pending');
  });

  test('6. new stock added → shortage gone; the demand moves on to verification, never straight to approved', async () => {
    await stock('Cream Puff', 70);
    const id = await demand({ 'Cream Puff': 100 });
    assert.deepEqual(less(await submit(id)), { 'Cream Puff': 30 });

    await stock('Cream Puff', 100);
    // Adding stock approves nothing by itself.
    assert.equal(await statusOf(id), 'pending');

    assert.deepEqual(await submit(id), { status: 'ok' });
    assert.equal(await statusOf(id), 'awaiting_verification');
  });

  test('7. bypass attempt → the server decides, refuses, returns the shortage, and approves nothing', async () => {
    await stock('Cream Puff', 70);
    const id = await demand({ 'Cream Puff': 100 });
    const rule = DEFAULT_RESTRICTION_RULES.production.stockShortage;

    // A production user sending ?override=1: the route never sets adminOverride for them.
    const asProduction = enforcesProductionStock(rule, { adminOverride: false });
    assert.equal(asProduction, true);
    assert.deepEqual(less(await submit(id, { enforce: asProduction })), { 'Cream Puff': 30 });

    // A retry changes nothing.
    assert.deepEqual(less(await submit(id, { enforce: asProduction })), { 'Cream Puff': 30 });
    assert.equal(await statusOf(id), 'pending');

    // Admin override closed in the rules: even a Super Admin is checked.
    const closed = enforcesProductionStock({ ...rule, allowAdminOverride: false }, { adminOverride: true });
    assert.deepEqual(less(await submit(id, { enforce: closed })), { 'Cream Puff': 30 });
    assert.equal(await statusOf(id), 'pending');
  });

  test('available stock is the existing calculation: stock already promised to other demands is not available', async () => {
    await stock('Cream Puff', 100);
    await demand({ 'Cream Puff': 40 }); // another branch's pending demand
    const id = await demand({ 'Cream Puff': 100 });
    assert.deepEqual(less(await submit(id)), { 'Cream Puff': 40 });
  });

  test('a product with no stock row at all is short by the whole demand', async () => {
    const id = await demand({ 'Chocolate Balls': 15 });
    assert.deepEqual(less(await submit(id)), { 'Chocolate Balls': 15 });
  });

  test('Change Quantity down to what is in stock → submission continues', async () => {
    await stock('Cream Puff', 70);
    const id = await demand({ 'Cream Puff': 100 });
    assert.deepEqual(await submit(id, { approvedItems: [{ productId: product['Cream Puff']!, approvedQty: 70 }] }), { status: 'ok' });
  });

  test('an admin override, while the rule allows it, sends a short demand to verification — not to approved', async () => {
    await stock('Cream Puff', 70);
    const id = await demand({ 'Cream Puff': 100 });
    const enforce = enforcesProductionStock(DEFAULT_RESTRICTION_RULES.production.stockShortage, { adminOverride: true });
    assert.equal(enforce, false);
    assert.deepEqual(await submit(id, { enforce }), { status: 'ok' });
    assert.equal(await statusOf(id), 'awaiting_verification');
  });
});
