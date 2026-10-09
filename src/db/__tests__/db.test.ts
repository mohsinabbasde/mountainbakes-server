import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { dbFor } from '../index';
import { inFilter, notFilter, parseLogic } from '../logic';
import { parseSelect } from '../select';
import { firstDifference, onlyTiesReordered } from '../shadow';
import { usePglite } from '../testing';

/**
 * The query layer on its own, against pglite.
 *
 * What these pin down is the layer's CONTRACT — the result shapes and error
 * codes call sites depend on — so a change to the SQL generator that breaks one
 * fails here, without a server. That the layer agrees with PostgREST itself,
 * table by table, is a different question and a different tool: `pnpm db:diff`.
 */

const SCHEMA = `
  create type order_status as enum ('pending', 'delivered', 'cancelled');
  create table branches (id uuid primary key default gen_random_uuid(), name text not null unique);
  create table orders (
    id uuid primary key default gen_random_uuid(),
    order_number text not null unique,
    branch_id uuid references branches(id),
    status order_status not null default 'pending',
    grand_total numeric(12,2) not null default 0,
    business_date date not null,
    notes text,
    meta jsonb,
    created_at timestamptz not null default '2026-10-01 05:06:07.123456+00');
  create table order_items (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null references orders(id) on delete cascade,
    product_name text not null, qty numeric(10,3) not null, line_no int not null);
  create table settings (id boolean primary key default true, theme text, updated_count int not null default 0);
  create function order_total(p_order_id uuid) returns numeric language sql stable as
    $$ select grand_total from orders where id = p_order_id $$;
  create function orders_on(p_date date, p_status order_status default 'pending') returns setof orders language sql stable as
    $$ select * from orders where business_date = p_date and status = p_status order by order_number $$;
  create function order_numbers(p_tags text[]) returns jsonb language sql stable as
    $$ select jsonb_build_object('tags', to_jsonb(p_tags), 'n', (select count(*) from orders)) $$;
  create function touch_settings() returns void language sql as
    $$ update settings set updated_count = updated_count + 1 $$;
  create function refuse(p_reason text) returns int language plpgsql as
    $$ begin raise exception 'Refused: %', p_reason using errcode = 'MB001', hint = 'try later'; end $$;
`;

const db = dbFor('test');
let pg: PGlite;
const ids = { gulberg: '', dha: '', o1: '', o2: '' };

before(async () => {
  pg = new PGlite();
  // Production runs in UTC, and every timestamp the API returns is rendered in it.
  await pg.exec(`set time zone 'UTC'`);
  await pg.exec(SCHEMA);
  await usePglite(pg);

  const b = await db.from('branches').insert([{ name: 'Gulberg' }, { name: 'DHA' }]).select().order('name');
  ids.dha = b.data![0].id;
  ids.gulberg = b.data![1].id;
  const o = await db
    .from('orders')
    .insert([
      { order_number: 'ORD-1', branch_id: ids.gulberg, status: 'delivered', grand_total: 1234.5, business_date: '2026-10-01', meta: { tills: [1, 2] } },
      { order_number: 'ORD-2', branch_id: ids.gulberg, status: 'pending', grand_total: 10, business_date: '2026-10-02', notes: 'a,b (c)' },
      { order_number: 'ORD-3', branch_id: ids.dha, status: 'pending', grand_total: 99.99, business_date: '2026-10-02' },
    ])
    .select('id')
    .order('order_number');
  assert.equal(o.error, null);
  ids.o1 = o.data![0].id;
  ids.o2 = o.data![1].id;
  await db.from('order_items').insert([
    { order_id: ids.o1, product_name: 'Bread', qty: 2, line_no: 2 },
    { order_id: ids.o1, product_name: 'Cake', qty: 1.5, line_no: 1 },
  ]);
});

describe('reading', () => {
  test('values come back as PostgREST serialises them', async () => {
    const { data, error } = await db.from('orders').select('*').eq('id', ids.o1).single();
    assert.equal(error, null);
    assert.equal(data.grand_total, 1234.5); // a number, not "1234.50"
    assert.equal(data.business_date, '2026-10-01'); // a date, not a timestamp
    assert.equal(data.created_at, '2026-10-01T05:06:07.123456+00:00'); // microseconds, +00:00
    assert.deepEqual(data.meta, { tills: [1, 2] });
    assert.equal(data.notes, null);
  });

  test('filters are cast to the column they apply to', async () => {
    const byEnum = await db.from('orders').select('order_number').eq('status', 'pending').order('order_number');
    assert.deepEqual(byEnum.data!.map((r: { order_number: string }) => r.order_number), ['ORD-2', 'ORD-3']);
    const byRange = await db.from('orders').select('order_number').gte('grand_total', '99.99').lt('business_date', '2026-10-03').neq('branch_id', ids.dha);
    assert.equal(byRange.data!.length, 1);
    const none = await db.from('orders').select('id').in('id', []);
    assert.deepEqual(none.data, []);
    const awkward = await db.from('orders').select('order_number').eq('notes', 'a,b (c)');
    assert.equal(awkward.data![0].order_number, 'ORD-2');
  });

  test('a value that does not fit the column is the database\'s error, by its code', async () => {
    const { data, error } = await db.from('orders').select('id').eq('id', 'not-a-uuid');
    assert.equal(data, null);
    assert.equal(error!.code, '22P02');
    assert.match(error!.message, /invalid input syntax for type uuid/);
    assert.equal((await db.from('orders').select('id').eq('nope', 1)).error!.code, '42703');
    assert.equal((await db.from('nope').select('*')).error!.code, 'PGRST205');
  });

  test('child rows nest under the alias asked for, in the order asked for', async () => {
    const { data, error } = await db
      .from('orders')
      .select('order_number, branch:branches(name), items:order_items(product_name, qty, line_no)')
      .order('order_number')
      .order('line_no', { referencedTable: 'order_items', ascending: true });
    assert.equal(error, null);
    assert.deepEqual(data![0], {
      order_number: 'ORD-1',
      branch: { name: 'Gulberg' },
      items: [
        { product_name: 'Cake', qty: 1.5, line_no: 1 },
        { product_name: 'Bread', qty: 2, line_no: 2 },
      ],
    });
    assert.deepEqual(data![1].items, []);
  });

  test('count, head, and a page past the end', async () => {
    const counted = await db.from('orders').select('id', { count: 'exact' }).order('order_number').range(0, 0);
    assert.equal(counted.count, 3);
    assert.equal(counted.data!.length, 1);
    const head = await db.from('orders').select('*', { count: 'exact', head: true }).eq('branch_id', ids.gulberg);
    assert.deepEqual([head.data, head.count], [null, 2]);
    const lastPlusOne = await db.from('orders').select('id', { count: 'exact' }).range(3, 7);
    assert.deepEqual([lastPlusOne.data, lastPlusOne.error], [[], null]);
    const past = await db.from('orders').select('id', { count: 'exact' }).range(4, 8);
    assert.equal(past.error!.code, 'PGRST103');
    const uncounted = await db.from('orders').select('id').range(40, 49);
    assert.deepEqual(uncounted.data, []);
  });

  test('single and maybeSingle', async () => {
    assert.equal((await db.from('orders').select('id').eq('order_number', 'nope').single()).error!.code, 'PGRST116');
    assert.equal((await db.from('orders').select('id').single()).error!.code, 'PGRST116');
    const maybe = await db.from('orders').select('id').eq('order_number', 'nope').maybeSingle();
    assert.deepEqual([maybe.data, maybe.error], [null, null]);
    assert.equal((await db.from('orders').select('id').maybeSingle()).error!.code, 'PGRST116');
  });

  test('or() follows PostgREST\'s grammar, including where it refuses', async () => {
    const found = await db.from('orders').select('order_number').or(`status.eq.delivered,and(branch_id.eq.${ids.dha},grand_total.gt.50)`).order('order_number');
    assert.deepEqual(found.data!.map((r: { order_number: string }) => r.order_number), ['ORD-1', 'ORD-3']);
    const star = await db.from('orders').select('id').or('order_number.ilike.*d-2,notes.ilike."%a,b%"');
    assert.equal(star.data!.length, 1);
    assert.equal((await db.from('orders').select('id').or('order_number.ilike.%a,b%')).error!.code, 'PGRST100');
  });
});

describe('writing', () => {
  test('a write returns nothing unless asked, and the row when asked', async () => {
    const quiet = await db.from('settings').insert({ theme: 'dark' });
    assert.deepEqual([quiet.data, quiet.error, quiet.count], [null, null, null]);
    const row = await db.from('settings').update({ theme: 'light' }).eq('id', true).select().single();
    assert.deepEqual(row.data, { id: true, theme: 'light', updated_count: 0 });
  });

  test('a single object takes defaults for the keys it lacks; a list takes NULL', async () => {
    const one = await db.from('orders').insert({ order_number: 'ORD-D', business_date: '2026-10-05', notes: undefined }).select('status, grand_total').single();
    assert.deepEqual(one.data, { status: 'pending', grand_total: 0 });
    const list = await db.from('orders').insert([{ order_number: 'ORD-L1', business_date: '2026-10-05', status: 'delivered' }, { order_number: 'ORD-L2', business_date: '2026-10-05' }]);
    assert.equal(list.error!.code, '23502'); // status is NOT NULL and the second row did not give one
  });

  test('upsert updates on its conflict target, or leaves the row alone', async () => {
    const changed = await db.from('settings').upsert({ id: true, theme: 'blue' }, { onConflict: 'id' }).select('theme').single();
    assert.equal(changed.data.theme, 'blue');
    const ignored = await db.from('settings').upsert({ id: true, theme: 'red' }, { onConflict: 'id', ignoreDuplicates: true }).select();
    assert.deepEqual(ignored.data, []);
    assert.equal((await db.from('settings').select('theme').single()).data.theme, 'blue');
  });

  test('single() on a write that matched several rows undoes the write', async () => {
    const refused = await db.from('orders').update({ notes: 'MUST NOT STICK' }).eq('branch_id', ids.gulberg).select().single();
    assert.equal(refused.error!.code, 'PGRST116');
    assert.equal(refused.error!.details, 'The result contains 2 rows');
    const after = await db.from('orders').select('id', { count: 'exact', head: true }).eq('notes', 'MUST NOT STICK');
    assert.equal(after.count, 0);
    assert.equal((await db.from('orders').update({ notes: 'x' }).eq('order_number', 'nope').select().single()).error!.code, 'PGRST116');
  });

  test('maybeSingle() on a write reports several rows but, as supabase-js does, has applied it', async () => {
    const reported = await db.from('orders').update({ notes: 'applied' }).eq('branch_id', ids.gulberg).select().maybeSingle();
    assert.equal(reported.error!.code, 'PGRST116');
    const after = await db.from('orders').select('id', { count: 'exact', head: true }).eq('notes', 'applied');
    assert.equal(after.count, 2);
    const none = await db.from('orders').update({ notes: 'x' }).eq('order_number', 'nope').select().maybeSingle();
    assert.deepEqual([none.data, none.error], [null, null]);
  });

  test('constraint violations keep their SQLSTATE', async () => {
    assert.equal((await db.from('branches').insert({ name: 'DHA' })).error!.code, '23505');
    assert.equal((await db.from('orders').insert({ order_number: 'X', business_date: '2026-10-05', branch_id: '00000000-0000-4000-8000-000000000000' })).error!.code, '23503');
    assert.equal((await db.from('orders').insert({ order_number: 'Y', business_date: '2026-10-05', nope: 1 })).error!.code, 'PGRST204');
  });

  test('delete, with a count', async () => {
    const gone = await db.from('orders').delete({ count: 'exact' }).eq('order_number', 'ORD-D');
    assert.deepEqual([gone.data, gone.count], [null, 1]);
    assert.deepEqual((await db.from('orders').delete().eq('order_number', 'nope').select()).data, []);
  });
});

describe('functions', () => {
  test('the result has the shape of what the function returns', async () => {
    assert.equal((await db.rpc('order_total', { p_order_id: ids.o1 })).data, 1234.5);
    assert.equal((await db.rpc('order_total', { p_order_id: '00000000-0000-4000-8000-000000000000' })).data, null);
    const set = await db.rpc('orders_on', { p_date: '2026-10-02' });
    assert.deepEqual(set.data.map((r: { order_number: string }) => r.order_number), ['ORD-2', 'ORD-3']);
    assert.deepEqual((await db.rpc('orders_on', { p_date: '2026-10-01', p_status: 'delivered' })).data.length, 1);
    assert.deepEqual((await db.rpc('order_numbers', { p_tags: ['a', 'b'] })).data.tags, ['a', 'b']);
    const nothing = await db.rpc('touch_settings');
    assert.deepEqual([nothing.data, nothing.error], [null, null]);
  });

  test('an argument left undefined is not passed, so the default applies', async () => {
    const { data } = await db.rpc('orders_on', { p_date: '2026-10-02', p_status: undefined });
    assert.equal(data.length, 2);
  });

  test('a raise comes back with its code, message and hint untouched', async () => {
    const { data, error } = await db.rpc('refuse', { p_reason: 'stock is short by 3' });
    assert.equal(data, null);
    assert.equal(error!.code, 'MB001');
    assert.equal(error!.message, 'Refused: stock is short by 3');
    assert.equal(error!.hint, 'try later');
  });

  test('a call that names no such function, or no such argument', async () => {
    assert.equal((await db.rpc('nope')).error!.code, 'PGRST202');
    assert.equal((await db.rpc('order_total', { p_nope: 1 })).error!.code, 'PGRST202');
    assert.equal((await db.rpc('order_total', {})).error!.code, 'PGRST202');
  });
});

describe('parsers', () => {
  test('logic tree', () => {
    assert.deepEqual(parseLogic('a.eq.1,b.not.in.(x,"y,z"),not.and(c.is.null,d.ilike.*q*)'), [
      { column: 'a', op: 'eq', negate: false, value: '1' },
      { column: 'b', op: 'in', negate: true, value: ['x', 'y,z'] },
      { join: 'and', negate: true, items: [
        { column: 'c', op: 'is', negate: false, value: 'null' },
        { column: 'd', op: 'ilike', negate: false, value: '*q*' },
      ] },
    ]);
    // An unquoted `)` ends the filter; what follows is dropped, as PostgREST drops it.
    assert.deepEqual(parseLogic('a.ilike.%x)%'), [{ column: 'a', op: 'ilike', negate: false, value: '%x' }]);
    assert.throws(() => parseLogic('a.ilike.%x,y%'), { code: 'PGRST100' });
    assert.throws(() => parseLogic('a.nope.1'), { code: 'PGRST100' });
  });

  test('in / not-in lists', () => {
    assert.deepEqual(inFilter('a', ['x', 'y,z', 'x']), { column: 'a', op: 'in', negate: false, value: ['x', 'y,z'] });
    assert.deepEqual(inFilter('a', ['']), { column: 'a', op: 'in', negate: false, value: [] }); // sent as `in.()`: the empty list
    assert.deepEqual(notFilter('a', 'in', '(1,2)'), { column: 'a', op: 'in', negate: true, value: ['1', '2'] });
    assert.deepEqual(notFilter('a', 'is', null), { column: 'a', op: 'is', negate: true, value: 'null' });
  });

  test('select', () => {
    assert.deepEqual(parseSelect(' *,\n  items:order_items( product_name, qty ) '), [
      { kind: 'star' },
      { kind: 'embed', table: 'order_items', alias: 'items', items: [
        { kind: 'column', name: 'product_name', alias: 'product_name' },
        { kind: 'column', name: 'qty', alias: 'qty' },
      ] },
    ]);
    assert.deepEqual(parseSelect('total:grand_total'), [{ kind: 'column', name: 'grand_total', alias: 'total' }]);
    assert.throws(() => parseSelect('meta->tills'), { code: 'PGRST100' });
    assert.throws(() => parseSelect('items:order_items!inner(id)'), { code: 'PGRST100' });
  });

  test('shadow comparison ignores key order, and list order only when none was asked for', () => {
    const ordered = () => true;
    const unordered = () => false;
    assert.equal(firstDifference([{ a: 1, b: 2 }], [{ b: 2, a: 1 }], ordered, 'data'), null);
    assert.equal(firstDifference([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }], unordered, 'data'), null);
    assert.equal(firstDifference([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }], ordered, 'data'), 'data(order)');
    assert.equal(firstDifference([{ a: 1, items: [{ q: 1 }] }], [{ a: 1, items: [{ q: 2 }] }], ordered, 'data'), 'data[0].items[0].q');
    assert.equal(firstDifference([{ a: 1 }], [{ a: 1 }, { a: 2 }], ordered, 'data'), 'data.length');
    assert.equal(firstDifference({ a: '1' }, { a: 1 }, ordered, 'data'), 'data.a');
  });

  test('rows that tie on the sort may swap; rows that do not may not', () => {
    const live = [{ d: '2026-10-02', n: 1 }, { d: '2026-10-01', n: 2 }, { d: '2026-10-01', n: 3 }];
    const tiesSwapped = [live[0], live[2], live[1]];
    const sortBroken = [live[1], live[0], live[2]];
    assert.equal(onlyTiesReordered(live, tiesSwapped, ['d']), true);
    assert.equal(onlyTiesReordered(live, sortBroken, ['d']), false);
    assert.equal(onlyTiesReordered(live, tiesSwapped, []), false); // no sort was asked for: nothing to tie on
    assert.equal(onlyTiesReordered(live, tiesSwapped, ['missing']), false); // sort column not in the rows: cannot tell
  });
});
