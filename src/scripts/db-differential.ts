import { createClient } from '@supabase/supabase-js';
import { SqlQueryBuilder } from '../db/builder';
import { catalog } from '../db/catalog';
import { disconnectPrisma, prismaExecutor } from '../db/prisma';
import { runRpc } from '../db/rpc';
import type { Db, DbResult } from '../db/types';

/**
 * Differential test: the same calls through PostgREST and through the SQL layer
 * in src/db, against the same database, compared exactly.
 *
 *   pnpm db:diff
 *
 * This is what stands in for a test suite over the 580 table calls and 78
 * function calls being moved: rather than assert what each should return, it
 * asserts that the new path returns what the old one does — data, row count,
 * error code and error message — for every table, every column type, every
 * filter operator, every embedded select and every result shape in use.
 *
 * IT WRITES. Both sides run against a SCRATCH copy of the database with a local
 * PostgREST in front of it, and the script refuses to start against anything
 * that is not on this machine.
 *
 *   DIFF_DATABASE_URL    the scratch database           (postgres://…@127.0.0.1…)
 *   DIFF_POSTGREST_URL   a PostgREST serving that database (http://127.0.0.1:…)
 *   DIFF_POSTGREST_JWT   a service_role token PostgREST accepts
 */

const MAX_ROWS = 1000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tag = 'postgrest' | 'sql';
type Run = (db: Db, tag: Tag) => PromiseLike<DbResult> | Promise<DbResult>;
interface Case {
  name: string;
  run: Run;
  /** Rows may come back in any order (no ORDER BY, or ties). */
  unordered?: boolean;
  /** Each side wrote its own rows; blank out what is bound to differ. */
  volatile?: boolean;
}

const cases: Case[] = [];
const add = (name: string, run: Run, opts: Omit<Case, 'name' | 'run'> = {}) => cases.push({ name, run, ...opts });

function local(url: string, what: string): URL {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    throw new Error(`${what} is ${u.hostname}. This test writes to the database; it only runs against one on this machine.`);
  }
  return u;
}

// ── comparison ──────────────────────────────────────────────────────────────

function canonical(value: unknown, sortArrays: boolean): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v, sortArrays));
    return `[${(sortArrays ? items.sort() : items).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k], sortArrays)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+00:00|Z)/g;

function blank(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(UUID, '<uuid>').replace(STAMP, '<time>').replace(/diff-(postgrest|sql)/g, 'diff-<tag>').replace(/\d{3,}/g, '<n>');
  }
  if (Array.isArray(value)) return value.map(blank);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, blank(v)]));
  }
  return value;
}

function summarise(r: DbResult, c: Case, bodiless: boolean) {
  const view = {
    data: r.data ?? null,
    count: r.count ?? null,
    // A failed count-only request is an HTTP HEAD and PostgREST's answer to it
    // has no body, so there is no code or message to compare — only that both
    // sides failed.
    error: r.error ? (bodiless ? 'failed' : { code: r.error.code ?? '', message: r.error.message }) : null,
  };
  return canonical(c.volatile ? blank(view) : view, c.unordered === true);
}

const isBodiless = (r: DbResult) => !!r.error && !r.error.code && !r.error.message;

// ── the two sides ───────────────────────────────────────────────────────────

function sides(): { postgrest: Db; sql: Db } {
  const dbUrl = local(process.env.DIFF_DATABASE_URL || '', 'DIFF_DATABASE_URL');
  const restUrl = local(process.env.DIFF_POSTGREST_URL || 'http://127.0.0.1:54330', 'DIFF_POSTGREST_URL');
  const jwt = process.env.DIFF_POSTGREST_JWT || '';
  if (!jwt) throw new Error('DIFF_POSTGREST_JWT is required');

  // src/db/prisma.ts connects to DATABASE_URL; point it at the scratch database
  // for this process only.
  process.env.DATABASE_URL = dbUrl.toString();

  // supabase-js expects PostgREST under /rest/v1, as Supabase mounts it.
  const supabase = createClient(restUrl.origin, jwt, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(String(input).replace('/rest/v1', ''), init) },
  });

  return {
    postgrest: supabase as unknown as Db,
    sql: {
      from: (table) => new SqlQueryBuilder(prismaExecutor, table, MAX_ROWS),
      rpc: (fn, args) => runRpc(prismaExecutor, fn, args, MAX_ROWS),
    },
  };
}

// ── the corpus ──────────────────────────────────────────────────────────────

/** Every table and every column: whatever it holds must serialise identically. */
async function tableCases(oracle: Db) {
  for (const [table, info] of Object.entries(catalog().tables)) {
    const ordered = info.pk.length > 0;
    const byKey = (q: any) => info.pk.reduce((acc, col) => acc.order(col), q);

    add(`${table}: every column, first 200 rows`, (db) => byKey(db.from(table).select('*')).limit(200), { unordered: !ordered });
    add(`${table}: count only`, (db) => db.from(table).select('*', { count: 'exact', head: true }));
    add(`${table}: no limit (row cap)`, (db) => byKey(db.from(table).select(info.pk[0] ?? '*', { count: 'exact' })), { unordered: !ordered });

    const { data } = await byKey(oracle.from(table).select('*')).limit(1);
    const sample = (data as Record<string, unknown>[] | null)?.[0];
    if (!sample) continue;

    for (const [column, type] of Object.entries(info.columns)) {
      const value = sample[column];
      const where = `${table}.${column} (${type.replace('public.', '')})`;

      add(`${where}: is null`, (db) => db.from(table).select('*', { count: 'exact', head: true }).is(column, null));
      add(`${where}: not is null`, (db) => db.from(table).select('*', { count: 'exact', head: true }).not(column, 'is', null));
      if (value === null || value === undefined || typeof value === 'object') continue;

      add(`${where}: eq`, (db) => byKey(db.from(table).select('*', { count: 'exact' }).eq(column, value)).limit(5), { unordered: !ordered });
      add(`${where}: neq`, (db) => db.from(table).select('*', { count: 'exact', head: true }).neq(column, value));
      add(`${where}: in`, (db) => db.from(table).select('*', { count: 'exact', head: true }).in(column, [value]));
      add(`${where}: not in`, (db) => db.from(table).select('*', { count: 'exact', head: true }).not(column, 'in', `(${JSON.stringify(String(value))})`));
      if (type !== 'boolean' && type !== 'uuid' && !type.startsWith('public.')) {
        add(`${where}: gte / lt`, (db) => db.from(table).select('*', { count: 'exact', head: true }).gte(column, value).lt(column, value));
        add(`${where}: gt / lte`, (db) => db.from(table).select('*', { count: 'exact', head: true }).gt(column, value).lte(column, value));
      }
      if (type === 'text') {
        const piece = String(value).slice(0, 4);
        add(`${where}: ilike`, (db) => db.from(table).select('*', { count: 'exact', head: true }).ilike(column, `%${piece}%`));
        add(`${where}: or(ilike)`, (db) => db.from(table).select('*', { count: 'exact', head: true }).or(`${column}.ilike.%${piece.replace(/[,()"]/g, '')}%`));
      }
      add(`${where}: order asc`, (db) => byKey(db.from(table).select(column).order(column, { ascending: true })).limit(20), { unordered: !ordered });
      add(`${where}: order desc nulls last`, (db) => byKey(db.from(table).select(column).order(column, { ascending: false, nullsFirst: false })).limit(20), { unordered: !ordered });
    }
  }
}

/** The select strings, filters and result shapes the application actually uses. */
async function handWritten(oracle: Db) {
  const one = async (table: string, column = 'id') => {
    const { data } = await oracle.from(table).select(column).order(column).limit(1);
    return (data as Record<string, any>[] | null)?.[0]?.[column];
  };
  const branchId = await one('branches');
  const orderId = await one('orders');
  const userId = await one('users');

  // Embedded selects — each relationship the code embeds, with the order it asks for.
  const embeds: Array<[string, string, string | null, string | null]> = [
    ['orders', '*, items:order_items(product_id, product_name, category_id, category_name, unit_price, qty, discount, line_total, line_no)', 'order_items', 'line_no'],
    ['orders', 'id, status, grand_total, items:order_items(product_id, product_name, category_name, qty, line_total)', null, null],
    ['production_orders', '*, items:production_order_items(id, product_id, product_name, qty, approved_qty, line_no), packingItems:production_order_packing_items(packing_material_id, material_name, qty, approved_qty)', 'production_order_items', 'line_no'],
    ['production_orders', 'status, items:production_order_items(qty, approved_qty)', null, null],
    ['special_orders', '*, items:special_order_items(id, product_id, item_name, qty, prepared_qty, verified_qty, amount, description, line_no)', 'special_order_items', 'line_no'],
    ['event_branch_demands', '*, items:event_branch_demand_items(id, demand_id, product_id, product_name, qty, approved_qty, prepared_qty, unit_price, remarks, line_no)', 'event_branch_demand_items', 'line_no'],
    ['notification_logs', '*, recipient:notification_recipients(recipient_name, mobile_number)', null, null],
    ['daily_closing_reports', '*, branch:branches(name)', null, null],
    ['return_stock_history', 'id, created_at, product_id, type, delta, balance_after, branch_id, branch:branches(name)', null, null],
  ];
  for (const [table, select, child, childOrder] of embeds) {
    const pk = catalog().tables[table]!.pk[0]!;
    add(`embed ${table}: ${select.slice(0, 60)}…`, (db) => {
      let q: any = db.from(table).select(select, { count: 'exact' }).order(pk).range(0, 39);
      if (child && childOrder) q = q.order(childOrder, { referencedTable: child, ascending: true });
      return q;
    }, { unordered: !child });
  }
  add('embed ordered by its alias', (db) =>
    db.from('orders').select('id, items:order_items(product_name, line_no)').order('id').order('line_no', { referencedTable: 'items', ascending: false }).limit(20));
  add('embed that does not exist', (db) => db.from('orders').select('id, x:branches_nope(name)').limit(1));
  add('embed with no relationship', (db) => db.from('categories').select('id, x:customers(name)').limit(1));

  // .or() strings, as the routes build them.
  const ors = [
    ['customers', 'name.ilike.%a%,phone.ilike.%a%'],
    ['products', 'name.ilike.%br%,sku.ilike.%br%'],
    ['finance_tickets', `status.neq.draft,raised_by.eq.${userId}`],
    ['support_tickets', ['ticket_number.ilike.*a*', 'message.ilike.*a*', 'raised_by_name.ilike.*a*'].join(',')],
    ['orders', 'status.in.(delivered,cancelled),business_date.gte.2026-01-01'],
    ['ledger_entries', 'debit.gte.1000,credit.gte.1000'],
    ['employee_advances', 'recovered_by_salary_id.is.null,recovered_by_salary_id.in.()'],
    ['login_sessions', `auth_session_id.is.null,auth_session_id.neq.${userId}`],
    ['notifications', `target_user_id.eq.${userId},and(target_role.eq.super_admin,or(branch_id.is.null,branch_id.eq.${branchId}))`],
    ['special_events', `applies_to_all_branches.eq.true,id.in.(${userId},${branchId})`],
    ['products', 'name.ilike."%a,b%",sku.eq."x.y"'],
    ['products', 'not.and(is_active.is.true,name.ilike.%a%),sku.not.is.null'],
    ['products', 'name.ilike.%a,b%'],
    ['products', 'name.ilike.%a)%'],
    ['products', 'name.ilike.%(a%'],
    ['products', 'name.nope.1'],
    ['products', 'nope.eq.1'],
  ];
  for (const [table, filter] of ors) {
    if (!catalog().tables[table!]) continue;
    add(`or ${table}: ${filter}`, (db) => db.from(table!).select('*', { count: 'exact', head: true }).or(filter!));
  }
  add('or combined with and-filters', (db) =>
    db.from('orders').select('id', { count: 'exact' }).eq('branch_id', branchId).or('status.eq.delivered,status.eq.cancelled').order('id').limit(10));

  // Paging and counting.
  add('range inside', (db) => db.from('stock_history').select('id', { count: 'exact' }).order('id').range(10, 19));
  add('range past the cap', (db) => db.from('stock_history').select('id', { count: 'exact' }).order('id').range(0, 4999));
  add('limit past the cap', (db) => db.from('stock_history').select('id').order('id').limit(5000));
  add('range starting at the last row + 1', async (db) => {
    const { count } = await db.from('branches').select('*', { count: 'exact', head: true });
    return db.from('branches').select('id', { count: 'exact' }).order('id').range(count!, count! + 4);
  });
  add('range past the end with a count (PGRST103)', (db) => db.from('branches').select('id', { count: 'exact' }).order('id').range(9000, 9004));
  add('range past the end without a count', (db) => db.from('branches').select('id').order('id').range(9000, 9004));
  add('range past the end of an empty set', (db) => db.from('branches').select('id', { count: 'exact' }).eq('name', '__none__').range(5, 9));
  add('limit 0', (db) => db.from('branches').select('id').limit(0));
  add('head without count', (db) => db.from('branches').select('id', { head: true }));
  add('column alias', (db) => db.from('branches').select('id, label:name').order('id').limit(3));
  add('multi-line select', (db) => db.from('branches').select(`\n      id,\n      name\n    `).order('id').limit(3));

  // One row, or none.
  add('single: one row', (db) => db.from('orders').select('*').eq('id', orderId).single());
  add('single: no row', (db) => db.from('orders').select('*').eq('order_number', '__none__').single());
  add('single: many rows', (db) => db.from('orders').select('id').single());
  add('maybeSingle: one row', (db) => db.from('orders').select('*').eq('id', orderId).maybeSingle());
  add('maybeSingle: no row', (db) => db.from('orders').select('*').eq('order_number', '__none__').maybeSingle());
  add('maybeSingle: with limit 1', (db) => db.from('orders').select('id').order('id').limit(1).maybeSingle());

  // Errors Postgres raises for the caller's input.
  add('unknown table', (db) => db.from('nope_table').select('*').limit(1));
  add('unknown column in filter', (db) => db.from('branches').select('id').eq('nope', 1));
  add('unknown column in select', (db) => db.from('branches').select('id, nope'));
  add('unknown column in order', (db) => db.from('branches').select('id').order('nope'));
  add('value of the wrong type (uuid)', (db) => db.from('branches').select('id').eq('id', 'abc'));
  add('value of the wrong type (enum)', (db) => db.from('users').select('id').eq('role', 'nope'));
  add('value of the wrong type (date)', (db) => db.from('orders').select('id').gte('business_date', 'yesterday-ish'));
  add('ilike on a non-text column', (db) => db.from('orders').select('id').ilike('branch_id', '%a%'));
  add('empty in()', (db) => db.from('branches').select('id', { count: 'exact' }).in('id', []));
  add('eq with a comma and a quote in the value', (db) => db.from('branches').select('id', { count: 'exact' }).eq('name', 'a,b "c" (d)'));
  add('in with awkward values', (db) => db.from('branches').select('id', { count: 'exact' }).in('name', ['a,b', 'c "d"', 'e(f)', 'Production']));

  // Functions that only read.
  const reads: Array<[string, Record<string, unknown>]> = [
    ['backup_database_info', {}],
    ['production_stock_availability', {}],
    ['list_public_base_tables', {}],
    ['finance_ticket_stats', {}],
    ['finance_ticket_stats', { p_raised_by: userId }],
    ['finance_day_summary', { p_business_date: '2026-10-01' }],
    ['daily_sale_figures', { p_from: '2026-09-01', p_to: '2026-10-08', p_branch_id: branchId }],
    ['finance_ledger_totals', {}],
    ['finance_ledger_totals', { p_from: '2026-09-01', p_to: '2026-10-08', p_type: 'income', p_min_amount: 10.5, p_search: undefined }],
    ['finance_monthly_dashboard', { p_from: '2026-09-01', p_to: '2026-09-30', p_include_heads: true }],
    ['finance_dashboard_records', { p_metric: 'income', p_from: '2026-09-01', p_to: '2026-09-30', p_limit: 5, p_offset: 0 }],
    ['production_dashboard_series', { p_month_from: '2026-09-01', p_today: '2026-10-08' }],
    ['production_dashboard_week', { p_from: '2026-10-01', p_to: '2026-10-07', p_prev_from: '2026-09-24', p_prev_to: '2026-09-30', p_branch_id: null }],
    ['production_demand_overview', { p_demand_from: '2026-09-01', p_day_from: '2026-10-01', p_last7: '2026-10-01' }],
    ['sales_analytics', { p_from: '2026-09-01', p_to: '2026-09-30', p_branch_id: branchId, p_top_limit: 5, p_prev_from: '2026-08-01', p_prev_to: '2026-08-31', p_today: '2026-10-08' }],
    ['data_engine_aggregate', { p_table: 'orders', p_where: { and: [{ column: 'status', op: 'eq', value: 'delivered' }] }, p_metrics: [{ key: 'n', fn: 'count' }, { key: 'total', fn: 'sum', column: 'grand_total' }], p_group_by: ['branch_id'] }],
    ['data_engine_aggregate', { p_table: 'orders', p_where: { and: [] }, p_metrics: [{ key: 'n', fn: 'count' }] }],
    ['production_outstanding_demand', { p_product_id: await one('products') }],
    // …and the ways a call can be wrong.
    ['nope_function', { x: 1 }],
    ['finance_day_summary', {}],
    ['finance_day_summary', { p_business_date: '2026-10-01', p_extra: 1 }],
    ['finance_day_summary', { p_business_date: 'not-a-date' }],
    ['production_outstanding_demand', { p_product_id: 'abc' }],
  ];
  for (const [fn, args] of reads) {
    add(`rpc ${fn}(${Object.keys(args).join(', ')})`, (db) => db.rpc(fn, args), { unordered: true });
  }
}

/**
 * Writes. Each side inserts, changes and deletes rows of its own (tagged with
 * the side's name), so both can run against the one database, and the results
 * are compared with ids, timestamps and the tag blanked out.
 */
async function writes(oracle: Db) {
  const branchId = ((await oracle.from('branches').select('id').order('id').limit(1)).data as any[])[0].id;
  const historyId = ((await oracle.from('stock_history').select('id').order('id').limit(1)).data as any[])[0].id;
  const productId = ((await oracle.from('products').select('id').order('id').limit(1)).data as any[])[0].id;
  const w = (name: string, run: Run) => add(`write: ${name}`, run, { volatile: true, unordered: true });
  const n = (tag: Tag, s = '') => `diff-${tag}${s}`;

  w('insert one, return it', (db, t) => db.from('customers').insert({ name: n(t), phone: '0300', email: undefined, branch_id: branchId }).select().single());
  w('insert one, return nothing', (db, t) => db.from('customers').insert({ name: n(t, '-quiet') }));
  w('insert one, return chosen columns', (db, t) => db.from('customers').insert({ name: n(t, '-cols'), total_spent: 12.5 }).select('name, total_spent, total_orders').single());
  w('insert a list with uneven keys', (db, t) =>
    db.from('customers').insert([{ name: n(t, '-l1'), phone: '1' }, { name: n(t, '-l2'), email: 'e@x' }]).select('name, phone, email, total_orders').order('name'));
  w('insert a list, count', (db, t) => db.from('customers').insert([{ name: n(t, '-c1') }, { name: n(t, '-c2') }], { count: 'exact' }));
  w('insert an empty list', (db) => db.from('customers').insert([]).select());
  w('insert an unknown column', (db, t) => db.from('customers').insert({ name: n(t), nope: 1 }).select());
  w('insert without a required column', (db) => db.from('customers').insert({ phone: '1' }).select());
  w('insert a foreign key to nothing', (db, t) => db.from('customers').insert({ name: n(t, '-fk'), branch_id: '00000000-0000-4000-8000-000000000000' }).select());
  w('insert a value of the wrong type', (db, t) => db.from('customers').insert({ name: n(t, '-bad'), total_orders: 'many' }).select());
  w('insert with embedded select', (db, t) => db.from('customers').insert({ name: n(t, '-emb'), branch_id: branchId }).select('name, branch:branches(name)').single());

  w('upsert: new row', (db, t) =>
    db.from('categories').upsert({ name: n(t), slug: n(t, '-slug'), sort_order: 900 }, { onConflict: 'slug' }).select('name, slug, sort_order, is_active'));
  w('upsert: same key again', (db, t) =>
    db.from('categories').upsert({ name: n(t, ' renamed'), slug: n(t, '-slug'), sort_order: 901 }, { onConflict: 'slug' }).select('name, slug, sort_order, is_active'));
  w('upsert: ignore duplicates', (db, t) =>
    db.from('categories').upsert({ name: n(t, ' ignored'), slug: n(t, '-slug') }, { onConflict: 'slug', ignoreDuplicates: true }).select('name, slug'));
  w('duplicate unique value', (db, t) => db.from('categories').insert({ name: n(t), slug: n(t, '-slug') }).select());

  w('update one, return it', (db, t) => db.from('customers').update({ phone: '0311', address: 'x' }).eq('name', n(t)).select().single());
  w('update one, return nothing', (db, t) => db.from('customers').update({ phone: '0312' }).eq('name', n(t)));
  w('update, count', (db, t) => db.from('customers').update({ phone: '0313' }, { count: 'exact' }).ilike('name', `${n(t)}-l%`));
  w('update none, single', (db) => db.from('customers').update({ phone: '0' }).eq('name', '__none__').select().single());
  w('update none, maybeSingle', (db) => db.from('customers').update({ phone: '0' }).eq('name', '__none__').select().maybeSingle());
  w('update none, list', (db) => db.from('customers').update({ phone: '0' }).eq('name', '__none__').select());
  w('update many, single (refused)', (db, t) => db.from('customers').update({ address: 'MUST NOT STICK' }).ilike('name', `${n(t)}-l%`).select().single());
  w('…and nothing was changed by it', (db, t) => db.from('customers').select('name, address').ilike('name', `${n(t)}-l%`).order('name'));
  w('update many, maybeSingle (reported, but applied)', (db, t) => db.from('customers').update({ address: 'applied' }).ilike('name', `${n(t)}-l%`).select().maybeSingle());
  w('…and it was applied', (db, t) => db.from('customers').select('name, address').ilike('name', `${n(t)}-l%`).order('name'));
  w('update with nothing to set', (db, t) => db.from('customers').update({}).eq('name', n(t)).select());
  w('update an unknown column', (db, t) => db.from('customers').update({ nope: 1 }).eq('name', n(t)).select());
  w('update to null and to a number', (db, t) => db.from('customers').update({ phone: null, total_spent: 99.99 }).eq('name', n(t)).select('phone, total_spent').single());
  w('update refused by a trigger', (db) => db.from('stock_history').update({ ref_id: 'changed' }).eq('id', historyId).select());

  w('function: void', async (db, t) => {
    const { data } = await db.from('customers').select('id').eq('name', n(t)).single();
    return db.rpc('increment_customer_stats', { p_customer_id: (data as any).id, p_amount: 150.25 });
  });
  w('…and what it did', (db, t) => db.from('customers').select('total_orders, total_spent').eq('name', n(t)).single());
  w('function: text', (db) => db.rpc('next_ticket_number'));
  w('function: jsonb, then void', async (db, t) => {
    const args = { p_user_id: '00000000-0000-4000-8000-000000000001', p_key: n(t, '-key') };
    const claim = await db.rpc('claim_idempotency_key', { ...args, p_endpoint: 'POST /diff', p_fingerprint: 'f' });
    const done = await db.rpc('complete_idempotency_key', { ...args, p_status: 201, p_body: { ok: true, n: [1, 2] } });
    const again = await db.rpc('claim_idempotency_key', { ...args, p_endpoint: 'POST /diff', p_fingerprint: 'f' });
    const release = await db.rpc('release_idempotency_key', args);
    return { data: [claim.data, done.data, again.data, release.data, claim.error, done.error, again.error, release.error], error: null, count: null, status: 200, statusText: 'OK' };
  });
  w('function: raises', (db) =>
    db.rpc('apply_stock_movement', { p_branch_id: branchId, p_product_id: productId, p_product_name: 'diff', p_delta: -99999999, p_type: 'sale', p_ref_id: 'diff', p_business_date: '2026-10-08' }));
  w('function: raises on its payload', (db) => db.rpc('commit_sale', { p_order: {}, p_items: [], p_branch_id: branchId, p_business_date: '2026-10-08' }));

  w('delete one, return it', (db, t) => db.from('customers').delete().eq('name', n(t, '-quiet')).select('name'));
  w('delete, count', (db, t) => db.from('customers').delete({ count: 'exact' }).ilike('name', `${n(t)}%`));
  w('delete none', (db) => db.from('customers').delete().eq('name', '__none__').select());
  w('delete a category', (db, t) => db.from('categories').delete().eq('slug', n(t, '-slug')).select('slug').single());
  w('nothing left behind', (db) => db.from('customers').select('*', { count: 'exact', head: true }).ilike('name', 'diff-%'));
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  const { postgrest, sql } = sides();
  await tableCases(postgrest);
  await handWritten(postgrest);
  await writes(postgrest);

  const only = process.argv[2];
  const selected = only ? cases.filter((c) => c.name.includes(only)) : cases;
  let failed = 0;

  for (const c of selected) {
    let a: string;
    let b: string;
    let bodiless = false;
    try {
      const live = await c.run(postgrest, 'postgrest');
      bodiless = isBodiless(live);
      a = summarise(live, c, bodiless);
    } catch (e) {
      a = `THREW ${(e as Error).message}`;
    }
    try {
      b = summarise(await c.run(sql, 'sql'), c, bodiless);
    } catch (e) {
      b = `THREW ${(e as Error).message}`;
    }
    if (a === b) continue;
    failed++;
    if (failed <= 40) {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      const from = Math.max(0, i - 80);
      console.log(`\n✗ ${c.name}\n  postgrest: …${a.slice(from, i + 220)}\n  sql:       …${b.slice(from, i + 220)}`);
    }
  }

  await disconnectPrisma();
  console.log(`\n${selected.length - failed} of ${selected.length} calls identical${failed ? `, ${failed} DIFFERENT` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[db:diff]', err instanceof Error ? err.message : err);
  await disconnectPrisma();
  process.exit(1);
});
