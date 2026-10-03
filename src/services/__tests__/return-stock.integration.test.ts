import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/**
 * Branch Return Stock is a separate inventory from Production Stock.
 *
 * Runs migrations 89 (the pool's movement function), 138 and 139 verbatim in
 * pglite over stub tables, and drives the same RPCs the API calls:
 * `accept_production_return` for PUT /api/production-returns/:id/review and
 * `transfer_return_stock_to_production` for POST /api/return-stock/transfer.
 *
 * Nothing here recomputes a balance. Every assertion reads the two pools back
 * from the database — both the running balance and Σ delta over the ledger,
 * which must agree.
 */

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;

  create type production_stock_movement_type as enum ('prepare', 'transfer_out', 'return_in', 'sale', 'adjustment');
  create type production_return_status as enum ('pending', 'accepted', 'rejected', 'returned');
  create type production_return_disposition as enum ('saleable', 'damaged', 'expired');

  create table users (id uuid primary key default gen_random_uuid());
  create table branches (id uuid primary key default gen_random_uuid(), name text not null);
  create table products (id uuid primary key default gen_random_uuid(), name text not null, price numeric);
  create table production_orders (id uuid primary key default gen_random_uuid(), business_date date);
  create table production_order_items (
    id uuid primary key default gen_random_uuid(), production_order_id uuid, product_id uuid);
  create table product_price_history (
    product_id uuid, new_price numeric, status text, effective_date date, version_number int);

  create table production_stock (
    product_id uuid primary key references products (id),
    product_name text, balance numeric(14,3) not null default 0,
    updated_at timestamptz not null default now());
  create table production_stock_history (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references products (id), product_name text not null,
    type production_stock_movement_type not null, delta numeric(14,3) not null,
    balance_after numeric(14,3) not null, ref_id text not null, business_date date not null,
    created_at timestamptz not null default now(),
    constraint production_stock_history_idempotency_key unique (ref_id, product_id, type));

  create table production_returns (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text,
    product_id uuid not null references products (id), product_name text not null,
    qty numeric(14,3) not null check (qty > 0), reason text,
    status production_return_status not null default 'pending',
    disposition production_return_disposition not null default 'saleable', disposition_note text,
    source text, business_date date not null,
    created_at timestamptz not null default now(),
    reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz);
`;

const MIGRATIONS = join(__dirname, '../../../supabase/migrations');
const TODAY = '2026-10-03';

let db: PGlite;
const product: Record<string, string> = {};
const branch: Record<string, string> = {};

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query<T>(sql, params)).rows[0]!;

/** Production Stock, both ways it can be read. They must agree. */
async function productionStock(name = 'Cream Puff'): Promise<number> {
  const bal = await db.query<{ balance: string }>(`select balance from production_stock where product_id = $1`, [product[name]]);
  const led = await one<{ s: string }>(`select coalesce(sum(delta), 0) as s from production_stock_history where product_id = $1`, [product[name]]);
  const balance = Number(bal.rows[0]?.balance ?? 0);
  assert.equal(balance, Number(led.s), 'production balance = Σ production ledger');
  return balance;
}

/** Branch Return Stock, both ways it can be read. They must agree. */
async function returnStock(name = 'Cream Puff'): Promise<number> {
  const bal = await db.query<{ balance: string }>(`select balance from return_stock where product_id = $1`, [product[name]]);
  const led = await one<{ s: string }>(`select coalesce(sum(delta), 0) as s from return_stock_history where product_id = $1`, [product[name]]);
  const balance = Number(bal.rows[0]?.balance ?? 0);
  assert.equal(balance, Number(led.s), 'return balance = Σ return ledger');
  return balance;
}

/** Production prepares stock — the ordinary way units enter the pool. */
async function prepare(qty: number, name = 'Cream Puff') {
  await db.query(
    `select public.apply_production_stock_movement($1, $2, $3, 'prepare', $4, $5)`,
    [product[name], name, qty, `prep-${Math.random()}`, TODAY],
  );
}

/** A branch raises a return: a pending production_returns row. */
async function raiseReturn(branchName: string, qty: number, name = 'Cream Puff', disposition = 'saleable'): Promise<string> {
  const r = await one<{ id: string }>(
    `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, reason, source, business_date, disposition)
     values ($1, $2, $3, $4, $5, 'unsold', 'branch', $6, $7) returning id`,
    [branch[branchName], branchName, product[name], name, qty, TODAY, disposition],
  );
  return r.id;
}

/** What PUT /api/production-returns/:id/review (accepted) hands the database. */
async function accept(id: string, disposition = 'saleable'): Promise<{ status: string }> {
  const r = await one<{ r: { status: string } }>(
    `select public.accept_production_return($1, $2, null, null, 'production@mb.test', $3) as r`,
    [id, disposition, TODAY],
  );
  return r.r;
}

/** What POST /api/return-stock/transfer hands the database. */
async function transfer(qty: number, refId: string, name = 'Cream Puff', reason = 'Approved for reuse') {
  const r = await one<{ r: { status: string; available?: number } }>(
    `select public.transfer_return_stock_to_production($1, $2, $3, $4, $5, $6, null, 'admin@mb.test') as r`,
    [product[name], name, qty, refId, TODAY, reason],
  );
  return r.r;
}

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(readFileSync(join(MIGRATIONS, '20260826000089_production_stock_ledger_audit.sql'), 'utf8'));
  // Own statement, as in production: the new enum value cannot be used in the
  // transaction that adds it.
  await db.exec(readFileSync(join(MIGRATIONS, '20261003000138_return_transfer_movement_type.sql'), 'utf8'));
  await db.exec(`begin;${readFileSync(join(MIGRATIONS, '20261003000139_branch_return_stock.sql'), 'utf8')}commit;`);

  for (const name of ['Cream Puff', 'Pastry']) {
    product[name] = (await one<{ id: string }>(`insert into products (name) values ($1) returning id`, [name])).id;
  }
  for (const name of ['DHA', 'North Nazimabad', 'Gulshan']) {
    branch[name] = (await one<{ id: string }>(`insert into branches (name) values ($1) returning id`, [name])).id;
  }
});

beforeEach(async () => {
  await db.exec(`
    delete from return_stock_history; delete from return_stock;
    delete from production_stock_history; delete from production_stock;
    delete from production_returns;
  `);
});

describe('branch return stock stays separate from production stock', () => {
  test('1. basic return: production 100 stays 100, return stock becomes 5', async () => {
    await prepare(100);
    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 0);

    assert.equal((await accept(await raiseReturn('DHA', 5))).status, 'ok');

    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 5);
  });

  test('2. multiple returns: 5 + 3 + 2 → production 100, return stock 10', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 5));
    await accept(await raiseReturn('North Nazimabad', 3));
    await accept(await raiseReturn('Gulshan', 2));

    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 10);
  });

  test('3. explicit transfer of 3 → production 103, return stock 7, booked as return_transfer', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 10));
    assert.equal(await productionStock(), 100);

    assert.equal((await transfer(3, 'transfer-1')).status, 'ok');

    assert.equal(await productionStock(), 103);
    assert.equal(await returnStock(), 7);

    // The increase is the transfer's, not the return's.
    const pool = await db.query<{ type: string; delta: string; ref_id: string }>(
      `select type, delta, ref_id from production_stock_history where type <> 'prepare'`);
    assert.deepEqual(pool.rows.map((r) => [r.type, Number(r.delta), r.ref_id]), [['return_transfer', 3, 'transfer-1']]);
    const out = await db.query<{ delta: string }>(
      `select delta from return_stock_history where type = 'transfer_out' and ref_id = 'transfer-1'`);
    assert.deepEqual(out.rows.map((r) => Number(r.delta)), [-3]);
  });

  test('4. a return does not change production stock; return stock rises by exactly the qty', async () => {
    await prepare(40);
    await accept(await raiseReturn('DHA', 4));
    const productionBefore = await productionStock();
    const returnBefore = await returnStock();
    const poolRowsBefore = (await one<{ n: number }>(`select count(*)::int as n from production_stock_history`)).n;

    await accept(await raiseReturn('DHA', 6));

    assert.equal(await productionStock(), productionBefore);
    assert.equal(await returnStock(), returnBefore + 6);
    // Not "nets to zero" — nothing at all was written to the pool's ledger.
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from production_stock_history`)).n, poolRowsBefore);
  });

  test('5. DHA and North Nazimabad returns are recorded against their own branch', async () => {
    await prepare(100);
    await prepare(50, 'Pastry');
    await accept(await raiseReturn('DHA', 5));
    await accept(await raiseReturn('North Nazimabad', 2, 'Pastry'));
    await accept(await raiseReturn('North Nazimabad', 1));

    assert.equal(await productionStock(), 100);
    assert.equal(await productionStock('Pastry'), 50);
    assert.equal(await returnStock(), 6);
    assert.equal(await returnStock('Pastry'), 2);

    const byBranch = await db.query<{ name: string; qty: string }>(
      `select b.name, sum(h.delta) as qty from return_stock_history h
         join branches b on b.id = h.branch_id group by b.name order by b.name`);
    assert.deepEqual(byBranch.rows.map((r) => [r.name, Number(r.qty)]), [['DHA', 5], ['North Nazimabad', 3]]);
  });

  test('6. damaged and expired returns also land in return stock, never in production', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 4), 'damaged');
    await accept(await raiseReturn('DHA', 1), 'expired');

    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 5);
  });
});

describe('no duplicate movements', () => {
  test('7. accepting the same return twice credits return stock once', async () => {
    await prepare(100);
    const id = await raiseReturn('DHA', 5);
    assert.equal((await accept(id)).status, 'ok');
    assert.equal((await accept(id)).status, 'conflict');

    assert.equal(await returnStock(), 5);
    assert.equal(await productionStock(), 100);
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from return_stock_history`)).n, 1);
  });

  test('8. a rejected or sent-back return cannot be accepted into return stock', async () => {
    const id = await raiseReturn('DHA', 5);
    await db.query(`update production_returns set status = 'rejected' where id = $1`, [id]);
    assert.equal((await accept(id)).status, 'conflict');
    assert.equal(await returnStock(), 0);
  });

  test('9. replaying a transfer with the same ref moves the units once', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 10));
    assert.equal((await transfer(3, 'transfer-retry')).status, 'ok');
    assert.equal((await transfer(3, 'transfer-retry')).status, 'duplicate');

    assert.equal(await productionStock(), 103);
    assert.equal(await returnStock(), 7);
  });

  test('10. transferring more than return stock holds is refused and moves nothing', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 5));

    const r = await transfer(6, 'transfer-too-much');
    assert.equal(r.status, 'insufficient');
    assert.equal(Number(r.available), 5);
    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 5);

    // Nothing to transfer at all for a product that never came back.
    assert.equal((await transfer(1, 'transfer-none', 'Pastry')).status, 'insufficient');
    assert.equal(await productionStock('Pastry'), 0);
  });

  test('11. a transfer needs a reason and a positive quantity', async () => {
    await accept(await raiseReturn('DHA', 5));
    assert.equal((await transfer(2, 'transfer-no-reason', 'Cream Puff', '  ')).status, 'invalid');
    assert.equal((await transfer(0, 'transfer-zero')).status, 'invalid');
    assert.equal(await returnStock(), 5);
    assert.equal(await productionStock(), 0);
  });
});

describe('moving pre-migration returns out of production stock', () => {
  /** A return accepted the OLD way: +qty return_in straight into the pool. */
  async function legacyAccepted(branchName: string, qty: number, disposition = 'saleable'): Promise<string> {
    const id = await raiseReturn(branchName, qty, 'Cream Puff', disposition);
    await db.query(`update production_returns set status = 'accepted', business_date = '2026-09-20' where id = $1`, [id]);
    await db.query(
      `select public.apply_production_stock_movement($1, 'Cream Puff', $2, 'return_in', $3, '2026-09-20', $4)`,
      [product['Cream Puff'], qty, id, branch[branchName]],
    );
    if (disposition !== 'saleable') {
      // Migration 91's write-off: the same units straight back out.
      await db.query(
        `select public.apply_production_stock_movement($1, 'Cream Puff', $2, 'adjustment', $3, '2026-09-20')`,
        [product['Cream Puff'], -qty, `adj:${id}`],
      );
    }
    return id;
  }

  test('12. saleable returns leave production and seed return stock; history is kept', async () => {
    await prepare(100);
    const a = await legacyAccepted('DHA', 5);
    await legacyAccepted('North Nazimabad', 3);
    await legacyAccepted('DHA', 4, 'damaged'); // already netted out by its write-off
    assert.equal(await productionStock(), 108);
    assert.equal(await returnStock(), 0);

    const moved = await one<{ n: number }>(`select app.split_return_stock($1::date) as n`, [TODAY]);
    assert.equal(moved.n, 2);
    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 8);

    // The original return_in rows are untouched — the split is compensating.
    assert.equal((await one<{ n: number }>(
      `select count(*)::int as n from production_stock_history where type = 'return_in'`)).n, 3);
    // The pool side is dated the day of the split, so closed days do not change.
    const split = await one<{ business_date: string; delta: string }>(
      `select business_date::text, delta from production_stock_history where ref_id = $1`, [`return_split_${a}`]);
    assert.deepEqual([split.business_date, Number(split.delta)], [TODAY, -5]);
    // The return side keeps the return's own date and branch.
    const seeded = await one<{ business_date: string; branch_id: string }>(
      `select business_date::text, branch_id from return_stock_history where ref_id = $1`, [a]);
    assert.deepEqual([seeded.business_date, seeded.branch_id], ['2026-09-20', branch['DHA']]);
  });

  test('13. running the split again moves nothing', async () => {
    await prepare(100);
    await legacyAccepted('DHA', 5);
    await db.query(`select app.split_return_stock($1::date)`, [TODAY]);

    const again = await one<{ n: number }>(`select app.split_return_stock($1::date) as n`, [TODAY]);
    assert.equal(again.n, 0);
    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 5);
  });

  test('14. a return accepted the new way is not touched by the split', async () => {
    await prepare(100);
    await accept(await raiseReturn('DHA', 5));

    const moved = await one<{ n: number }>(`select app.split_return_stock($1::date) as n`, [TODAY]);
    assert.equal(moved.n, 0);
    assert.equal(await productionStock(), 100);
    assert.equal(await returnStock(), 5);
  });
});
