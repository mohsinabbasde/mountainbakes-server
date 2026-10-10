// Tests for migrations 133/135 — the ledger's edit and delete rules:
//
//   EDIT   = change the same entry. Same PV-/RV- number, no reversal, no new voucher.
//   DELETE = delete the entry. No reversal, no new voucher.
//   NEW    = the only operation that draws a new PV-/RV- number.
//
// There is no local Postgres here, so the real function bodies are taken from
// the migration files and run in pglite over minimal stub tables shaped like
// production (ledger_entries with its immutability trigger).
//
//   cd backend && node --test db/history/tests/ledger-edit-delete-in-place.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const M = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations') + '/';
const read = (f) => fs.readFileSync(M + f, 'utf8');
// Pull one `create or replace function <name>(` … `  $$;` block out of a file.
function fn(file, name) {
  const s = read(file);
  const i = s.indexOf(`create or replace function ${name}(`);
  if (i < 0) throw new Error(`${name} not in ${file}`);
  const j = s.indexOf('\n  $$;', i);
  return s.slice(i, j + 6) + '\n';
}

const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema app;
create type finance_account as enum ('cash','bank');
create type ledger_head_type as enum ('income','expense');
create type ledger_entry_status as enum ('posted','reversed','locked');
create type finance_ledger_source as enum ('manual','adjustment','cash_transfer');
create table users (id uuid primary key default gen_random_uuid());
create table branches (id uuid primary key default gen_random_uuid(), name text not null);
create table counters (id text primary key, count bigint not null);
insert into counters values ('finance_receipt_voucher',0),('finance_payment_voucher',124);
create function app.next_finance_number(p_key text, p_prefix text) returns text language plpgsql as $$
declare n bigint; begin update counters set count = count + 1 where id = p_key returning count into n; return p_prefix || '-' || lpad(n::text, 6, '0'); end $$;
create table finance_day_closings (business_date date primary key);
create table ledger_heads (id uuid primary key default gen_random_uuid(), code text unique, name text, type ledger_head_type, is_active boolean not null default true);
create table cash_transfers (id uuid primary key default gen_random_uuid(), transfer_no text, branch_id uuid, branch_name text, created_by uuid, created_by_name text);
create table ledger_entries (
  id uuid primary key default gen_random_uuid(), voucher_no text not null unique, seq bigserial not null unique,
  entry_date date not null, ledger_head_id uuid references ledger_heads(id), ledger_head_name text not null,
  ledger_head_type ledger_head_type not null, branch_id uuid, branch_name text, description text not null,
  debit numeric(14,2) not null default 0, credit numeric(14,2) not null default 0, balance numeric(14,2) not null,
  account finance_account not null, payment_method text, status ledger_entry_status not null default 'posted',
  source_type finance_ledger_source not null, source_id uuid,
  reverses_entry_id uuid references ledger_entries(id) on delete restrict,
  reversed_by_entry_id uuid references ledger_entries(id) on delete restrict,
  approved_by uuid, approved_by_name text, created_by uuid, created_by_name text, posted_at timestamptz default now(),
  deleted_at timestamptz, deleted_by uuid, deleted_by_name text, delete_reason text, deleted_query_id uuid, deleted_query_no text,
  constraint ledger_entry_one_sided check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)));
`);
const m94 = '20260901000094_finance_help_desk_admin.sql';
await db.exec(fn(m94, 'post_finance_ledger_entry'));
await db.exec(fn(m94, 'recompute_finance_ledger_balances'));
await db.exec(fn(m94, 'app.finance_ledger_immutable'));
await db.exec(`create trigger ledger_entries_immutable before update or delete on ledger_entries for each row execute function app.finance_ledger_immutable();`);
await db.exec(read('20261002000133_finance_corrections_in_place.sql'));
await db.exec(read('20261002000135_ledger_edit_delete_in_place.sql'));

const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const TODAY = '2026-10-02';
const [dha] = await q(`insert into branches(name) values ('DHA Branch') returning id`);
const [nn] = await q(`insert into branches(name) values ('North Nazimabad Branch') returning id`);
const [admin] = await q(`insert into users default values returning id`);
const [rent] = await q(`insert into ledger_heads(code,name,type) values ('EXP-RENT','Rent','expense') returning id`);
const [fuel] = await q(`insert into ledger_heads(code,name,type) values ('EXP-FUEL','Fuel','expense') returning id`);
const [sales] = await q(`insert into ledger_heads(code,name,type) values ('INC-SALES','Sales','income') returning id`);

/** A new entry — the only thing that draws a voucher number. Credit = PV, debit = RV. */
const post = (date, head, debit, credit, branch = dha.id, branchName = 'DHA Branch') =>
  one(`select * from post_finance_ledger_entry($1, $2, 'Entry', $3, $4, 'cash', 'manual', null, $5, $6, 'cash')`, [date, head, debit, credit, branch, branchName]);
const edit = (id, set, expected = {}) =>
  one(`select * from edit_finance_ledger_entry($1, $2::jsonb, $3::jsonb, $4, 'admin@test', $5)`, [id, JSON.stringify(set), JSON.stringify(expected), admin.id, TODAY]);
const remove = (id, reason = 'entered by mistake') =>
  one(`select * from reverse_finance_ledger_entry($1, $2, $3, $4, 'admin@test', null, null)`, [id, TODAY, reason, admin.id]);
const entry = (id) => one(`select *, to_char(entry_date, 'YYYY-MM-DD') as d from ledger_entries where id = $1`, [id]);
const liveCount = async () => (await one(`select count(*)::int c from ledger_entries where deleted_at is null`)).c;
const totalCount = async () => (await one(`select count(*)::int c from ledger_entries`)).c;
const counters = async () => (await one(`select string_agg(id || '=' || count, ',' order by id) c from counters`)).c;
const reversals = async () => (await one(`select count(*)::int c from ledger_entries where reverses_entry_id is not null or status = 'reversed'`)).c;
/** Every live row's stored balance equals the running sum in posting order. */
const chainOk = async () => (await one(`select coalesce(bool_and(balance = run), true) ok from (select balance, sum(debit - credit) over (order by seq) run from ledger_entries where deleted_at is null) t`)).ok;
const branchTotal = async (name, date) =>
  Number((await one(`select coalesce(sum(credit), 0) s from ledger_entries where deleted_at is null and branch_name = $1 and ($2::date is null or entry_date = $2::date)`, [name, date ?? null])).s);

// A book with something before and after the entry under test, so balance
// recomputation has rows to get wrong.
await post('2026-09-30', sales.id, 20000, 0);
const pv = await post('2026-10-01', rent.id, 0, 5000);          // PV-000125, DHA, a credit
await post('2026-10-01', sales.id, 3000, 0);

test('the entry under test is PV-000125', () => {
  assert.equal(pv.voucher_no, 'PV-000125');
});

test('1 — amount: 5000 → 7500 on the same voucher', async () => {
  const rows = await totalCount(), numbers = await counters();
  const after = await edit(pv.id, { amount: '7500' }, { amount: '5000' });
  assert.equal(after.voucher_no, 'PV-000125');
  assert.equal(Number(after.credit), 7500);
  assert.equal(await totalCount(), rows, 'no row was added');
  assert.equal(await counters(), numbers, 'no voucher number was drawn');
  assert.equal(await reversals(), 0);
  assert.ok(await chainOk(), 'running balances were recomputed');
  assert.equal(Number((await one(`select balance from ledger_entries where deleted_at is null order by seq desc limit 1`)).balance), 20000 - 7500 + 3000);
});

test('2 — date: the voucher moves to the new day, and is on no other', async () => {
  const after = await edit(pv.id, { entryDate: '2026-10-02' }, { entryDate: '2026-10-01' });
  assert.equal(after.voucher_no, 'PV-000125');
  assert.equal((await entry(pv.id)).d, '2026-10-02');
  assert.equal(await branchTotal('DHA Branch', '2026-10-01'), 0, 'the old date no longer carries it');
  assert.equal(await branchTotal('DHA Branch', '2026-10-02'), 7500);
  assert.equal(await reversals(), 0);
});

test('3 — branch: the voucher leaves DHA and lands on North Nazimabad', async () => {
  const rows = await totalCount();
  const after = await edit(pv.id, { branchId: nn.id }, { branchId: dha.id });
  assert.equal(after.voucher_no, 'PV-000125');
  assert.equal(after.branch_name, 'North Nazimabad Branch');
  assert.equal(await branchTotal('DHA Branch'), 0);
  assert.equal(await branchTotal('North Nazimabad Branch'), 7500);
  assert.equal(await totalCount(), rows);
});

test('4 — a credit stays a credit', async () => {
  const after = await edit(pv.id, { amount: '7000' }, { amount: '7500' });
  assert.equal(Number(after.credit), 7000);
  assert.equal(Number(after.debit), 0);
  assert.equal(after.voucher_no, 'PV-000125');
  assert.equal((await one(`select count(*)::int c from ledger_entries where voucher_no like 'PV-%'`)).c, 1, 'no second credit entry');
});

test('5 — amount, date, branch, category and description in one edit', async () => {
  const rows = await totalCount(), numbers = await counters();
  await edit(pv.id,
    { amount: '6000', entryDate: '2026-10-01', branchId: dha.id, ledgerHeadId: fuel.id, description: 'Van fuel', account: 'bank', paymentMethod: 'bank_transfer' },
    { amount: '7000', entryDate: '2026-10-02', branchId: nn.id });
  const e = await entry(pv.id);
  assert.deepEqual(
    [e.voucher_no, Number(e.credit), e.d, e.branch_name, e.ledger_head_name, e.description, e.account, e.payment_method],
    ['PV-000125', 6000, '2026-10-01', 'DHA Branch', 'Fuel', 'Van fuel', 'bank', 'bank_transfer']);
  assert.equal(await totalCount(), rows);
  assert.equal(await counters(), numbers);
  assert.ok(await chainOk());
});

test('the edit is stamped with who and when', async () => {
  const e = await entry(pv.id);
  assert.equal(e.updated_by, admin.id);
  assert.equal(e.updated_by_name, 'admin@test');
  assert.ok(e.updated_at);
});

test('7 — a retried save does not apply twice or add a row', async () => {
  const rows = await totalCount();
  // The first save moved 6000 → 6500; the retry still says "it was 6000".
  await edit(pv.id, { amount: '6500' }, { amount: '6000' });
  await assert.rejects(edit(pv.id, { amount: '6500' }, { amount: '6000' }), /changed by another user/);
  assert.equal(Number((await entry(pv.id)).credit), 6500);
  assert.equal(await totalCount(), rows);
});

test('concurrency — a stale form is refused and nothing is written', async () => {
  await assert.rejects(edit(pv.id, { description: 'Mine' }, { description: 'What I saw an hour ago' }), /changed by another user/);
  assert.equal((await entry(pv.id)).description, 'Van fuel');
});

test('refused: a voucher number cannot be sent, the side cannot flip, the day cannot be closed', async () => {
  await assert.rejects(edit(pv.id, { amount: '1' }, { voucherNo: 'PV-999999' }), /cannot be edited/);
  await assert.rejects(edit(pv.id, { ledgerHeadId: sales.id }), /income category/);
  await assert.rejects(edit(pv.id, { amount: '0' }), /greater than 0/);
  await assert.rejects(edit(pv.id, { entryDate: '2026-10-09' }), /future/);
  await db.exec(`insert into finance_day_closings values ('2026-09-29')`);
  await assert.rejects(edit(pv.id, { entryDate: '2026-09-29' }), /closed/);
  const e = await entry(pv.id);
  assert.deepEqual([e.voucher_no, Number(e.credit), e.d], ['PV-000125', 6500, '2026-10-01'], 'every refusal left the voucher as it was');
});

test('a new entry is the only thing that draws a number', async () => {
  const next = await post('2026-10-02', rent.id, 0, 100);
  assert.equal(next.voucher_no, 'PV-000126', 'the edits above consumed no PV numbers');
});

test('6 — delete removes the voucher: no reversal, no new voucher', async () => {
  const rows = await totalCount(), numbers = await counters(), live = await liveCount();
  const gone = await remove(pv.id);
  assert.equal(gone.voucher_no, 'PV-000125');
  assert.ok(gone.deleted_at);
  assert.equal(gone.delete_reason, 'entered by mistake');
  assert.equal(await liveCount(), live - 1);
  assert.equal(await totalCount(), rows, 'nothing was posted to cancel it');
  assert.equal(await counters(), numbers);
  assert.equal(await reversals(), 0);
  assert.ok(await chainOk(), 'balances close over the gap');
  await assert.rejects(remove(pv.id), /already been deleted/, 'a second delete finds nothing to delete');
  await assert.rejects(edit(pv.id, { amount: '1' }), /already been deleted/);
});
