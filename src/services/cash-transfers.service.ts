import { supabaseAdmin } from '../config/supabase';
import {
  CASH_TRANSFER_METHODS,
  CASH_TRANSFER_METHOD_LABELS,
  CASH_TRANSFER_STATUSES,
  businessDateStr,
  type CashTransfer,
  type CashTransferMethod,
  type CashTransferSortKey,
  type CashTransferStatus,
  type CreateCashTransferInput,
  type LedgerEntry,
  type PaymentReceivedItem,
  type UserRole,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
import { getLedgerEntry } from './finance-ledger.service';
import { notify } from './push.service';

/**
 * Cash transfers — money a branch hands to the company (migration 118).
 *
 * THE SHAPE OF THIS FILE. Two callers share it: the branch router
 * (cash-transfers.routes.ts), which may only ever see its own branch, and the
 * Finance router (finance-cash-transfers.routes.ts), which reviews across
 * branches. Both go through `listCashTransfers` / `getCashTransfer` with an
 * optional `branchId`; the ROUTER decides whether that id is pinned from the
 * JWT or chosen from the query string, and this file trusts what it is handed.
 * Every write that changes a transfer's state is a Postgres function
 * (approve_cash_transfer / reject_cash_transfer): the approval has to post the
 * RV- receipt and flip the status in one transaction, and PostgREST gives each
 * call its own transaction, so that cannot be done from here in two steps.
 *
 * WHAT IT NEVER DOES. Nothing here touches production_orders, branch_discounts,
 * orders, expenses or stock. The transfer is one transaction; the production
 * slip reads approved rows through `paymentsReceivedInWindow` and displays the
 * sum beside its existing figures without subtracting it from anything.
 */

// ---------------------------------------------------------------------------
// Row ↔ API
// ---------------------------------------------------------------------------

/**
 * One DB row → the API's CashTransfer shape. Two fixes the discount router
 * also has to make: `business_date` → `date`, and `amount` through Number()
 * because PostgREST can hand a `numeric` back as a string.
 */
function toApi(row: Record<string, unknown>): CashTransfer {
  const { businessDate, amount, ...rest } = rowToApi<Record<string, unknown>>(row);
  return {
    ...(rest as Omit<CashTransfer, 'amount' | 'date' | 'attachments'>),
    amount: Number(amount),
    date: String(businessDate),
    attachments: [],
  };
}

const SORTABLE_COLUMNS: Record<CashTransferSortKey, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  approvedAt: 'approved_at',
  transferNo: 'transfer_no',
  voucherNo: 'voucher_no',
  branchName: 'branch_name',
  amount: 'amount',
  paymentMethod: 'payment_method',
  status: 'status',
};

export function isCashTransferSortKey(v: unknown): v is CashTransferSortKey {
  return typeof v === 'string' && v in SORTABLE_COLUMNS;
}
export function isCashTransferStatus(v: unknown): v is CashTransferStatus {
  return typeof v === 'string' && (CASH_TRANSFER_STATUSES as readonly string[]).includes(v);
}
export function isCashTransferMethod(v: unknown): v is CashTransferMethod {
  return typeof v === 'string' && (CASH_TRANSFER_METHODS as readonly string[]).includes(v);
}

/**
 * P0001 → 409 ("wrong state for this": already decided, finance day closed),
 * P0002 → 404, and the two "function does not exist" codes → 503 with the
 * migration named — the same mapping daily-sale.service.ts documents.
 */
function asClientError(error: { code?: string; message: string }): Error & { status?: number } {
  if (error.code === 'PGRST202' || error.code === '42883') {
    return Object.assign(
      new Error(
        'Cash transfers are unavailable: database migration 118 (cash_transfers) ' +
          'has not been applied. Run `npx supabase db push --linked`.',
      ),
      { status: 503 },
    );
  }
  if (error.code === 'P0002') return Object.assign(new Error('Cash transfer not found'), { status: 404 });
  if (error.code === 'P0001') return Object.assign(new Error(error.message), { status: 409 });
  return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CashTransferQuery {
  /** Pinned by the branch router; optional for Finance. */
  branchId?: string;
  from?: string;
  to?: string;
  status?: CashTransferStatus;
  paymentMethod?: CashTransferMethod;
  search?: string;
  sortBy?: CashTransferSortKey;
  sortDir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export async function listCashTransfers(
  q: CashTransferQuery,
): Promise<{ transfers: CashTransfer[]; total: number }> {
  const sortCol = q.sortBy ? SORTABLE_COLUMNS[q.sortBy] : 'created_at';
  const ascending = q.sortDir === 'asc';

  // Soft-deleted through the Help Desk (migration 120) → gone from every list.
  let query = withoutDeleted(
    supabaseAdmin
      .from('cash_transfers')
      .select('*', { count: 'exact' }),
  )
    .order(sortCol, { ascending })
    // A stable tiebreak so paging never repeats or skips a row that shares the
    // sort value with its neighbour (every row of one day, sorted by date).
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.status) query = query.eq('status', q.status);
  if (q.paymentMethod) query = query.eq('payment_method', q.paymentMethod);

  // Free-text over the two numbers, the branch and the note — same convention
  // as the discount list: strip `or` filter syntax, then ilike.
  const term = q.search?.replace(/[(),*]/g, ' ').trim();
  if (term) {
    query = query.or(
      `transfer_no.ilike.%${term}%,voucher_no.ilike.%${term}%,branch_name.ilike.%${term}%,note.ilike.%${term}%`,
    );
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const transfers = ((data ?? []) as Record<string, unknown>[]).map(toApi);
  const photos = await listAttachmentsFor('cash_transfer', transfers.map((t) => t.id));
  return {
    transfers: transfers.map((t) => ({ ...t, attachments: photos.get(t.id) ?? [] })),
    total: count ?? 0,
  };
}

/**
 * One transfer, or null. When `branchId` is given the row must belong to it —
 * a branch asking for another shop's id gets "not found", not "forbidden",
 * so the response does not confirm the id exists.
 */
export async function getCashTransfer(id: string, branchId?: string | null): Promise<CashTransfer | null> {
  let query = withoutDeleted(supabaseAdmin.from('cash_transfers').select('*').eq('id', id));
  if (branchId) query = query.eq('branch_id', branchId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const transfer = toApi(data as Record<string, unknown>);
  return { ...transfer, attachments: await listAttachments('cash_transfer', id) };
}

// ---------------------------------------------------------------------------
// Create (branch)
// ---------------------------------------------------------------------------

export async function createCashTransfer(input: {
  branchId: string;
  role: UserRole;
  actor: { uid: string; email: string };
  body: CreateCashTransferInput;
}): Promise<CashTransfer> {
  const { data: branch, error: brErr } = await supabaseAdmin
    .from('branches')
    .select('id, name')
    .eq('id', input.branchId)
    .maybeSingle();
  if (brErr) throw brErr;
  if (!branch) throw Object.assign(new Error('Branch not found'), { status: 400 });

  // The device's business date when the mobile app sends one, today's
  // otherwise — bounded and put through the day-closure check exactly as a
  // sale or an expense is.
  const businessDate = await resolveClientBusinessDate(input.body.businessDate, input.role);

  const { data: created, error: insErr } = await supabaseAdmin
    .from('cash_transfers')
    .insert({
      branch_id: branch.id,
      branch_name: branch.name,
      amount: input.body.amount,
      payment_method: input.body.paymentMethod,
      note: input.body.note?.trim() || null,
      business_date: businessDate,
      status: 'pending',
      created_by: input.actor.uid,
      created_by_name: input.actor.email,
    })
    .select('*')
    .single();
  if (insErr) throw insErr;

  // Bind the staged photo(s). The schema already required at least one id, so
  // a throw here means the photo vanished between upload and submit (a second
  // tab, a retry after a partial failure); the 409 tells the branch to retake.
  const attachments = await bindAttachments({
    entity: 'cash_transfer',
    entityId: created.id as string,
    attachmentIds: input.body.attachmentIds,
    actor: { uid: input.actor.uid },
  });

  const transfer = { ...toApi(created as Record<string, unknown>), attachments };

  // Finance is two roles, and a role broadcast reaches one role — so one row
  // each. branchId null: a finance user holds no branch claim and the
  // notifications RLS drops a broadcast whose branch does not match. Best
  // effort: the transfer is saved, and a failed notice must not turn a 201
  // into a 500 that the client would retry.
  const amount = transfer.amount.toLocaleString('en-PK');
  const method = CASH_TRANSFER_METHOD_LABELS[transfer.paymentMethod];
  for (const targetRole of ['finance_admin', 'finance_manager'] as const) {
    try {
      await notify({
        type: 'cash_transfer',
        title: 'Cash Transfer Submitted',
        message: `${branch.name} sent Rs. ${amount} by ${method} (${transfer.transferNo}) — awaiting approval`,
        targetRole,
        branchId: null,
        relatedId: transfer.id,
      });
    } catch (err) {
      console.error('[cash-transfers] notify failed', err);
    }
  }

  return transfer;
}

// ---------------------------------------------------------------------------
// Review (Finance)
// ---------------------------------------------------------------------------

export interface CashTransferActor {
  uid: string;
  name: string;
}

/**
 * Approve: one RPC, one transaction — the receipt is posted and the transfer
 * marked in the same statement, so the book and the record cannot disagree.
 * Returns the transfer and the RV- entry it became.
 */
export async function approveCashTransfer(
  id: string,
  actor: CashTransferActor,
  note?: string | null,
): Promise<{ transfer: CashTransfer; ledgerEntry: LedgerEntry | null }> {
  const { data, error } = await supabaseAdmin.rpc('approve_cash_transfer', {
    p_id: id,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_today: businessDateStr(),
    p_note: note ?? null,
  });
  if (error) throw asClientError(error);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw Object.assign(new Error('Cash transfer not found'), { status: 404 });

  const [attachments, ledgerEntry] = await Promise.all([
    listAttachments('cash_transfer', id),
    row['ledger_entry_id'] ? getLedgerEntry(String(row['ledger_entry_id'])) : Promise.resolve(null),
  ]);
  const transfer = { ...toApi(row), attachments };

  await notifyBranch(transfer, 'approved');
  return { transfer, ledgerEntry };
}

export async function rejectCashTransfer(
  id: string,
  actor: CashTransferActor,
  reason: string,
): Promise<CashTransfer> {
  const { data, error } = await supabaseAdmin.rpc('reject_cash_transfer', {
    p_id: id,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_reason: reason,
  });
  if (error) throw asClientError(error);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw Object.assign(new Error('Cash transfer not found'), { status: 404 });

  const transfer = { ...toApi(row), attachments: await listAttachments('cash_transfer', id) };
  await notifyBranch(transfer, 'rejected');
  return transfer;
}

/** Tell the branch. Best effort: the decision is committed before this runs. */
async function notifyBranch(transfer: CashTransfer, decision: 'approved' | 'rejected'): Promise<void> {
  const amount = transfer.amount.toLocaleString('en-PK');
  const message =
    decision === 'approved'
      ? `${transfer.transferNo} for Rs. ${amount} was approved — receipt ${transfer.voucherNo ?? ''}`.trim()
      : `${transfer.transferNo} for Rs. ${amount} was rejected: ${transfer.rejectionReason ?? ''}`.trim();
  try {
    await notify({
      type: 'cash_transfer_reviewed',
      title: decision === 'approved' ? 'Cash Transfer Approved' : 'Cash Transfer Rejected',
      message,
      targetRole: 'branch_manager',
      branchId: transfer.branchId,
      relatedId: transfer.id,
    });
  } catch (err) {
    console.error('[cash-transfers] notify failed', err);
  }
}

// ---------------------------------------------------------------------------
// The production slip's "Payment Received"
// ---------------------------------------------------------------------------

/**
 * Approved transfers a branch made in one billing window: after the previous
 * order was placed, up to and including this one — the SAME window
 * previous-balance.service.ts uses for returns and discounts, so each transfer
 * lands on exactly one slip. 'approved' only: a pending transfer is money
 * Finance has not yet confirmed, and a rejected one never arrived.
 *
 * Read-only and additive. The caller displays the sum; it does not subtract
 * it from anything.
 */
export async function paymentsReceivedInWindow(
  branchId: string,
  afterTs: string,
  untilTs: string,
): Promise<{ paymentItems: PaymentReceivedItem[]; paymentsReceivedValue: number }> {
  // A transfer deleted through the Help Desk had its receipt reversed and
  // must drop out of the slip's figure too.
  const { data, error } = await withoutDeleted(
    supabaseAdmin
      .from('cash_transfers')
      .select('id, transfer_no, voucher_no, business_date, payment_method, amount'),
  )
    .eq('branch_id', branchId)
    .eq('status', 'approved')
    .gt('created_at', afterTs)
    .lte('created_at', untilTs)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const paymentItems: PaymentReceivedItem[] = ((data ?? []) as {
    id: string;
    transfer_no: string;
    voucher_no: string | null;
    business_date: string;
    payment_method: CashTransferMethod;
    amount: number | string;
  }[]).map((r) => ({
    transferId: r.id,
    transferNo: r.transfer_no,
    voucherNo: r.voucher_no,
    date: r.business_date,
    paymentMethod: r.payment_method,
    amount: Number(r.amount ?? 0),
  }));

  return {
    paymentItems,
    paymentsReceivedValue: paymentItems.reduce((a, p) => a + p.amount, 0),
  };
}
