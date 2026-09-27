// Regression tests for migrations 125/126 — deleting a Cash Deposit removes it
// and its ledger entries and posts NO reversal.
//
// There is no local Postgres here, so the real function bodies are taken from
// the migration files and run in pglite over minimal stub tables shaped like
// production (ledger_entries with its immutability trigger, cash_transfers).
//
//   cd backend && node --test supabase/tests/cash-deposit-delete.test.mjs
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

const ok = (cond, msg) => assert.ok(cond, msg);

const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema app;
create type finance_account as enum ('cash','bank');
create type ledger_head_type as enum ('income','expense');
create type ledger_entry_status as enum ('posted','reversed','locked');
create type finance_ledger_source as enum ('manual','adjustment','cash_transfer');
create table users (id uuid primary key default gen_random_uuid());
create table counters (id text primary key, count bigint not null);
insert into counters values ('finance_receipt_voucher',0),('finance_payment_voucher',0);
create table finance_day_closings (business_date date primary key);
create table ledger_heads (id uuid primary key default gen_random_uuid(), code text unique, name text, type ledger_head_type,
  description text, group_name text, is_system boolean, sort_order int, is_active boolean not null default true);
insert into ledger_heads (code,name,type) values ('INC-BRANCH-CASH','Cash Received from Branch','income'),('INC-COMPANY-SHARE','Company Share','income'),('EXP-RENT','Rent','expense');
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
create unique index ledger_entries_one_reversal_idx on ledger_entries (reverses_entry_id) where reverses_entry_id is not null;
create table cash_transfers (
  id uuid primary key default gen_random_uuid(), transfer_no text unique not null, branch_id uuid not null, branch_name text,
  amount numeric(14,2) not null, payment_method text not null, status text not null default 'pending',
  business_date date not null default current_date, note text, created_by uuid, created_by_name text,
  approved_by uuid, approved_by_name text, approved_at timestamptz, approval_note text,
  ledger_entry_id uuid references ledger_entries(id) on delete restrict, voucher_no text,
  deleted_at timestamptz, deleted_by uuid, deleted_by_name text, delete_reason text, deleted_query_id uuid, deleted_query_no text);
`);
await db.exec(
  fn('20260805000052_finance_ledger.sql', 'app.next_finance_number') +
  fn('20260908000107_ledger_heads_hide_system_and_revise.sql', 'post_finance_ledger_entry') +
  fn('20260805000052_finance_ledger.sql', 'reverse_finance_ledger_entry') +
  fn('20260901000094_finance_help_desk_admin.sql', 'app.finance_ledger_immutable') +
  fn('20260901000094_finance_help_desk_admin.sql', 'recompute_finance_ledger_balances') +
  `create trigger ledger_entries_immutable before update or delete on ledger_entries
     for each row execute function app.finance_ledger_immutable();`
);
// The deposit migrations as they shipped, in order (121 alters cash_transfers to channels).
await db.exec(read('20260926000121_cash_deposit_channels.sql'));
await db.exec(read('20260926000123_cash_deposit_single_entry.sql'));

const B = 'aaaaaaaa-0000-0000-0000-000000000001';
let n = 0;
async function deposit(amount, { cash = amount, bank = 0, fuel = 0 } = {}) {
  const no = 'CT-' + String(++n).padStart(6, '0');
  const r = await db.query(
    `insert into cash_transfers (transfer_no, branch_id, branch_name, amount, cash_amount, bank_amount, fuel_charges)
     values ($1,$2,'Main',$3,$4,$5,$6) returning id`, [no, B, cash + bank, cash, bank, fuel]);
  const id = r.rows[0].id;
  await db.query(`select approve_cash_transfer($1, null, 'finance', current_date, null)`, [id]);
  return { id, no };
}
const del = async (id, q = 'Q-1') =>
  (await db.query(`select soft_delete_finance_record('cash_transfer',$1,'wrong entry',null,'admin',null,$2) r`, [id, q])).rows[0].r;
const liveLedger = async () => (await db.query(`select voucher_no, debit::float d, credit::float c, balance::float b, source_type, source_id, reverses_entry_id, description from ledger_entries where deleted_at is null order by seq`)).rows;
const allLedger = async () => (await db.query(`select * from ledger_entries order by seq`)).rows;
const closing = async () => { const l = await liveLedger(); return l.length ? l[l.length - 1].b : 0; };
const sum = async () => (await db.query(`select coalesce(sum(debit-credit),0)::float s from ledger_entries where deleted_at is null`)).rows[0].s;
const liveDeposit = async (id) => (await db.query(`select count(*)::int c from cash_transfers where id=$1 and deleted_at is null`, [id])).rows[0].c;
const liveChain = async (id) => (await db.query(`select count(*)::int c from ledger_entries where id in (select app.cash_transfer_ledger_chain($1)) and deleted_at is null`, [id])).rows[0].c;

// ── Old behaviour, for the cleanup test: deletes under 121/123 post a reversal.
let old1, oldKeep;
test('Pre-125 behaviour posts a reversal on delete (bug reproduced)', async () => {
  await db.query(`select post_finance_ledger_entry(current_date,(select id from ledger_heads where code='EXP-RENT'),'Rent',0,3000,'cash','manual')`);
  old1 = await deposit(7000);
  oldKeep = await deposit(2000);
  await del(old1.id, 'Q-OLD');
  const oldRev = (await liveLedger()).filter((e) => e.description.startsWith('Reversal of'));
  ok(oldRev.length === 1 && oldRev[0].c === 7000, 'old delete posted a 7000 Credit reversal (the bug reproduced)');
  // A legitimate manual reversal elsewhere, which cleanup must leave alone.
  const manual2 = (await db.query(`select (post_finance_ledger_entry(current_date,(select id from ledger_heads where code='EXP-RENT'),'Rent 2',0,500,'cash','manual')).id id`)).rows[0].id;
  await db.query(`select reverse_finance_ledger_entry($1, current_date, 'typo', null, 'admin')`, [manual2]);
});

test('Migration 125 applies and drops the reversal helper', async () => {
  await db.exec(read('20260927000125_cash_deposit_delete_no_reversal.sql'));
  const fnGone = (await db.query(`select count(*)::int c from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='app' and proname='reverse_cash_transfer_entries'`)).rows[0].c;
  ok(fnGone === 0, 'app.reverse_cash_transfer_entries is dropped');
});

test('Migration 126 removes only the faulty delete reversals', async () => {
  const beforeCleanup = await sum();
  const countBefore = (await allLedger()).length;
  await db.exec(read('20260927000126_cleanup_cash_deposit_delete_reversals.sql'));
  ok((await liveChain(old1.id)) === 0, 'deleted deposit CT old: original + faulty reversal removed from the ledger');
  ok((await liveChain(oldKeep.id)) === 1, 'live deposit untouched');
  ok((await liveLedger()).filter((e) => e.description.startsWith('Reversal of') && e.description.includes('typo')).length === 1, 'legitimate manual reversal untouched');
  ok((await sum()) === beforeCleanup, 'closing balance unchanged by cleanup (pair netted to zero)');
  ok((await allLedger()).length === countBefore, 'cleanup inserted nothing and hard-deleted nothing');
  await db.exec(read('20260927000126_cleanup_cash_deposit_delete_reversals.sql'));
  ok((await liveChain(oldKeep.id)) === 1, 'cleanup is idempotent');
});

// ── Test 1: delete one income deposit.
test('Test 1 — delete an Income cash deposit', async () => {
  const d1 = await deposit(10000);
  ok((await liveDeposit(d1.id)) === 1 && (await liveChain(d1.id)) === 1, 'deposit and its RV- entry exist');
  const count1 = (await allLedger()).length;
  const bal1 = await sum();
  const r1 = await del(d1.id);
  ok(r1.deleted === true && r1.ledgerRemoved?.startsWith('RV-'), `delete returns deleted + removed voucher (${r1.ledgerRemoved})`);
  ok((await liveDeposit(d1.id)) === 0, 'deposit gone');
  ok((await liveChain(d1.id)) === 0, 'its ledger entry gone');
  ok((await allLedger()).length === count1, 'no ledger row inserted (no reversal / credit / debit)');
  ok((await liveLedger()).every((e) => !e.description.includes(d1.no)), 'no reversal mentioning the deposit');
  ok((await sum()) === bal1 - 10000, 'balance drops by exactly the deposit');
});

// ── Test 2: delete the middle of three.
let Bd;
test('Test 2 — delete Deposit B of A/B/C', async () => {
  const A = await deposit(5000); Bd = await deposit(10000); const C = await deposit(15000);
  const count2 = (await allLedger()).length;
  await del(Bd.id);
  ok((await liveDeposit(A.id)) === 1 && (await liveChain(A.id)) === 1, 'A remains, with its entry');
  ok((await liveDeposit(Bd.id)) === 0 && (await liveChain(Bd.id)) === 0, 'B completely removed');
  ok((await liveDeposit(C.id)) === 1 && (await liveChain(C.id)) === 1, 'C remains, with its entry');
  ok((await allLedger()).length === count2, 'no reversal/credit for B');
});

// ── Test 3: running balances stay consistent.
test('Test 3 — ledger balance stays consistent', async () => {
  const live = await liveLedger();
  let run = 0, chainOk = true;
  for (const e of live) { run += e.d - e.c; if (Math.abs(run - e.b) > 0.001) chainOk = false; }
  ok(chainOk, 'every live row\'s running balance matches the recomputed chain');
  ok((await closing()) === (await sum()), 'closing balance = sum of live entries');
  ok(live.every((e) => e.c === 0 || e.source_type === 'manual' || e.description.includes('typo')), 'no credit rows from deposits');
});

// ── Test 4: repeated delete.
test('Test 4 — repeated delete', async () => {
  const count4 = (await allLedger()).length;
  const r4 = await del(Bd.id);
  ok(r4.deleted === false, `second delete is a safe no-op (${r4.reason})`);
  ok((await allLedger()).length === count4, 'no new ledger row');
});

// ── Test 5: DB level — no INSERT into ledger_entries on delete.
test('Test 5 — delete fires no INSERT on ledger_entries', async () => {
  await db.exec(`create table ins_log (id uuid);
    create function log_ins() returns trigger language plpgsql as $$ begin insert into ins_log values (new.id); return new; end $$;
    create trigger ledger_ins_log after insert on ledger_entries for each row execute function log_ins();`);
  const d5 = await deposit(4000, { cash: 3000, bank: 1000, fuel: 0 });
  await db.exec('delete from ins_log');
  await del(d5.id);
  ok((await db.query('select count(*)::int c from ins_log')).rows[0].c === 0, 'deleting a deposit fires zero INSERTs on ledger_entries');
});

// ── Corrected-then-deleted deposit: the correction's reversal pair goes too.
test('Corrected then deleted — the whole chain goes', async () => {
  const d6 = await deposit(6000);
  await db.query(`select amend_finance_record('cash_transfer',$1,'cashAmount','6500','typo',null,'admin')`, [d6.id]);
  ok((await liveChain(d6.id)) === 3, 'correction left original + reversal + re-post');
  const bal6 = await sum();
  const count6 = (await allLedger()).length;
  await del(d6.id);
  ok((await liveChain(d6.id)) === 0, 'whole chain removed on delete');
  ok((await sum()) === bal6 - 6500, 'balance drops by the live amount only');
  ok((await allLedger()).length === count6, 'nothing posted');
});

// ── Regression: creation still books income normally.
test('Create still books one income entry', async () => {
  const d7 = await deposit(1234, { cash: 1000, bank: 234, fuel: 0 });
  const e7 = (await db.query(`select debit::float d, credit::float c, ledger_head_type::text t from ledger_entries where source_id=$1 and deleted_at is null`, [d7.id])).rows;
  ok(e7.length === 1 && e7[0].d === 1234 && e7[0].c === 0 && e7[0].t === 'income', 'new deposit → one income (debit) entry of the Total');
});

// ── Migration 127: the Total posts under Company Share; fuel stays on INC-FUEL.
test('Migration 127 — deposit Total posts under Company Share', async () => {
  await db.exec(read('20260927000127_cash_deposit_company_share_head.sql'));
  const d = await deposit(9000, { cash: 6000, bank: 3000, fuel: 200 });
  const rows = (await db.query(`select h.code, e.ledger_head_name, e.debit::float d, e.credit::float c, e.payment_method
    from ledger_entries e join ledger_heads h on h.id = e.ledger_head_id
    where e.source_id = $1 and e.deleted_at is null order by e.seq`, [d.id])).rows;
  ok(rows.length === 2, 'one Total entry + one fuel entry');
  ok(rows[0].code === 'INC-COMPANY-SHARE' && rows[0].ledger_head_name === 'Company Share', 'Total is under Company Share');
  ok(rows[0].d === 9000 && rows[0].c === 0 && rows[0].payment_method === 'cash+bank_account', 'Total = Cash + Easypaisa + Bank as one income entry');
  ok(rows[1].code === 'INC-FUEL' && rows[1].d === 200, 'fuel unchanged on INC-FUEL');
  const count = (await allLedger()).length;
  await del(d.id);
  ok((await liveChain(d.id)) === 0 && (await allLedger()).length === count, 'delete still removes it with no reversal');
});

test.after(() => db.close());
