import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  SYSTEM_LEDGER_HEAD_CODES,
  type BranchShareBalance,
  type BranchSharePayment,
  type CreateBranchSharePaymentInput,
  type FinanceDocStatus,
  type LedgerEntry,
  type UpdateBranchSharePaymentInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
import { postEntry } from './finance-ledger.service';
import { getBranchShareSplits, getLedgerHeadByCode, round2 } from './finance-settings.service';
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
  let query = withoutDeleted(
    supabaseAdmin
      .from('branch_share_payments')
      .select('*')
      .order('business_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(q.limit ?? 200), 1), 500)),
  );

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

  const rows = rowToApi<BranchSharePayment[]>(data ?? []).map(normalise);
  const photos = await listAttachmentsFor(
    'branch_share_payment',
    rows.map((p) => p.id),
  );
  return rows.map((p) => ({ ...p, attachments: photos.get(p.id) ?? [] }));
}

/**
 * What each branch is still owed, straight off the ledger.
 *
 * The payout form used to ask someone to key an amount from memory, which is
 * exactly the number a per-branch split makes hard to hold in your head. This
 * derives it:
 *
 *     outstanding = Σ posted Branch Share  −  Σ posted Branch Share Payout
 *
 * Read from `ledger_entries` rather than from `finance_income_approvals` and
 * `branch_share_payments` because the ledger is the book of record — an entry
 * reversed after the fact drops to status 'reversed' and falls out of both sides
 * of this sum automatically, whereas the source documents would still show it.
 *
 * Two things it deliberately does not count:
 *   * Bonuses. A bonus posts to Production Expenses, not against the branch's
 *     share, so netting it here would show a branch as settled while its share
 *     is still owed.
 *   * Corrections re-posted via `adjustEntry`. Those carry source_type
 *     'adjustment', so a share corrected after posting shows at its ORIGINAL
 *     figure here. Rare, and visible in the ledger itself — treating every
 *     adjustment as a share movement would be worse, since most are not.
 */
export async function getBranchShareBalances(branchId?: string): Promise<BranchShareBalance[]> {
  let entriesQuery = withoutDeleted(
    supabaseAdmin
      .from('ledger_entries')
      .select('branch_id, branch_name, debit, credit, source_type')
      .in('source_type', ['branch_share', 'branch_share_payout'])
      .in('status', ['posted', 'locked'])
      .not('branch_id', 'is', null),
  );
  if (branchId) entriesQuery = entriesQuery.eq('branch_id', branchId);

  let branchQuery = supabaseAdmin.from('branches').select('id, name').eq('is_active', true).order('name');
  if (branchId) branchQuery = branchQuery.eq('id', branchId);

  const [{ data: entries, error: entryErr }, { data: branches, error: branchErr }] = await Promise.all([
    entriesQuery,
    branchQuery,
  ]);
  if (entryErr) throw entryErr;
  if (branchErr) throw branchErr;

  const totals = new Map<string, { name: string; recorded: number; paidOut: number }>();
  for (const b of ((branches ?? []) as { id: string; name: string }[])) {
    totals.set(b.id, { name: b.name, recorded: 0, paidOut: 0 });
  }

  for (const row of ((entries ?? []) as Record<string, unknown>[])) {
    const id = row['branch_id'] as string;
    // A branch deactivated after it was posted to still has a balance, and
    // hiding it would quietly write off money. Seed it from the entry's own
    // snapshotted name — `branches` was filtered to active rows.
    const bucket = totals.get(id) ?? { name: (row['branch_name'] as string) ?? 'Unknown branch', recorded: 0, paidOut: 0 };
    // The share is an income head (posted as a debit); the payout is an expense
    // head (posted as a credit) — see postEntry.
    if (row['source_type'] === 'branch_share') bucket.recorded += num(row['debit']);
    else bucket.paidOut += num(row['credit']);
    totals.set(id, bucket);
  }

  const splits = await getBranchShareSplits([...totals.keys()]);

  return [...totals.entries()]
    .map(([id, t]) => {
      const split = splits.get(id);
      return {
        branchId: id,
        branchName: t.name,
        companySharePct: split?.companySharePct ?? 0,
        branchSharePct: split?.branchSharePct ?? 0,
        isOverride: split?.isOverride ?? false,
        recorded: round2(t.recorded),
        paidOut: round2(t.paidOut),
        outstanding: round2(t.recorded - t.paidOut),
      };
    })
    .sort((a, b) => a.branchName.localeCompare(b.branchName));
}

export async function getBranchSharePayment(id: string): Promise<BranchSharePayment | null> {
  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('branch_share_payments').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...normalise(rowToApi<BranchSharePayment>(data)),
    attachments: await listAttachments('branch_share_payment', id),
  };
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

  const payment = normalise(rowToApi<BranchSharePayment>(data));
  const attachments = await bindAttachments({
    entity: 'branch_share_payment',
    entityId: payment.id,
    attachmentIds: input.attachmentIds,
    actor,
  });
  return { ...payment, attachments };
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

  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('branch_share_payments').update(row).eq('id', id).in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<BranchSharePayment>(data));
}

export async function submitBranchSharePayment(id: string): Promise<BranchSharePayment> {
  const { data, error } = await withoutDeleted(
    supabaseAdmin
      .from('branch_share_payments')
      .update({ status: 'pending_approval', rejection_reason: null })
      .eq('id', id)
      .in('status', ['draft', 'rejected']),
  )
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

  const { data: claimed, error: claimErr } = await withoutDeleted(
    supabaseAdmin
      .from('branch_share_payments')
      .update({
        status: 'approved',
        approved_by: actor.uid,
        approved_by_name: actor.name,
        approved_at: new Date().toISOString(),
        ...(notes ? { notes } : {}),
      })
      .eq('id', id)
      .eq('status', 'pending_approval'),
  )
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

  const { error: postedErr } = await withoutDeleted(
    supabaseAdmin
      .from('branch_share_payments')
      .update({ status: 'posted', ledger_entry_id: ledgerEntryId, bonus_ledger_entry_id: bonusLedgerEntryId })
      .eq('id', id),
  );
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
