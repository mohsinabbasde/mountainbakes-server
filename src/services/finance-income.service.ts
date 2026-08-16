import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  SYSTEM_LEDGER_HEAD_CODES,
  type FinanceAccount,
  type FinanceIncomeApproval,
  type IncomeApprovalStatus,
  type LedgerEntry,
} from '../shared';
import { splitShare } from '../shared';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
import { buildBranchReport } from './closing-report.service';
import {
  getBranchShareSplit,
  getBranchShareSplits,
  getFinanceSettings,
  getLedgerHeadByCode,
  round2,
} from './finance-settings.service';
import { postEntry } from './finance-ledger.service';
import { rowToApi } from '../utils/case';

/**
 * Branch income → Finance.
 *
 *   Branch closing → Admin verifies → Finance approves → posted to the ledger.
 *
 * The figures are NOT re-keyed by anyone. They are computed from the same
 * queries the 2 AM closing and the branch's own closing report use
 * (`buildBranchReport`), so what Finance approves is arithmetically the same
 * money the branch reported taking — there is no second source of truth to
 * reconcile, which is the usual failure mode of a bolt-on finance module.
 *
 * Nothing reaches the ledger before a Finance approval. Until then a day's
 * takings sit in `finance_income_approvals` and appear only on the Pending
 * Income list.
 */

const TABLE = 'finance_income_approvals';
const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  businessDate: string;
  imported: number;
  refreshed: number;
  skipped: { branchName: string; reason: string }[];
}

/**
 * Pull one business date's branch closings into the pending-income list.
 *
 * Idempotent: `finance_income_approvals` is unique on (branch_id,
 * business_date), so re-running never duplicates a day's takings. An existing
 * row that Finance has already decided on (approved or rejected) is left
 * untouched — re-importing over an approved day would restate money that is
 * already in the book.
 *
 * `refresh` re-reads the branch figures over a row that is still pending, for
 * the case where a branch corrected a sale after the first import.
 */
export async function importBranchIncome(opts: {
  businessDate?: string;
  branchId?: string;
  refresh?: boolean;
}): Promise<ImportResult> {
  const businessDate = opts.businessDate ?? businessDateStr();
  const settings = await getFinanceSettings();

  let branchQuery = supabaseAdmin.from('branches').select('id, name').eq('is_active', true).order('name');
  if (opts.branchId) branchQuery = branchQuery.eq('id', opts.branchId);

  const [{ data: branches, error: branchErr }, { data: existingRows, error: existErr }] = await Promise.all([
    branchQuery,
    supabaseAdmin.from(TABLE).select('*').eq('business_date', businessDate),
  ]);
  if (branchErr) throw branchErr;
  if (existErr) throw existErr;

  const existing = new Map(
    ((existingRows ?? []) as Record<string, unknown>[]).map((r) => [r['branch_id'] as string, r]),
  );

  // One lookup for the whole import rather than one per branch: each branch may
  // be on its own split (branches.company_share_pct), and the loop below runs
  // once per active branch.
  const splits = await getBranchShareSplits(((branches ?? []) as { id: string }[]).map((b) => b.id));

  const result: ImportResult = { businessDate, imported: 0, refreshed: 0, skipped: [] };

  for (const branch of ((branches ?? []) as { id: string; name: string }[])) {
    const prior = existing.get(branch.id);
    const priorStatus = prior?.['status'] as IncomeApprovalStatus | undefined;

    if (prior && (priorStatus === 'approved' || priorStatus === 'rejected')) {
      result.skipped.push({ branchName: branch.name, reason: `already ${priorStatus}` });
      continue;
    }
    if (prior && !opts.refresh) {
      result.skipped.push({ branchName: branch.name, reason: 'already imported' });
      continue;
    }

    const report = await buildBranchReport(branch, businessDate);

    // `payments.total` is what the branch actually COLLECTED — a staff sale is
    // deliberately excluded upstream (nobody hands money over for one), so it
    // cannot inflate what Finance is asked to approve.
    const total = round2(report.payments.total);
    const branchExpenses = round2(report.expenses.total);
    const netAmount = round2(total - branchExpenses);
    const shareBase = settings.shareBasis === 'net' ? netAmount : total;
    const split = splits.get(branch.id) ?? {
      companySharePct: settings.companySharePct,
      branchSharePct: settings.branchSharePct,
      isOverride: false,
    };
    const preview = splitShare(shareBase, split.companySharePct);

    const row = {
      branch_id: branch.id,
      branch_name: branch.name,
      business_date: businessDate,
      total_amount: total,
      cash_amount: round2(report.payments.cash),
      easypaisa_amount: round2(report.payments.easypaisa),
      foodpanda_amount: round2(report.payments.foodpanda),
      bank_amount: round2(report.payments.bank),
      other_amount: round2(report.payments.other),
      branch_expenses: branchExpenses,
      net_amount: netAmount,
      // A preview of the split for the pending list, at THIS branch's
      // percentage — its own if it has one, the global default otherwise. The
      // authoritative snapshot is taken again at approval — see approveIncome.
      company_share_pct: split.companySharePct,
      branch_share_pct: split.branchSharePct,
      company_share: preview.companyShare,
      branch_share: preview.branchShare,
      status: settings.requireAdminVerification
        ? ('pending_verification' as const)
        : ('pending_approval' as const),
    };

    if (prior) {
      const { error } = await supabaseAdmin.from(TABLE).update(row).eq('id', prior['id'] as string);
      if (error) throw error;
      result.refreshed += 1;
    } else {
      const { error } = await supabaseAdmin.from(TABLE).insert(row);
      // A concurrent import (the scheduler and a manual click racing) loses on
      // the unique index rather than writing a duplicate day.
      if (error && error.code !== '23505') throw error;
      if (!error) result.imported += 1;
      else result.skipped.push({ branchName: branch.name, reason: 'imported concurrently' });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listIncomeApprovals(q: {
  status?: IncomeApprovalStatus | 'pending';
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<FinanceIncomeApproval[]> {
  let query = supabaseAdmin
    .from(TABLE)
    .select('*')
    .order('business_date', { ascending: false })
    .order('branch_name', { ascending: true })
    .limit(Math.min(Math.max(Number(q.limit ?? 200), 1), 500));

  // 'pending' is the screen's default view and spans both waiting states — a
  // finance user thinks in terms of "not dealt with yet", not which of the two
  // gates it is sitting behind.
  if (q.status === 'pending') query = query.in('status', ['pending_verification', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);

  const { data, error } = await query;
  if (error) throw error;

  const rows = rowToApi<FinanceIncomeApproval[]>(data ?? []).map(normalise);
  const photos = await listAttachmentsFor(
    'finance_income_approval',
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, attachments: photos.get(r.id) ?? [] }));
}

export async function getIncomeApproval(id: string): Promise<FinanceIncomeApproval | null> {
  const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...normalise(rowToApi<FinanceIncomeApproval>(data)),
    attachments: await listAttachments('finance_income_approval', id),
  };
}

function normalise(r: FinanceIncomeApproval): FinanceIncomeApproval {
  return {
    ...r,
    totalAmount: num(r.totalAmount),
    cashAmount: num(r.cashAmount),
    easypaisaAmount: num(r.easypaisaAmount),
    foodpandaAmount: num(r.foodpandaAmount),
    bankAmount: num(r.bankAmount),
    otherAmount: num(r.otherAmount),
    branchExpenses: num(r.branchExpenses),
    netAmount: num(r.netAmount),
    companySharePct: num(r.companySharePct),
    branchSharePct: num(r.branchSharePct),
    companyShare: num(r.companyShare),
    branchShare: num(r.branchShare),
  };
}

// ---------------------------------------------------------------------------
// The three decisions
// ---------------------------------------------------------------------------

/**
 * Admin's verification step. Only moves the row along; posts nothing.
 *
 * `attachmentIds` is OPTIONAL here, unlike every other finance document. These
 * rows are imported from the branch closing rather than typed into a form, so
 * there is no moment of capture at which a photo could be demanded — the
 * verifier may add one (a photo of the day's cash count, say) and usually does
 * not. See the note on `optionalAttachmentIds`.
 */
export async function verifyIncome(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
  attachmentIds: string[] = [],
): Promise<FinanceIncomeApproval> {
  const row = await requireApproval(id);
  if (row.status !== 'pending_verification') {
    throw Object.assign(
      new Error(`${row.referenceNo} is ${row.status.replace(/_/g, ' ')} and cannot be verified.`),
      { status: 409 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({
      status: 'pending_approval',
      verified_by: actor.uid,
      verified_by_name: actor.name,
      verified_at: new Date().toISOString(),
      notes: notes ?? row.notes,
    })
    .eq('id', id)
    // Re-assert the state we decided on. Two admins clicking Verify at once
    // otherwise both succeed, and the second overwrites the first's name and
    // timestamp on a row that had already moved on.
    .eq('status', 'pending_verification')
    .select('*')
    .single();
  if (error) throw error;

  const approval = normalise(rowToApi<FinanceIncomeApproval>(data));
  await bindAttachments({
    entity: 'finance_income_approval',
    entityId: approval.id,
    attachmentIds,
    actor,
  });
  // Re-read rather than returning just what this call bound: the row may already
  // carry photos, and the verifier should see the whole set.
  return { ...approval, attachments: await listAttachments('finance_income_approval', approval.id) };
}

/**
 * Finance approval — the moment money enters the book.
 *
 * THE SHARE SPLIT, and why it posts two entries and not three:
 *
 * The brief is explicit — "calculate Company Share, calculate Branch Share, post
 * both as separate ledger entries". The two shares SUM to the gross collection
 * (75% + 25% = 100%), so posting them both is posting the gross, split by head.
 * Adding a third gross entry would double the day's income. The Company Share
 * and Branch Share reports are then a plain filter on those two heads, and the
 * dashboard's two share cards read straight off them.
 *
 * Each share is further split across the cash and bank accounts in proportion to
 * how the branch actually collected it, because "Cash in Hand" and "Bank
 * Balance" are separate figures on the dashboard and the daily closing — booking
 * an Easypaisa collection as cash would leave a till that never balances.
 *
 * The percentages are re-read and SNAPSHOT here rather than reused from import:
 * approval is the decisive moment, and an owner who changed the split this
 * morning expects today's approvals to use the new one. Since migration 68 the
 * split is resolved PER BRANCH — `branches.company_share_pct` where the branch
 * has its own terms, the global finance setting where it does not.
 */
export async function approveIncome(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ approval: FinanceIncomeApproval; entries: LedgerEntry[] }> {
  const row = await requireApproval(id);
  if (row.status === 'approved') {
    throw Object.assign(new Error(`${row.referenceNo} has already been approved.`), { status: 409 });
  }
  if (row.status === 'rejected') {
    throw Object.assign(new Error(`${row.referenceNo} was rejected and cannot be approved.`), { status: 409 });
  }
  if (row.status === 'pending_verification') {
    throw Object.assign(
      new Error(`${row.referenceNo} is still awaiting Admin verification.`),
      { status: 409 },
    );
  }

  const settings = await getFinanceSettings();
  // This branch's own percentage where it has one, the global default where it
  // does not — resolved fresh here for the same reason the global one always
  // was: approval is the decisive moment, and an owner who moved THIS branch
  // onto 70/30 this morning expects today's approval to use it.
  const split = await getBranchShareSplit(row.branchId);
  const base = settings.shareBasis === 'net' ? row.netAmount : row.totalAmount;
  // Derived by subtraction, never by a second percentage multiplication: at
  // 33.33/66.67 two independent roundings can leave the split a paisa short of
  // the gross, and a ledger that is a paisa out is a ledger nobody trusts.
  const { companyShare, branchShare } = splitShare(base, split.companySharePct);

  const entries: LedgerEntry[] = [];

  if (base > 0) {
    const [companyHead, branchHead] = await Promise.all([
      getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE),
      getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.BRANCH_SHARE),
    ]);

    for (const [head, share, label] of [
      [companyHead, companyShare, `Company share ${split.companySharePct}%`],
      [branchHead, branchShare, `Branch share ${split.branchSharePct}%`],
    ] as [{ id: string; name: string }, number, string][]) {
      for (const slice of splitByAccount(share, row.cashAmount, base)) {
        entries.push(
          await postEntry({
            entryDate: row.businessDate,
            ledgerHeadId: head.id,
            headType: 'income',
            description: `${label} — ${row.branchName} ${row.businessDate} (${row.referenceNo})`,
            amount: slice.amount,
            account: slice.account,
            sourceType: head.id === companyHead.id ? 'company_share' : 'branch_share',
            sourceId: row.id,
            branchId: row.branchId,
            branchName: row.branchName,
            paymentMethod: slice.account === 'cash' ? 'cash' : 'bank_transfer',
            actor,
          }),
        );
      }
    }
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({
      status: 'approved',
      company_share_pct: split.companySharePct,
      branch_share_pct: split.branchSharePct,
      company_share: companyShare,
      branch_share: branchShare,
      approved_by: actor.uid,
      approved_by_name: actor.name,
      approved_at: new Date().toISOString(),
      posted_at: new Date().toISOString(),
      notes: notes ?? row.notes,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;

  return { approval: normalise(rowToApi<FinanceIncomeApproval>(data)), entries };
}

export async function rejectIncome(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<FinanceIncomeApproval> {
  const row = await requireApproval(id);
  if (row.status === 'approved') {
    throw Object.assign(
      new Error(`${row.referenceNo} is already posted. Reverse the ledger entries instead of rejecting it.`),
      { status: 409 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({
      status: 'rejected',
      rejection_reason: reason,
      approved_by: actor.uid,
      approved_by_name: actor.name,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .neq('status', 'approved')
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<FinanceIncomeApproval>(data));
}

/**
 * Split one share across the cash and bank accounts, pro rata to how the branch
 * collected the money.
 *
 * The bank slice is `share − cashSlice`, not a second percentage — the two must
 * add up to the share exactly, and two independent roundings do not guarantee
 * that. Zero slices are dropped so the ledger never carries a voucher for
 * nothing.
 */
function splitByAccount(
  share: number,
  cashCollected: number,
  totalCollected: number,
): { account: FinanceAccount; amount: number }[] {
  if (share <= 0) return [];
  if (totalCollected <= 0) return [{ account: 'cash', amount: share }];

  const cashSlice = round2((share * cashCollected) / totalCollected);
  const bankSlice = round2(share - cashSlice);

  return ([
    { account: 'cash' as const, amount: cashSlice },
    { account: 'bank' as const, amount: bankSlice },
  ]).filter((s) => s.amount > 0);
}

async function requireApproval(id: string): Promise<FinanceIncomeApproval> {
  const row = await getIncomeApproval(id);
  if (!row) throw Object.assign(new Error('Income approval not found'), { status: 404 });
  return row;
}
