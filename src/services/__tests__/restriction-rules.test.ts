import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RESTRICTION_RULES as D,
  RestrictionGroupSchemas,
  DecideRestrictionRequestSchema,
  restrictionAllows as allows,
  backdatedDemandDate,
  closingContext,
  evalBackdatedDemand,
  evalCashLimit,
  evalCompanyShare,
  evalHourlySales,
  evalLedgerBackdate,
  evalLowSales,
  evalPendingDemand,
  mergeRules,
  pickRestriction,
  type RequestState,
} from '../../shared';

/**
 * The restriction rules, case by case, against the pure evaluators — the same
 * functions the API's write paths and the popups' preflight both run.
 */

const TODAY = '2026-10-03';
const dmds = (n: number) => Array.from({ length: n }, (_, i) => `DMD-00010${i + 1}`);
const req = (status: RequestState['status'], adminReason: string | null = null): RequestState => ({
  id: 'r1',
  requestNo: 'REQ-000001',
  status,
  approvalNo: status === 'pending' ? null : 'APR-000001',
  adminReason,
});

describe('demand — pending verification limit', () => {
  const cfg = D.demand.pendingLimit;

  test('0 and 1 pending → allowed, nothing shown', () => {
    assert.equal(evalPendingDemand(cfg, dmds(0)), null);
    assert.equal(evalPendingDemand(cfg, dmds(1)), null);
  });

  test('2 pending → warning, still allowed', () => {
    const r = evalPendingDemand(cfg, dmds(2))!;
    assert.equal(r.severity, 'warning');
    assert.equal(allows(r), true);
    assert.match(r.messages[0]!, /2 demands waiting for verification/);
  });

  test('3 and 4 pending → blocked, listing the real demand numbers', () => {
    for (const n of [3, 4]) {
      const r = evalPendingDemand(cfg, dmds(n))!;
      assert.equal(r.severity, 'blocking');
      assert.equal(allows(r), false);
      assert.deepEqual(r.list, dmds(n).map((d) => `#${d}`));
      assert.equal(r.currentValue, n);
      assert.equal(r.threshold, 3);
    }
  });

  test('a pending demand approved or rejected → recalculated from the new count', () => {
    assert.equal(evalPendingDemand(cfg, dmds(3))!.severity, 'blocking');
    assert.equal(evalPendingDemand(cfg, dmds(2))!.severity, 'warning');
    assert.equal(evalPendingDemand(cfg, dmds(1)), null);
  });

  test('disabled → never fires; thresholds are configurable', () => {
    assert.equal(evalPendingDemand({ ...cfg, enabled: false }, dmds(9)), null);
    assert.equal(evalPendingDemand({ enabled: true, warnAt: 4, blockAt: 6 }, dmds(3)), null);
    assert.equal(evalPendingDemand({ enabled: true, warnAt: 4, blockAt: 6 }, dmds(6))!.severity, 'blocking');
  });
});

describe('demand — backdated', () => {
  const cfg = D.demand.backdated;
  const run = (date: string | null, request: RequestState | null) =>
    evalBackdatedDemand(cfg, { backdatedDate: date, today: TODAY, request });

  test('which date makes a demand backdated', () => {
    assert.equal(backdatedDemandDate(TODAY, TODAY, undefined), null);
    assert.equal(backdatedDemandDate(TODAY, '2026-10-05', TODAY), null);
    assert.equal(backdatedDemandDate(TODAY, '2026-10-01', undefined), '2026-10-01');
    assert.equal(backdatedDemandDate(TODAY, '2026-10-04', '2026-10-02'), '2026-10-02');
    assert.equal(backdatedDemandDate(TODAY, '2026-10-02', '2026-09-30'), '2026-09-30');
  });

  test('normal date → allowed', () => {
    assert.equal(run(null, null), null);
  });

  test('backdated, no request → approval required, may be requested', () => {
    const r = run('2026-10-01', null)!;
    assert.equal(r.severity, 'admin_approval_required');
    assert.equal(r.canRequestApproval, true);
    assert.equal(allows(r), false);
  });

  test('request pending → still held, cannot be requested twice', () => {
    const r = run('2026-10-01', req('pending'))!;
    assert.equal(allows(r), false);
    assert.equal(r.canRequestApproval, false);
  });

  test('admin approves → forwarding allowed, carrying the approval reference', () => {
    const r = run('2026-10-01', req('approved'))!;
    assert.equal(r.severity, 'approved');
    assert.equal(allows(r), true);
    assert.equal(r.approvalNo, 'APR-000001');
  });

  test('admin rejects → blocked, showing the admin reason', () => {
    const r = run('2026-10-01', req('rejected', 'Already fulfilled'))!;
    assert.equal(r.severity, 'blocking');
    assert.equal(r.title, 'Backdated Demand Rejected');
    assert.equal(r.reason, 'Already fulfilled');
  });

  test('approvals switched off → blocked even with an approved request on file', () => {
    const r = evalBackdatedDemand(
      { enabled: true, requireApproval: false },
      { backdatedDate: '2026-10-01', today: TODAY, request: req('approved') },
    )!;
    assert.equal(r.severity, 'blocking');
    assert.equal(r.canRequestApproval, undefined);
  });
});

describe('demand — low sales after closing', () => {
  const cfg = D.demand.lowSales;

  test('before closing → the rule does not apply, whatever was sold', () => {
    assert.equal(evalLowSales(cfg, { afterClosing: false, applicableQty: 400, soldQty: 0 }), null);
  });

  test('after closing, 30% or more sold → allowed', () => {
    assert.equal(evalLowSales(cfg, { afterClosing: true, applicableQty: 400, soldQty: 120 }), null);
    assert.equal(evalLowSales(cfg, { afterClosing: true, applicableQty: 400, soldQty: 300 }), null);
  });

  test('after closing, less than 30% sold → blocked with the figures', () => {
    const r = evalLowSales(cfg, { afterClosing: true, applicableQty: 420, soldQty: 92 })!;
    assert.equal(r.severity, 'blocking');
    assert.equal(r.currentValue, 21.9);
    assert.deepEqual(r.stats!.map((s) => s.value), ['420', '92', '328', '21.9%', '30%']);
  });

  test('just under the line is not rounded up into passing', () => {
    const r = evalLowSales(cfg, { afterClosing: true, applicableQty: 10000, soldQty: 2999 })!;
    assert.equal(r.currentValue, 29.9);
  });

  test('no applicable stock → nothing to measure, not blocked', () => {
    assert.equal(evalLowSales(cfg, { afterClosing: true, applicableQty: 0, soldQty: 0 }), null);
  });

  test('closing time comes from business hours, and wraps past midnight', () => {
    // 08:00 → 02:00 (the default). 01:30 is still open; 03:00 is after closing
    // and the day that just closed is the PREVIOUS business date.
    assert.deepEqual(closingContext(90, 480, 120, TODAY), { afterClosing: false, tradingDate: TODAY });
    assert.deepEqual(closingContext(180, 480, 120, TODAY), { afterClosing: true, tradingDate: '2026-10-02' });
    assert.deepEqual(closingContext(600, 480, 120, TODAY), { afterClosing: false, tradingDate: TODAY });
    // 08:00 → 23:00. 23:30 is after closing on the SAME business date.
    assert.deepEqual(closingContext(1410, 480, 1380, TODAY), { afterClosing: true, tradingDate: TODAY });
    assert.deepEqual(closingContext(420, 480, 1380, TODAY), { afterClosing: true, tradingDate: '2026-10-02' });
  });
});

describe('sales — hourly activity', () => {
  const warn = D.sales.hourly;
  const block = { ...warn, mode: 'block' as const };
  const run = (cfg: typeof warn, count: number) => evalHourlySales(cfg, { count, hourLabel: '10:00–11:00' });

  test('0 and 1 sales this hour → allowed, nothing shown', () => {
    assert.equal(run(warn, 0), null);
    assert.equal(run(warn, 1), null);
    assert.equal(run(block, 1), null);
  });

  test('2 sales this hour → warning', () => {
    const r = run(warn, 2)!;
    assert.equal(r.severity, 'warning');
    assert.match(r.messages[0]!, /2 sales entries have already been recorded/);
  });

  test('3rd sale, configured to warn → saved, warned', () => {
    assert.equal(allows(run(warn, 2)), true);
    const after = run(warn, 3)!;
    assert.equal(after.severity, 'warning');
    assert.match(after.messages[0]!, /maximum hourly sales-entry threshold/);
  });

  test('3rd sale, configured to block → refused', () => {
    const r = run(block, 2)!;
    assert.equal(r.severity, 'blocking');
    assert.equal(allows(r), false);
  });

  test('new hour → the count starts again', () => {
    assert.equal(run(block, 0), null);
  });

  test('warning at threshold can be switched off without affecting the block', () => {
    assert.equal(run({ ...warn, warnAtThreshold: false }, 2), null);
    assert.equal(run({ ...block, warnAtThreshold: false }, 2)!.severity, 'blocking');
  });
});

describe('cash deposit — daily limit', () => {
  const cfg = D.cash.dailyLimit;
  const cts = (n: number) => Array.from({ length: n }, (_, i) => `CT-00018${i}`);
  const run = (n: number, request: RequestState | null = null, businessDate = TODAY) =>
    evalCashLimit(cfg, { transferNos: cts(n), businessDate, today: TODAY, request });

  test('0, 1 and 2 forwarded → the next is allowed', () => {
    for (const n of [0, 1, 2]) assert.equal(run(n), null);
  });

  test('3 forwarded → the 4th is blocked, naming the real CT numbers', () => {
    const r = run(3)!;
    assert.equal(r.severity, 'blocking');
    assert.deepEqual(r.list, cts(3));
    assert.equal(r.canRequestApproval, true);
  });

  test('next business date → the count starts again', () => {
    assert.equal(run(0, null, '2026-10-04'), null);
  });

  test('admin exception: approved → one more allowed; pending or rejected → still blocked', () => {
    assert.equal(run(3, req('approved'))!.severity, 'approved');
    assert.equal(allows(run(3, req('pending'))), false);
    assert.equal(run(3, req('pending'))!.canRequestApproval, false);
    assert.equal(run(3, req('rejected', 'No'))!.reason, 'No');
  });

  test('exceptions switched off → an approved request does not lift the limit', () => {
    const r = evalCashLimit(
      { ...cfg, allowExceptions: false },
      { transferNos: cts(3), businessDate: TODAY, today: TODAY, request: req('approved') },
    )!;
    assert.equal(r.severity, 'blocking');
    assert.equal(r.canRequestApproval, false);
  });
});

describe('ledger — back-entry period', () => {
  const cfg = D.ledger.backdate;
  const run = (entryDate: string, request: RequestState | null = null) =>
    evalLedgerBackdate(cfg, { entryDate, today: TODAY, request });

  test('current date and 1, 2, 3 days back → allowed', () => {
    for (const d of ['2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30']) assert.equal(run(d), null);
  });

  test('older than 3 days → admin approval required', () => {
    const r = run('2026-09-29')!;
    assert.equal(r.severity, 'admin_approval_required');
    assert.equal(r.currentValue, 4);
    assert.equal(r.threshold, 3);
  });

  test('approved → allowed; rejected → blocked with the reason', () => {
    assert.equal(allows(run('2026-09-26', req('approved'))), true);
    const r = run('2026-09-26', req('rejected', 'No receipt'))!;
    assert.equal(r.title, 'Ledger Entry Rejected');
    assert.equal(r.reason, 'No receipt');
    assert.equal(allows(r), false);
  });

  test('a future date is not this rule’s concern', () => {
    assert.equal(run('2026-10-10'), null);
  });
});

describe('company share — income', () => {
  const cfg = D.company.shareIncome;

  test('normal income → allowed', () => {
    assert.equal(evalCompanyShare(cfg, { isCompanyShare: false, request: null }), null);
  });

  test('company share income → admin approval required', () => {
    const r = evalCompanyShare(cfg, { isCompanyShare: true, request: null })!;
    assert.equal(r.severity, 'admin_approval_required');
    assert.equal(r.canRequestApproval, true);
  });

  test('approved → allowed; rejected → blocked', () => {
    assert.equal(allows(evalCompanyShare(cfg, { isCompanyShare: true, request: req('approved') })), true);
    const r = evalCompanyShare(cfg, { isCompanyShare: true, request: req('rejected', 'Use a cash deposit') })!;
    assert.equal(r.title, 'Company Share Income Rejected');
    assert.equal(allows(r), false);
  });

  test('approvals switched off → always blocked', () => {
    const r = evalCompanyShare({ enabled: true, allowApproval: false }, { isCompanyShare: true, request: req('approved') })!;
    assert.equal(r.severity, 'blocking');
  });
});

describe('one notice, most severe', () => {
  test('a block outranks a warning, and a warning never hides a block', () => {
    const warning = evalPendingDemand(D.demand.pendingLimit, dmds(2));
    const block = evalLowSales(D.demand.lowSales, { afterClosing: true, applicableQty: 100, soldQty: 1 });
    const check = pickRestriction([warning, block]);
    assert.equal(check.allowed, false);
    assert.equal(check.restriction!.code, 'LOW_SALES_AFTER_CLOSING');
  });

  test('an approval does not carry a block from another rule', () => {
    const approved = evalBackdatedDemand(D.demand.backdated, { backdatedDate: '2026-10-01', today: TODAY, request: req('approved') });
    const block = evalPendingDemand(D.demand.pendingLimit, dmds(3));
    assert.equal(pickRestriction([approved, block]).allowed, false);
    assert.equal(pickRestriction([approved]).allowed, true);
  });

  test('nothing fired → allowed, no notice', () => {
    assert.deepEqual(pickRestriction([null, null]), { allowed: true, restriction: null });
  });
});

describe('configuration', () => {
  test('stored config merges over defaults; junk and wrong types are ignored', () => {
    const rules = mergeRules({
      demand: { pendingLimit: { warnAt: 4, blockAt: 'six', bogus: 1 }, nonsense: {} },
      cash: 'not an object',
    });
    assert.equal(rules.demand.pendingLimit.warnAt, 4);
    assert.equal(rules.demand.pendingLimit.blockAt, 3);
    assert.equal(rules.demand.lowSales.minSoldPercent, 30);
    assert.deepEqual(rules.cash, D.cash);
  });

  test('warning threshold must be below the blocking threshold', () => {
    const bad = { ...D.demand, pendingLimit: { enabled: true, warnAt: 3, blockAt: 3 } };
    assert.equal(RestrictionGroupSchemas.demand.safeParse(bad).success, false);
    assert.equal(RestrictionGroupSchemas.demand.safeParse(D.demand).success, true);
  });

  test('a rejection needs a reason; an approval does not', () => {
    assert.equal(DecideRestrictionRequestSchema.safeParse({ decision: 'rejected' }).success, false);
    assert.equal(DecideRestrictionRequestSchema.safeParse({ decision: 'rejected', reason: '  ' }).success, false);
    assert.equal(DecideRestrictionRequestSchema.safeParse({ decision: 'approved' }).success, true);
  });
});
