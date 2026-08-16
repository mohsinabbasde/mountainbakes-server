import { supabaseAdmin } from '../config/supabase';
import {
  DEFAULT_FINANCE_SETTINGS,
  SYSTEM_LEDGER_HEAD_CODES,
  resolveShareSplit,
  type FinanceSettings,
  type FinanceAccount,
  type ShareSplit,
  type UpdateFinanceSettingsInput,
} from '../shared';
import { getCached, setCached, invalidate } from '../utils/cache';
import { rowToApi } from '../utils/case';

const CACHE_KEY = 'financeSettings';
const TABLE = 'finance_settings';

/**
 * Finance Ledger configuration — one row, read on nearly every request.
 *
 * Mirrors settings.service.ts deliberately, including the numeric coercion: the
 * share percentages and opening balances are `numeric` columns, and PostgREST
 * serialises every numeric as a STRING. Left uncoerced, `companySharePct` would
 * arrive as "75.00" and `amount * pct / 100` would produce a string-concatenated
 * NaN — a share split that silently posts nothing. See the long note on
 * `coerceToDefaultType` in settings.service.ts; this is the same trap on money
 * that actually moves.
 */

const NUMERIC_FIELDS = new Set<keyof FinanceSettings>([
  'companySharePct',
  'branchSharePct',
  'openingCashBalance',
  'openingBankBalance',
]);

export async function getFinanceSettings(): Promise<FinanceSettings> {
  const hit = getCached<FinanceSettings>(CACHE_KEY);
  if (hit) return hit;

  const { data, error } = await supabaseAdmin.from(TABLE).select('*').maybeSingle();
  if (error) throw new Error(`Failed to load finance settings: ${error.message}`);

  const row = rowToApi<Partial<FinanceSettings>>(data ?? {});
  const settings: FinanceSettings = {
    ...DEFAULT_FINANCE_SETTINGS,
    openingBalanceDate: null,
    updatedAt: '',
    updatedBy: '',
    ...stripNulls(row),
  };

  for (const field of NUMERIC_FIELDS) {
    (settings as unknown as Record<string, unknown>)[field] = Number(settings[field] ?? 0);
  }

  setCached(CACHE_KEY, settings);
  return settings;
}

// ---------------------------------------------------------------------------
// Per-branch share split
// ---------------------------------------------------------------------------

/**
 * Resolve the company/branch split for one branch.
 *
 * `branches.company_share_pct` overrides the global setting; NULL inherits it
 * (migration 68). Every posting path that splits a branch's collection resolves
 * it through here rather than reading `settings.companySharePct` directly —
 * that read is what this feature exists to replace, and one straggler would
 * post a share the branch was never on.
 */
export async function getBranchShareSplit(branchId: string): Promise<ShareSplit> {
  const [settings, { data, error }] = await Promise.all([
    getFinanceSettings(),
    supabaseAdmin.from('branches').select('company_share_pct').eq('id', branchId).maybeSingle(),
  ]);
  if (error) throw error;
  // PostgREST serialises numeric as a STRING; resolveShareSplit coerces, but a
  // missing branch must fall back rather than resolve to a 0% company share.
  return resolveShareSplit(
    data ? (data['company_share_pct'] as number | null) : null,
    settings.companySharePct,
  );
}

/**
 * The same resolution for many branches in one round trip.
 *
 * `importBranchIncome` walks every active branch, so a per-branch query there
 * would be one extra round trip per branch per import. Branch ids not present in
 * the map simply inherit — callers should treat a miss as `resolveShareSplit(null, …)`.
 */
export async function getBranchShareSplits(branchIds: string[]): Promise<Map<string, ShareSplit>> {
  const settings = await getFinanceSettings();
  const out = new Map<string, ShareSplit>();
  if (branchIds.length === 0) return out;

  const { data, error } = await supabaseAdmin
    .from('branches')
    .select('id, company_share_pct')
    .in('id', branchIds);
  if (error) throw error;

  const overrideById = new Map(
    ((data ?? []) as Record<string, unknown>[]).map((r) => [r['id'] as string, r['company_share_pct'] as number | null]),
  );
  for (const id of branchIds) {
    out.set(id, resolveShareSplit(overrideById.get(id) ?? null, settings.companySharePct));
  }
  return out;
}

/** Postgres returns unset columns as null, which would clobber a default. */
function stripNulls<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Apply a settings patch, then reconcile the book's opening balance.
 *
 * The opening balance is not a number the ledger reads at query time — it is a
 * real posted entry (source_type 'opening'). That is what keeps `balance`
 * self-consistent: the running balance starts at zero and every rupee in it
 * came from a voucher, including the first one. So changing the configured
 * opening balance does not rewrite history; it posts the DIFFERENCE as a fresh
 * opening voucher, exactly as an accountant would.
 *
 * Returns the settings plus whatever was posted, so the caller can audit it.
 */
export async function updateFinanceSettings(
  patch: UpdateFinanceSettingsInput,
  actor: { uid: string; name: string },
  businessDate: string,
): Promise<{ settings: FinanceSettings; previous: FinanceSettings; postedVouchers: string[] }> {
  const previous = await getFinanceSettings();

  const row: Record<string, unknown> = {};
  if (patch.companySharePct !== undefined) row['company_share_pct'] = patch.companySharePct;
  if (patch.branchSharePct !== undefined) row['branch_share_pct'] = patch.branchSharePct;
  if (patch.shareBasis !== undefined) row['share_basis'] = patch.shareBasis;
  if (patch.openingCashBalance !== undefined) row['opening_cash_balance'] = patch.openingCashBalance;
  if (patch.openingBankBalance !== undefined) row['opening_bank_balance'] = patch.openingBankBalance;
  if (patch.openingBalanceDate !== undefined) row['opening_balance_date'] = patch.openingBalanceDate;
  if (patch.autoImportBranchIncome !== undefined) row['auto_import_branch_income'] = patch.autoImportBranchIncome;
  if (patch.requireAdminVerification !== undefined) row['require_admin_verification'] = patch.requireAdminVerification;
  if (patch.allowSuperAdminWrite !== undefined) row['allow_super_admin_write'] = patch.allowSuperAdminWrite;

  row['updated_at'] = new Date().toISOString();
  row['updated_by'] = actor.name;

  const { error } = await supabaseAdmin.from(TABLE).update(row).eq('id', true);
  if (error) throw error;
  invalidate(CACHE_KEY);

  const postedVouchers: string[] = [];
  const openingDate = patch.openingBalanceDate ?? previous.openingBalanceDate ?? businessDate;

  for (const [account, next, prior] of [
    ['cash', patch.openingCashBalance, previous.openingCashBalance],
    ['bank', patch.openingBankBalance, previous.openingBankBalance],
  ] as [FinanceAccount, number | undefined, number][]) {
    if (next === undefined) continue;
    const delta = round2(next - prior);
    if (delta === 0) continue;
    const voucher = await postOpeningBalance(account, delta, openingDate, actor);
    if (voucher) postedVouchers.push(voucher);
  }

  return { settings: await getFinanceSettings(), previous, postedVouchers };
}

/**
 * Post an opening-balance adjustment of `delta` for one account.
 *
 * A negative delta is a credit — reducing a previously overstated opening
 * balance is money leaving the book, and the cash-book convention has no notion
 * of a negative debit.
 *
 * Best-effort by design: if the opening date has already been closed, the
 * posting function refuses it and the settings change still stands. Returning
 * null rather than throwing keeps a bookkeeping correction from failing an
 * otherwise valid settings save; the caller records the outcome in the audit
 * trail either way.
 */
async function postOpeningBalance(
  account: FinanceAccount,
  delta: number,
  entryDate: string,
  actor: { uid: string; name: string },
): Promise<string | null> {
  const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.OPENING_BALANCE);

  const { data, error } = await supabaseAdmin.rpc('post_finance_ledger_entry', {
    p_entry_date: entryDate,
    p_ledger_head_id: head.id,
    p_description: `Opening balance (${account}) set to ${delta > 0 ? '+' : ''}${delta}`,
    p_debit: delta > 0 ? delta : 0,
    p_credit: delta < 0 ? Math.abs(delta) : 0,
    p_account: account,
    p_source_type: 'opening',
    p_source_id: null,
    p_branch_id: null,
    p_branch_name: null,
    p_payment_method: account === 'bank' ? 'bank_transfer' : 'cash',
    p_approved_by: actor.uid,
    p_approved_by_name: actor.name,
    p_created_by: actor.uid,
    p_created_by_name: actor.name,
    p_reverses_entry_id: null,
  });

  if (error) {
    console.error('[finance] opening balance could not be posted:', error.message);
    return null;
  }
  const entry = rowToApi<{ voucherNo?: string }>(data);
  return entry.voucherNo ?? null;
}

/**
 * Resolve a ledger head by its stable code.
 *
 * Every automatic posting goes through here rather than hardcoding a uuid,
 * because the uuids are generated per environment — a hardcoded one works on
 * exactly the database it was copied from.
 */
export async function getLedgerHeadByCode(code: string): Promise<{ id: string; name: string }> {
  const cacheKey = `financeHead:${code}`;
  const hit = getCached<{ id: string; name: string }>(cacheKey);
  if (hit) return hit;

  const { data, error } = await supabaseAdmin
    .from('ledger_heads')
    .select('id, name')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `Ledger head "${code}" is missing. It is seeded by migration 52 and the finance ` +
        `postings resolve it by code — apply the pending migrations (supabase db push).`,
    );
  }
  const head = { id: data.id as string, name: data.name as string };
  setCached(cacheKey, head, 5 * 60_000);
  return head;
}

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
