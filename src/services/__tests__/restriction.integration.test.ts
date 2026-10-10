import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { usePglite } from '../../db/testing';

/**
 * The restriction service against a real Postgres (pglite, in memory) with
 * migration 136 applied over stub tables — no network, no project database.
 *
 * What this covers that the pure-rule tests cannot: that an approval is found
 * by the server's own binding (right branch, right date, right amount), that it
 * is spent exactly once, and that the SQL in the migration does what the
 * service assumes.
 *
 * The service's own `db.from` / `db.rpc` calls run against that database
 * through the real query layer (src/db) — the same SQL generator the API uses.
 */

const STUBS = `
  create schema app;
  create role anon; create role authenticated; create role service_role;
  create table counters (id text primary key, count bigint not null);
  create function app.next_finance_number(p_key text, p_prefix text) returns text language plpgsql as $$
    declare n bigint;
    begin
      update counters set count = count + 1 where id = p_key returning count into n;
      return p_prefix || '-' || lpad(n::text, 6, '0');
    end $$;
  create table users (id uuid primary key default gen_random_uuid());
  create table branches (id uuid primary key default gen_random_uuid(), name text, is_active boolean not null default true);
  create table production_orders (
    id uuid primary key default gen_random_uuid(), branch_id uuid, demand_number text, status text,
    submitted_at timestamptz not null default now());
  create table orders (id uuid primary key default gen_random_uuid(), branch_id uuid, status text not null default 'delivered', created_at timestamptz not null default now());
  create table cash_transfers (
    id uuid primary key default gen_random_uuid(), transfer_no text, branch_id uuid, business_date date,
    status text, deleted_at timestamptz, created_at timestamptz not null default now());
  create table ledger_heads (id uuid primary key default gen_random_uuid(), code text, name text, type text);
  create table settings (id boolean primary key, business_start_time text, business_closing_time text);
`;

let db: PGlite;
let svc: typeof import('../restriction.service');
let shared: typeof import('../../shared');

const ids = { a: '', b: '', branchUser: '', otherUser: '', admin: '', finance: '', shareHead: '', rentHead: '' };
const sql = (q: string, p: unknown[] = []) => db.query<Record<string, unknown>>(q, p);
const NOON = new Date('2026-10-03T07:00:00Z'); // 12:00 Karachi — inside business hours

async function reset() {
  await db.exec(`
    delete from restriction_requests; delete from restriction_rules;
    delete from production_orders; delete from orders; delete from cash_transfers;
  `);
  const { invalidate } = await import('../../utils/cache');
  invalidate('restrictionRules');
}

/**
 * Switch the low-sales rule off for tests that call checkDemand at the real
 * clock: after closing it reads the stock ledger, which is not stubbed here,
 * and a test must not pass or fail by the hour it happens to run.
 */
async function withoutLowSales() {
  await sql(
    `insert into restriction_rules (group_key, config) values ('demand', $1)`,
    [JSON.stringify({ lowSales: { enabled: false, minSoldPercent: 30 } })],
  );
  const { invalidate } = await import('../../utils/cache');
  invalidate('restrictionRules');
}

const branchUser = () => ({ uid: ids.branchUser, name: 'gulberg@mb.test', branchId: ids.a, branchName: 'Gulberg' });
const ctx = (action = 'Forward demand') => ({ action, actor: { uid: ids.branchUser, name: 'gulberg@mb.test' }, branch: { id: ids.a, name: 'Gulberg' } });
const admin = () => ({ uid: ids.admin, name: 'admin@mb.test' });

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  const migration = readFileSync(join(__dirname, '../../../db/history/migrations/20261003000136_restriction_rules.sql'), 'utf8');
  // One transaction, as it was applied.
  await db.exec(`begin;${migration}commit;`);
  const productionGroup = readFileSync(join(__dirname, '../../../db/history/migrations/20261003000137_restriction_rules_production_group.sql'), 'utf8');
  await db.exec(`begin;${productionGroup}commit;`);

  const one = async (q: string) => (await sql(q)).rows[0]!['id'] as string;
  ids.a = await one(`insert into branches (name) values ('Gulberg') returning id`);
  ids.b = await one(`insert into branches (name) values ('DHA') returning id`);
  ids.branchUser = await one(`insert into users default values returning id`);
  ids.otherUser = await one(`insert into users default values returning id`);
  ids.admin = await one(`insert into users default values returning id`);
  ids.finance = await one(`insert into users default values returning id`);
  ids.shareHead = await one(`insert into ledger_heads (code, name, type) values ('INC-COMPANY-SHARE', 'Company Share', 'income') returning id`);
  ids.rentHead = await one(`insert into ledger_heads (code, name, type) values ('EXP-RENT', 'Rent', 'expense') returning id`);

  await usePglite(db);

  svc = await import('../restriction.service');
  shared = await import('../../shared');
});

describe('configuration', () => {
  test('no saved rows → the defaults; a saved group replaces its config and is audited', async () => {
    await reset();
    assert.deepEqual(await svc.getRestrictionRules(), shared.DEFAULT_RESTRICTION_RULES);

    await svc.saveRestrictionGroup('cash', { dailyLimit: { enabled: true, limit: 5, allowExceptions: false } }, admin());
    const state = await svc.getRestrictionRulesState();
    assert.equal(state.rules.cash.dailyLimit.limit, 5);
    assert.equal(state.saved.cash.updatedByName, 'admin@mb.test');
    assert.equal(state.saved.demand.updatedAt, null);

    const [event] = await svc.listRestrictionEvents({ ruleCode: 'RULES_CONFIG', limit: 1 });
    assert.equal(event!.result, 'Updated');
    assert.match(event!.eventNo, /^RE-\d{6}$/);
  });

  test('the production group is on by default, saves like any other, and an unknown group is refused by the table', async () => {
    await reset();
    assert.deepEqual((await svc.getRestrictionRules()).production.stockShortage, { enabled: true, allowAdminOverride: true });

    await svc.saveRestrictionGroup('production', { stockShortage: { enabled: true, allowAdminOverride: false } }, admin());
    const state = await svc.getRestrictionRulesState();
    assert.deepEqual(state.rules.production.stockShortage, { enabled: true, allowAdminOverride: false });
    assert.equal(state.saved.production.updatedByName, 'admin@mb.test');

    await assert.rejects(sql(`insert into restriction_rules (group_key, config) values ('bogus', '{}')`));
  });
});

describe('demand', () => {
  test('3 awaiting verification → blocked with the real numbers; another branch is untouched; the refusal is audited', async () => {
    await reset();
    for (const n of ['DMD-000201', 'DMD-000202', 'DMD-000203']) {
      await sql(`insert into production_orders (branch_id, demand_number, status) values ($1, $2, 'awaiting_verification')`, [ids.a, n]);
    }
    // Only Awaiting Verification counts: not one still with Production, not a finished one.
    await sql(`insert into production_orders (branch_id, demand_number, status) values ($1, 'DMD-000198', 'pending')`, [ids.a]);
    await sql(`insert into production_orders (branch_id, demand_number, status) values ($1, 'DMD-000199', 'approved')`, [ids.a]);

    const mine = await svc.checkDemand({ branchId: ids.a, now: NOON });
    assert.equal(mine.check.allowed, false);
    assert.deepEqual(mine.check.restriction!.list, ['#DMD-000201', '#DMD-000202', '#DMD-000203']);

    const theirs = await svc.checkDemand({ branchId: ids.b, now: NOON });
    assert.deepEqual(theirs.check, { allowed: true, restriction: null });

    await assert.rejects(svc.enforceRestrictions(mine, ctx()), (e: unknown) => {
      assert.ok(e instanceof svc.RestrictionError);
      assert.equal(e.status, 409);
      assert.equal(e.details.code, 'restriction');
      assert.equal(e.details.allowed, false);
      return true;
    });
    const [event] = await svc.listRestrictionEvents({ ruleCode: 'DEMAND_PENDING_LIMIT', limit: 1 });
    assert.equal(event!.result, 'Blocked');
    assert.equal(event!.currentValue, '3');
    assert.equal(event!.branchName, 'Gulberg');

    // The branch verifies one → recalculated to a warning, and the demand may go.
    await sql(`update production_orders set status = 'verified' where demand_number = 'DMD-000201'`);
    const after = await svc.checkDemand({ branchId: ids.a, now: NOON });
    assert.equal(after.check.allowed, true);
    assert.equal(after.check.restriction!.severity, 'warning');
  });

  test('backdated: request → approve → spent exactly once, for that branch and date only', async () => {
    await reset();
    await withoutLowSales();
    const past = shared.addDaysToDateStr(shared.businessDateStr(), -2);

    const held = await svc.checkDemand({ branchId: ids.a, requiredDate: past });
    assert.equal(held.check.restriction!.severity, 'admin_approval_required');

    const request = await svc.createRestrictionRequest({ type: 'BACKDATED_DEMAND', date: past, reason: 'Tablet was offline' }, branchUser());
    assert.match(request.requestNo, /^REQ-\d{6}$/);
    assert.equal(request.status, 'pending');
    assert.equal(request.branchId, ids.a);

    // A second request for the same thing is refused, not filed twice.
    await assert.rejects(
      svc.createRestrictionRequest({ type: 'BACKDATED_DEMAND', date: request.requestedDate, reason: 'Asking again' }, branchUser()),
      { status: 409 },
    );

    const waiting = await svc.checkDemand({ branchId: ids.a, requiredDate: request.requestedDate });
    assert.equal(waiting.check.allowed, false);
    assert.equal(waiting.check.restriction!.requestStatus, 'pending');

    const decided = await svc.decideRestrictionRequest(request.id, 'approved', undefined, admin());
    assert.match(decided.approvalNo!, /^APR-\d{6}$/);
    assert.equal(decided.decidedByName, 'admin@mb.test');
    // Decided once; a second decision finds nothing pending.
    await assert.rejects(svc.decideRestrictionRequest(request.id, 'rejected', 'changed my mind', admin()), { status: 409 });

    // The approval is for this branch and this date — not another branch, not another date.
    const otherBranch = await svc.checkDemand({ branchId: ids.b, requiredDate: request.requestedDate });
    assert.equal(otherBranch.check.restriction!.severity, 'admin_approval_required');
    const otherDate = await svc.checkDemand({ branchId: ids.a, requiredDate: shared.addDaysToDateStr(request.requestedDate, -1) });
    assert.equal(otherDate.check.restriction!.severity, 'admin_approval_required');

    const approved = await svc.checkDemand({ branchId: ids.a, requiredDate: request.requestedDate });
    assert.equal(approved.check.allowed, true);
    assert.equal(approved.check.restriction!.severity, 'approved');

    const guard = await svc.enforceRestrictions(approved, ctx());
    await guard.commit('DMD-000300');

    // Replaying the very same evaluation finds the approval already spent …
    await assert.rejects(svc.enforceRestrictions(approved, ctx()), (e: unknown) => {
      assert.ok(e instanceof svc.RestrictionError);
      assert.equal(e.details.restriction!.title, 'Approval Already Used');
      return true;
    });
    // … and a fresh attempt is back to needing approval.
    const again = await svc.checkDemand({ branchId: ids.a, requiredDate: request.requestedDate });
    assert.equal(again.check.restriction!.severity, 'admin_approval_required');
    assert.equal(again.check.restriction!.requestStatus, undefined);

    const [row] = await svc.listRestrictionRequests({ requestedBy: ids.branchUser });
    assert.equal(row!.consumedRef, 'DMD-000300');
    const [event] = await svc.listRestrictionEvents({ ruleCode: 'BACKDATED_DEMAND', limit: 1 });
    assert.equal(event!.result, 'Allowed');
    assert.equal(event!.approvalNo, decided.approvalNo);
  });

  test('an approval is given back if the write fails after the guard passed', async () => {
    await reset();
    await withoutLowSales();
    const past = shared.addDaysToDateStr(shared.businessDateStr(), -1);
    const request = await svc.createRestrictionRequest({ type: 'BACKDATED_DEMAND', date: past, reason: 'Missed the window' }, branchUser());
    await svc.decideRestrictionRequest(request.id, 'approved', undefined, admin());

    const guard = await svc.enforceRestrictions(await svc.checkDemand({ branchId: ids.a, requiredDate: past }), ctx());
    await guard.release();

    const still = await svc.checkDemand({ branchId: ids.a, requiredDate: past });
    assert.equal(still.check.restriction!.severity, 'approved');
  });

  test('rejected → blocked with the admin reason; a rejection needs one at the database too', async () => {
    await reset();
    await withoutLowSales();
    const past = shared.addDaysToDateStr(shared.businessDateStr(), -1);
    const request = await svc.createRestrictionRequest({ type: 'BACKDATED_DEMAND', date: past, reason: 'Missed the window' }, branchUser());

    await assert.rejects(svc.decideRestrictionRequest(request.id, 'rejected', '   ', admin()));
    await svc.decideRestrictionRequest(request.id, 'rejected', 'Already fulfilled from DMD-000198', admin());

    const blocked = await svc.checkDemand({ branchId: ids.a, requiredDate: past });
    assert.equal(blocked.check.allowed, false);
    assert.equal(blocked.check.restriction!.reason, 'Already fulfilled from DMD-000198');
  });

  test('a request for something that is not restricted is refused', async () => {
    await reset();
    await assert.rejects(
      svc.createRestrictionRequest({ type: 'BACKDATED_DEMAND', date: shared.businessDateStr(), reason: 'Just in case' }, branchUser()),
      { status: 400 },
    );
    await assert.rejects(
      svc.createRestrictionRequest({ type: 'CASH_DEPOSIT_LIMIT', date: shared.businessDateStr(), reason: 'Just in case' }, branchUser()),
      { status: 400 },
    );
  });
});

describe('sales', () => {
  test('completed sales are counted per branch in the current hour by the server clock; too few warns, never blocks', async () => {
    await reset();
    assert.equal((await svc.checkSale({ branchId: ids.a })).check.restriction!.currentValue, 0);

    await sql(`insert into orders (branch_id, status) values ($1, 'delivered')`, [ids.a]);
    // None of these is sales activity for branch A this hour.
    await sql(`insert into orders (branch_id, status) values ($1, 'pending'), ($1, 'cancelled')`, [ids.a]);
    await sql(`insert into orders (branch_id, status, created_at) values ($1, 'delivered', now() - interval '2 hours')`, [ids.a]);
    await sql(`insert into orders (branch_id, status) values ($1, 'delivered')`, [ids.b]);

    const low = await svc.checkSale({ branchId: ids.a });
    assert.equal(low.check.allowed, true);
    assert.equal(low.check.restriction!.severity, 'warning');
    assert.equal(low.check.restriction!.currentValue, 1);

    await sql(`insert into orders (branch_id, status) values ($1, 'delivered')`, [ids.a]);
    assert.deepEqual((await svc.checkSale({ branchId: ids.a })).check, { allowed: true, restriction: null });
  });
});

describe('cash deposit', () => {
  test('the 4th of the day is blocked; rejected and deleted ones do not count; an exception is one-time', async () => {
    await reset();
    const today = shared.businessDateStr();
    const add = (no: string, status = 'pending', deleted = false) =>
      sql(`insert into cash_transfers (transfer_no, branch_id, business_date, status, deleted_at) values ($1, $2, $3, $4, $5)`,
        [no, ids.a, today, status, deleted ? new Date().toISOString() : null]);
    await add('CT-000171'); await add('CT-000179', 'approved');
    await add('CT-000180', 'rejected'); await add('CT-000181', 'pending', true);

    assert.equal((await svc.checkCashDeposit({ branchId: ids.a, businessDate: today })).check.allowed, true);

    await add('CT-000188');
    const blocked = await svc.checkCashDeposit({ branchId: ids.a, businessDate: today });
    assert.equal(blocked.check.allowed, false);
    assert.deepEqual(blocked.check.restriction!.list, ['CT-000171', 'CT-000179', 'CT-000188']);

    // Tomorrow's count starts at zero.
    const tomorrow = await svc.checkCashDeposit({ branchId: ids.a, businessDate: shared.addDaysToDateStr(today, 1) });
    assert.equal(tomorrow.check.allowed, true);

    const request = await svc.createRestrictionRequest({ type: 'CASH_DEPOSIT_LIMIT', date: today, reason: 'Late bank transfer' }, branchUser());
    await svc.decideRestrictionRequest(request.id, 'approved', undefined, admin());
    const lifted = await svc.checkCashDeposit({ branchId: ids.a, businessDate: today });
    assert.equal(lifted.check.allowed, true);

    const guard = await svc.enforceRestrictions(lifted, ctx('Forward deposit'));
    await add('CT-000192');
    await guard.commit('CT-000192');
    assert.equal((await svc.checkCashDeposit({ branchId: ids.a, businessDate: today })).check.allowed, false);
  });
});

describe('finance entry', () => {
  const financeUser = () => ({ uid: ids.finance, name: 'accounts@mb.test', branchId: null, branchName: null });

  test('company share needs approval, bound to the user, head, date and amount', async () => {
    await reset();
    const today = shared.businessDateStr();
    const entry = { userId: ids.finance, ledgerHeadId: ids.shareHead, businessDate: today, amount: 125000 };

    assert.equal((await svc.checkFinanceEntry(entry)).check.restriction!.code, 'COMPANY_SHARE_INCOME');
    assert.deepEqual((await svc.checkFinanceEntry({ ...entry, ledgerHeadId: ids.rentHead })).check, { allowed: true, restriction: null });

    // Asking for a head that is not Company Share is refused.
    await assert.rejects(
      svc.createRestrictionRequest({ type: 'COMPANY_SHARE_INCOME', date: today, reason: 'Owner share', ledgerHeadId: ids.rentHead, amount: 125000 }, financeUser()),
      { status: 400 },
    );

    const request = await svc.createRestrictionRequest(
      { type: 'COMPANY_SHARE_INCOME', date: today, reason: 'Owner share handed over in person', ledgerHeadId: ids.shareHead, amount: 125000 },
      financeUser(),
    );
    assert.equal(request.amount, 125000);
    assert.equal(request.entryLabel, 'Income · Company Share');
    await svc.decideRestrictionRequest(request.id, 'approved', undefined, admin());

    assert.equal((await svc.checkFinanceEntry(entry)).check.allowed, true);
    // A different amount, or a different user, is a different entry.
    assert.equal((await svc.checkFinanceEntry({ ...entry, amount: 500000 })).check.allowed, false);
    assert.equal((await svc.checkFinanceEntry({ ...entry, userId: ids.otherUser })).check.allowed, false);
  });

  test('3 days back goes straight in; the 4th needs approval; both rules can apply at once', async () => {
    await reset();
    const today = shared.businessDateStr();
    const at = (days: number, head = ids.rentHead) =>
      svc.checkFinanceEntry({ userId: ids.finance, ledgerHeadId: head, businessDate: shared.addDaysToDateStr(today, -days), amount: 6200 });

    for (const d of [0, 1, 2, 3]) assert.equal((await at(d)).check.allowed, true);
    const old = await at(4);
    assert.equal(old.check.restriction!.code, 'LEDGER_BACKDATE');
    assert.equal(old.check.restriction!.currentValue, 4);

    await assert.rejects(
      svc.createRestrictionRequest({ type: 'LEDGER_BACKDATE', date: today, reason: 'Not actually old', ledgerHeadId: ids.rentHead, amount: 6200 }, financeUser()),
      { status: 400 },
    );

    // Old AND Company Share: clearing one still leaves the other.
    const date = shared.addDaysToDateStr(today, -7);
    const share = await svc.createRestrictionRequest(
      { type: 'COMPANY_SHARE_INCOME', date, reason: 'Owner share, late', ledgerHeadId: ids.shareHead, amount: 6200 },
      financeUser(),
    );
    await svc.decideRestrictionRequest(share.id, 'approved', undefined, admin());
    const half = await at(7, ids.shareHead);
    assert.equal(half.check.allowed, false);
    assert.equal(half.check.restriction!.code, 'LEDGER_BACKDATE');
  });
});

describe('admin views', () => {
  test('monitor reports each active branch under the current rules', async () => {
    await reset();
    for (const n of ['DMD-000401', 'DMD-000402']) {
      await sql(`insert into production_orders (branch_id, demand_number, status) values ($1, $2, 'awaiting_verification')`, [ids.a, n]);
    }
    await sql(`insert into orders (branch_id) values ($1)`, [ids.a]);
    const rows = await svc.getRestrictionMonitor();
    const a = rows.find((r) => r.branchId === ids.a)!;
    const b = rows.find((r) => r.branchId === ids.b)!;
    assert.deepEqual([a.pendingCount, a.demandStatus, a.salesThisHour, a.oldestPending!.demandNumber], [2, 'Warning', 1, 'DMD-000401']);
    assert.deepEqual([b.pendingCount, b.demandStatus, b.oldestPending], [0, 'Normal', null]);
  });

  test('the audit trail cannot be edited or erased', async () => {
    // Last on purpose: a raise inside a trigger can leave pglite unusable.
    await assert.rejects(db.exec(`update restriction_events set result = 'Allowed'`));
  });
});
