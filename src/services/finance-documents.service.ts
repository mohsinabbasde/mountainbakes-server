import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  type CreateFinanceTransactionInput,
  type CreatePartnerExpenseInput,
  type FinanceDocStatus,
  type FinanceTransaction,
  type LedgerEntry,
  type LedgerSourceType,
  type PartnerExpense,
  type UpdateFinanceTransactionInput,
  type UpdatePartnerExpenseInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { postEntry, requireActiveHead } from './finance-ledger.service';
import { round2 } from './finance-settings.service';

/**
 * Manual income / expense documents and partner expenses.
 *
 * Both walk the same lifecycle — draft → pending_approval → approved → posted →
 * locked, or rejected — and both post to the ledger at the moment of approval.
 * The shared machinery for that lives in `approveDocument` at the bottom; the
 * per-type functions above it exist because the two carry different fields, not
 * different rules.
 *
 * WHY THE DOCUMENT AND THE LEDGER ENTRY ARE SEPARATE ROWS: the document holds
 * the decision trail (who raised it, who approved it, why it was rejected, what
 * it was edited from); the ledger entry holds the money and is immutable. Fusing
 * them would mean either a mutable ledger or an untraceable approval, and both
 * are disqualifying.
 */

const num = (v: unknown) => Number(v ?? 0);

/**
 * The single place that decides where a new document starts.
 *
 * `asDraft` is what the "Save as draft" button sends; everything else goes
 * straight into the approval queue, because the common case is an accountant
 * entering a real receipt they want signed off today.
 */
function initialStatus(asDraft: boolean): FinanceDocStatus {
  return asDraft ? 'draft' : 'pending_approval';
}

function assertEditable(doc: { status: FinanceDocStatus }, ref: string): void {
  if (!EDITABLE_DOC_STATUSES.includes(doc.status)) {
    throw Object.assign(
      new Error(
        doc.status === 'pending_approval'
          ? `${ref} is awaiting approval. Ask an approver to reject it first if it needs changing.`
          : `${ref} is ${doc.status} and can no longer be edited. Post an adjustment instead.`,
      ),
      { status: 409 },
    );
  }
}

// ---------------------------------------------------------------------------
// Manual income / expense (finance_transactions)
// ---------------------------------------------------------------------------

export interface TransactionQuery {
  status?: FinanceDocStatus | 'pending';
  type?: 'income' | 'expense';
  branchId?: string;
  ledgerHeadId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export async function listTransactions(q: TransactionQuery): Promise<FinanceTransaction[]> {
  let query = supabaseAdmin
    .from('finance_transactions')
    .select('*')
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(q.limit ?? 200), 1), 500));

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.type) query = query.eq('txn_type', q.type);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.ledgerHeadId) query = query.eq('ledger_head_id', q.ledgerHeadId);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) {
      query = query.or(
        `txn_no.ilike.%${term}%,description.ilike.%${term}%,ledger_head_name.ilike.%${term}%,reference_no.ilike.%${term}%`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<FinanceTransaction[]>(data ?? []).map((t) => ({ ...t, amount: num(t.amount) }));
}

export async function createTransaction(
  input: CreateFinanceTransactionInput,
  actor: { uid: string; name: string },
): Promise<FinanceTransaction> {
  // The head is read from the database and ITS type decides whether this is
  // income or expense. Nothing the client sent gets a vote — see the schema note.
  const head = await requireActiveHead(input.ledgerHeadId);
  const branch = await resolveBranch(input.branchId);

  const { data, error } = await supabaseAdmin
    .from('finance_transactions')
    .insert({
      txn_type: head.type,
      ledger_head_id: head.id,
      ledger_head_name: head.name,
      branch_id: branch?.id ?? null,
      branch_name: branch?.name ?? null,
      description: input.description,
      amount: round2(input.amount),
      payment_method: input.paymentMethod,
      account: input.account,
      business_date: input.businessDate ?? businessDateStr(),
      status: initialStatus(input.asDraft),
      reference_no: input.referenceNo ?? null,
      notes: input.notes ?? null,
      created_by: actor.uid,
      created_by_name: actor.name,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToApi<FinanceTransaction>(data);
}

export async function updateTransaction(
  id: string,
  input: UpdateFinanceTransactionInput,
): Promise<FinanceTransaction> {
  const current = await getTransaction(id);
  if (!current) throw Object.assign(new Error('Entry not found'), { status: 404 });
  assertEditable(current, current.txnNo);

  const row: Record<string, unknown> = {};
  if (input.ledgerHeadId !== undefined) {
    const head = await requireActiveHead(input.ledgerHeadId);
    row['ledger_head_id'] = head.id;
    row['ledger_head_name'] = head.name;
    row['txn_type'] = head.type;
  }
  if (input.branchId !== undefined) {
    const branch = await resolveBranch(input.branchId);
    row['branch_id'] = branch?.id ?? null;
    row['branch_name'] = branch?.name ?? null;
  }
  if (input.description !== undefined) row['description'] = input.description;
  if (input.amount !== undefined) row['amount'] = round2(input.amount);
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  if (input.referenceNo !== undefined) row['reference_no'] = input.referenceNo;
  if (input.notes !== undefined) row['notes'] = input.notes;

  // Editing a rejected document puts it back in the queue — otherwise the fix
  // sits in limbo with nobody prompted to look at it again.
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await supabaseAdmin
    .from('finance_transactions')
    .update(row)
    .eq('id', id)
    .in('status', EDITABLE_DOC_STATUSES)
    .select('*')
    .single();
  if (error) throw error;
  return rowToApi<FinanceTransaction>(data);
}

export async function getTransaction(id: string): Promise<FinanceTransaction | null> {
  const { data, error } = await supabaseAdmin.from('finance_transactions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? { ...rowToApi<FinanceTransaction>(data), amount: num((data as Record<string, unknown>)['amount']) } : null;
}

/** Move a draft into the approval queue. */
export async function submitTransaction(id: string): Promise<FinanceTransaction> {
  const { data, error } = await supabaseAdmin
    .from('finance_transactions')
    .update({ status: 'pending_approval', rejection_reason: null })
    .eq('id', id)
    .in('status', ['draft', 'rejected'])
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected entry can be submitted.'), { status: 409 });
  return rowToApi<FinanceTransaction>(data);
}

export async function approveTransaction(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: FinanceTransaction; entry: LedgerEntry }> {
  const doc = await getTransaction(id);
  if (!doc) throw Object.assign(new Error('Entry not found'), { status: 404 });

  const entry = await approveDocument({
    table: 'finance_transactions',
    id,
    ref: doc.txnNo,
    status: doc.status,
    actor,
    notes,
    posting: {
      entryDate: doc.businessDate,
      ledgerHeadId: doc.ledgerHeadId,
      headType: doc.txnType,
      description: `${doc.description} (${doc.txnNo})`,
      amount: doc.amount,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: doc.branchId,
      branchName: doc.branchName,
      sourceType: 'manual',
    },
  });

  return { document: (await getTransaction(id))!, entry };
}

export async function rejectTransaction(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<FinanceTransaction> {
  await rejectDocument('finance_transactions', id, reason, actor);
  return (await getTransaction(id))!;
}

// ---------------------------------------------------------------------------
// Partner expenses
// ---------------------------------------------------------------------------

export interface PartnerExpenseQuery {
  status?: FinanceDocStatus | 'pending';
  partnerName?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export async function listPartnerExpenses(q: PartnerExpenseQuery): Promise<PartnerExpense[]> {
  let query = supabaseAdmin
    .from('partner_expenses')
    .select('*')
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(q.limit ?? 200), 1), 500));

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.partnerName) query = query.eq('partner_name', q.partnerName);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) {
      query = query.or(
        `expense_no.ilike.%${term}%,partner_name.ilike.%${term}%,description.ilike.%${term}%,ledger_head_name.ilike.%${term}%`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<PartnerExpense[]>(data ?? []).map((p) => ({ ...p, amount: num(p.amount) }));
}

export async function createPartnerExpense(
  input: CreatePartnerExpenseInput,
  actor: { uid: string; name: string },
): Promise<PartnerExpense> {
  // Partner money always leaves the business, so the head must be an expense
  // head. Booking a partner withdrawal against an income head would show the
  // company earning money it was actually paying out.
  const head = await requireActiveHead(input.ledgerHeadId, 'expense');

  const { data, error } = await supabaseAdmin
    .from('partner_expenses')
    .insert({
      partner_name: input.partnerName,
      ledger_head_id: head.id,
      ledger_head_name: head.name,
      description: input.description,
      amount: round2(input.amount),
      payment_method: input.paymentMethod,
      account: input.account,
      business_date: input.businessDate ?? businessDateStr(),
      status: initialStatus(input.asDraft),
      requested_by: actor.uid,
      requested_by_name: actor.name,
      notes: input.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToApi<PartnerExpense>(data);
}

export async function updatePartnerExpense(
  id: string,
  input: UpdatePartnerExpenseInput,
): Promise<PartnerExpense> {
  const current = await getPartnerExpense(id);
  if (!current) throw Object.assign(new Error('Partner expense not found'), { status: 404 });
  assertEditable(current, current.expenseNo);

  const row: Record<string, unknown> = {};
  if (input.ledgerHeadId !== undefined) {
    const head = await requireActiveHead(input.ledgerHeadId, 'expense');
    row['ledger_head_id'] = head.id;
    row['ledger_head_name'] = head.name;
  }
  if (input.partnerName !== undefined) row['partner_name'] = input.partnerName;
  if (input.description !== undefined) row['description'] = input.description;
  if (input.amount !== undefined) row['amount'] = round2(input.amount);
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  if (input.notes !== undefined) row['notes'] = input.notes;
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await supabaseAdmin
    .from('partner_expenses')
    .update(row)
    .eq('id', id)
    .in('status', EDITABLE_DOC_STATUSES)
    .select('*')
    .single();
  if (error) throw error;
  return rowToApi<PartnerExpense>(data);
}

export async function getPartnerExpense(id: string): Promise<PartnerExpense | null> {
  const { data, error } = await supabaseAdmin.from('partner_expenses').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? { ...rowToApi<PartnerExpense>(data), amount: num((data as Record<string, unknown>)['amount']) } : null;
}

export async function submitPartnerExpense(id: string): Promise<PartnerExpense> {
  const { data, error } = await supabaseAdmin
    .from('partner_expenses')
    .update({ status: 'pending_approval', rejection_reason: null })
    .eq('id', id)
    .in('status', ['draft', 'rejected'])
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected expense can be submitted.'), { status: 409 });
  return rowToApi<PartnerExpense>(data);
}

export async function approvePartnerExpense(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: PartnerExpense; entry: LedgerEntry }> {
  const doc = await getPartnerExpense(id);
  if (!doc) throw Object.assign(new Error('Partner expense not found'), { status: 404 });

  const entry = await approveDocument({
    table: 'partner_expenses',
    id,
    ref: doc.expenseNo,
    status: doc.status,
    actor,
    notes,
    posting: {
      entryDate: doc.businessDate,
      ledgerHeadId: doc.ledgerHeadId,
      headType: 'expense',
      description: `${doc.partnerName} — ${doc.description} (${doc.expenseNo})`,
      amount: doc.amount,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: null,
      branchName: null,
      sourceType: 'partner_expense',
    },
  });

  return { document: (await getPartnerExpense(id))!, entry };
}

export async function rejectPartnerExpense(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<PartnerExpense> {
  await rejectDocument('partner_expenses', id, reason, actor);
  return (await getPartnerExpense(id))!;
}

// ---------------------------------------------------------------------------
// Shared approval machinery
// ---------------------------------------------------------------------------

export interface ApproveDocumentInput {
  table: 'finance_transactions' | 'partner_expenses' | 'salary_payments';
  id: string;
  ref: string;
  status: FinanceDocStatus;
  actor: { uid: string; name: string };
  notes?: string | null;
  posting: {
    entryDate: string;
    ledgerHeadId: string;
    headType: 'income' | 'expense';
    description: string;
    amount: number;
    account: 'cash' | 'bank';
    paymentMethod: string;
    branchId: string | null;
    branchName: string | null;
    sourceType: LedgerSourceType;
  };
}

/**
 * Approve a document and post it.
 *
 * ORDER MATTERS, and the order here is the safe one: claim the approval FIRST
 * (a conditional update that only succeeds from a pending state), then post.
 *
 * Two approvers clicking at the same moment is the case this protects against.
 * With the claim first, exactly one of them wins the update and posts; the loser
 * gets a 409. Posting first would let both reach the ledger and book the expense
 * twice, and the ledger is append-only — the second one could then only be
 * removed by a reversal, which is a conversation nobody wants to have.
 *
 * If the posting itself then fails, the document is left `approved` but not
 * `posted`, with no ledger entry. That state is deliberately visible (the UI
 * shows it as approved-not-posted) rather than silently rolled back: the
 * approval was a real human decision and should not evaporate because the
 * ledger refused the date.
 */
async function approveDocument(input: ApproveDocumentInput): Promise<LedgerEntry> {
  if (input.status === 'draft') {
    throw Object.assign(new Error(`${input.ref} is a draft. Submit it for approval first.`), { status: 409 });
  }
  if (input.status !== 'pending_approval') {
    throw Object.assign(
      new Error(`${input.ref} is ${input.status} and cannot be approved again.`),
      { status: 409 },
    );
  }

  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from(input.table)
    .update({
      status: 'approved',
      approved_by: input.actor.uid,
      approved_by_name: input.actor.name,
      approved_at: new Date().toISOString(),
      ...(input.notes ? { notes: input.notes } : {}),
    })
    .eq('id', input.id)
    .eq('status', 'pending_approval')
    .select('id')
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) {
    throw Object.assign(new Error(`${input.ref} was just approved by someone else.`), { status: 409 });
  }

  const entry = await postEntry({ ...input.posting, sourceId: input.id, actor: input.actor });

  const { error: postedErr } = await supabaseAdmin
    .from(input.table)
    .update({ status: 'posted', ledger_entry_id: entry.id })
    .eq('id', input.id);
  if (postedErr) throw postedErr;

  return entry;
}

async function rejectDocument(
  table: ApproveDocumentInput['table'],
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update({
      status: 'rejected',
      rejection_reason: reason,
      approved_by: actor.uid,
      approved_by_name: actor.name,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['draft', 'pending_approval'])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(
      new Error('Only a draft or pending document can be rejected. A posted entry needs a reversal instead.'),
      { status: 409 },
    );
  }
}

async function resolveBranch(branchId?: string | null): Promise<{ id: string; name: string } | null> {
  if (!branchId) return null;
  const { data, error } = await supabaseAdmin.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Branch not found'), { status: 400 });
  return { id: data.id as string, name: data.name as string };
}

export { approveDocument, rejectDocument };
