import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  SYSTEM_LEDGER_HEAD_CODES,
  type BranchSharePayment,
  type CreateBranchSharePaymentInput,
  type FinanceDocStatus,
  type LedgerEntry,
  type UpdateBranchSharePaymentInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { postEntry } from './finance-ledger.service';
import { getLedgerHeadByCode, round2 } from './finance-settings.service';
import { rejectDocument } from './finance-documents.service';

/**
 * Branch Share Payments — actually paying a branch its already-recorded
 * share.
 *
 * Branch income approval (finance-income.service.ts) posts BOTH the company
 * share and the branch share to the ledger the moment a day is approved —
 * that only RECORDS the split, it does not move any cash to the branch. This
 * is the payout: approving one posts the base amount under a dedicated
 * "Branch Share Payout" head, and — if a bonus is included — a SECOND entry
 * under Production Expenses, noting which branch it was for. Two postings in
 * one approval is why this does not reuse the generic `approveDocument()`
 * helper (built for exactly one posting per approval); the claim-then-post
 * safety pattern is copied from it deliberately, not reinvented.
 */

const num = (v: unknown) => Number(v ?? 0);

function normalise(p: BranchSharePayment): BranchSharePayment {
  return { ...p, amount: num(p.amount), bonus: num(p.bonus) };
}

export interface BranchShareQuery {
  status?: FinanceDocStatus | 'pending';
  branchId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export async function listBranchSharePayments(q: BranchShareQuery): Promise<BranchSharePayment[]> {
  let query = supabaseAdmin
    .from('branch_share_payments')
    .select('*')
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(q.limit ?? 200), 1), 500));

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) query = query.or(`payment_no.ilike.%${term}%,branch_name.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<BranchSharePayment[]>(data ?? []).map(normalise);
}

export async function getBranchSharePayment(id: string): Promise<BranchSharePayment | null> {
  const { data, error } = await supabaseAdmin.from('branch_share_payments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? normalise(rowToApi<BranchSharePayment>(data)) : null;
}

async function requireBranch(branchId: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Branch not found'), { status: 400 });
  return { id: data.id as string, name: data.name as string };
}

export async function createBranchSharePayment(
  input: CreateBranchSharePaymentInput,
  actor: { uid: string; name: string },
): Promise<BranchSharePayment> {
  const branch = await requireBranch(input.branchId);

  const { data, error } = await supabaseAdmin
    .from('branch_share_payments')
    .insert({
      branch_id: branch.id,
      branch_name: branch.name,
      amount: round2(input.amount),
      bonus: round2(input.bonus),
      business_date: input.businessDate ?? businessDateStr(),
      payment_method: input.paymentMethod,
      account: input.account,
      status: input.asDraft ? 'draft' : 'pending_approval',
      requested_by: actor.uid,
      requested_by_name: actor.name,
      notes: input.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<BranchSharePayment>(data));
}

export async function updateBranchSharePayment(
  id: string,
  input: UpdateBranchSharePaymentInput,
): Promise<BranchSharePayment> {
  const current = await getBranchSharePayment(id);
  if (!current) throw Object.assign(new Error('Branch share payment not found'), { status: 404 });
  if (!EDITABLE_DOC_STATUSES.includes(current.status)) {
    throw Object.assign(
      new Error(`${current.paymentNo} is ${current.status} and can no longer be edited.`),
      { status: 409 },
    );
  }

  const row: Record<string, unknown> = {};
  if (input.amount !== undefined) row['amount'] = round2(input.amount);
  if (input.bonus !== undefined) row['bonus'] = round2(input.bonus);
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  if (input.notes !== undefined) row['notes'] = input.notes;
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await supabaseAdmin
    .from('branch_share_payments')
    .update(row)
    .eq('id', id)
    .in('status', EDITABLE_DOC_STATUSES)
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<BranchSharePayment>(data));
}

export async function submitBranchSharePayment(id: string): Promise<BranchSharePayment> {
  const { data, error } = await supabaseAdmin
    .from('branch_share_payments')
    .update({ status: 'pending_approval', rejection_reason: null })
    .eq('id', id)
    .in('status', ['draft', 'rejected'])
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected payment can be submitted.'), { status: 409 });
  return normalise(rowToApi<BranchSharePayment>(data));
}

/**
 * Claim-then-post, same order and the same reason as `approveDocument()`:
 * claim the approval first (a conditional update that only succeeds from
 * `pending_approval`), then post. Two approvers racing each other means
 * exactly one wins the claim; the loser gets a 409 before anything is
 * posted, instead of both reaching the append-only ledger.
 */
export async function approveBranchSharePayment(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: BranchSharePayment; entries: LedgerEntry[] }> {
  const doc = await getBranchSharePayment(id);
  if (!doc) throw Object.assign(new Error('Branch share payment not found'), { status: 404 });
  if (doc.status === 'draft') {
    throw Object.assign(new Error(`${doc.paymentNo} is a draft. Submit it for approval first.`), { status: 409 });
  }
  if (doc.status !== 'pending_approval') {
    throw Object.assign(new Error(`${doc.paymentNo} is ${doc.status} and cannot be approved again.`), { status: 409 });
  }

  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('branch_share_payments')
    .update({
      status: 'approved',
      approved_by: actor.uid,
      approved_by_name: actor.name,
      approved_at: new Date().toISOString(),
      ...(notes ? { notes } : {}),
    })
    .eq('id', id)
    .eq('status', 'pending_approval')
    .select('id')
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) throw Object.assign(new Error(`${doc.paymentNo} was just approved by someone else.`), { status: 409 });

  const entries: LedgerEntry[] = [];
  let ledgerEntryId: string | null = null;
  let bonusLedgerEntryId: string | null = null;

  if (doc.amount > 0) {
    const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.BRANCH_SHARE_PAYOUT);
    const entry = await postEntry({
      entryDate: doc.businessDate,
      ledgerHeadId: head.id,
      headType: 'expense',
      description: `Branch share — ${doc.branchName} (${doc.paymentNo})`,
      amount: doc.amount,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: doc.branchId,
      branchName: doc.branchName,
      sourceType: 'branch_share_payout',
      sourceId: id,
      actor,
    });
    entries.push(entry);
    ledgerEntryId = entry.id;
  }

  if (doc.bonus > 0) {
    const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.PRODUCTION_EXPENSE);
    const entry = await postEntry({
      entryDate: doc.businessDate,
      ledgerHeadId: head.id,
      headType: 'expense',
      description: `Bonus of ${doc.branchName} (${doc.paymentNo})`,
      amount: doc.bonus,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: doc.branchId,
      branchName: doc.branchName,
      sourceType: 'branch_share_bonus',
      sourceId: id,
      actor,
    });
    entries.push(entry);
    bonusLedgerEntryId = entry.id;
  }

  const { error: postedErr } = await supabaseAdmin
    .from('branch_share_payments')
    .update({ status: 'posted', ledger_entry_id: ledgerEntryId, bonus_ledger_entry_id: bonusLedgerEntryId })
    .eq('id', id);
  if (postedErr) throw postedErr;

  return { document: (await getBranchSharePayment(id))!, entries };
}

export async function rejectBranchSharePayment(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<BranchSharePayment> {
  await rejectDocument('branch_share_payments', id, reason, actor);
  return (await getBranchSharePayment(id))!;
}
