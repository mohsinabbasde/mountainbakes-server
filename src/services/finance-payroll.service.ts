import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  SYSTEM_LEDGER_HEAD_CODES,
  type CreateEmployeeInput,
  type CreateSalaryPaymentInput,
  type CreateSalaryRevisionInput,
  type FinanceDocStatus,
  type FinanceEmployee,
  type LedgerEntry,
  type SalaryPayment,
  type SalaryRevision,
  type UpdateEmployeeInput,
  type UpdateSalaryPaymentInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { approveDocument, rejectDocument } from './finance-documents.service';
import { getLedgerHeadByCode, round2 } from './finance-settings.service';

/**
 * Payroll — the employee master and the salary ledger.
 *
 * `finance_employees` is deliberately not `users`: `users` is the set of people
 * who can SIGN IN, and most of a bakery's payroll cannot. Tying the two together
 * would mean provisioning an auth account for every baker just to pay them.
 *
 * Salary payments post to the single system head EXP-SALARIES, so the Profit &
 * Loss shows one payroll line rather than one line per employee; the per-person
 * detail lives on the Salary Report, which reads the salary rows themselves.
 */

const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function listEmployees(opts: {
  department?: string;
  includeInactive?: boolean;
  search?: string;
}): Promise<FinanceEmployee[]> {
  let query = supabaseAdmin
    .from('finance_employees')
    .select('*')
    .order('department', { ascending: true })
    .order('name', { ascending: true });

  if (!opts.includeInactive) query = query.eq('is_active', true);
  if (opts.department) query = query.eq('department', opts.department);
  if (opts.search) {
    const term = opts.search.replace(/[,()*]/g, ' ').trim();
    if (term) query = query.or(`name.ilike.%${term}%,employee_code.ilike.%${term}%,designation.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  const employees = rowToApi<FinanceEmployee[]>(data ?? []).map((e) => ({
    ...e,
    baseSalary: num(e.baseSalary),
    pendingRevision: null as FinanceEmployee['pendingRevision'],
  }));
  return applyEffectiveSalary(employees);
}

/**
 * Resolves each employee's `baseSalary` to what's actually effective TODAY —
 * the latest salary_revisions row with `effective_from <= today`, falling
 * back to the raw `finance_employees.base_salary` column for an employee with
 * no revisions yet. Also surfaces the next not-yet-effective revision, if any,
 * as `pendingRevision` so the UI can show "salary changes to X on Y".
 *
 * One batched query rather than N+1: a bakery's payroll is small, but there is
 * no reason to make it linear in request count.
 */
async function applyEffectiveSalary(employees: FinanceEmployee[]): Promise<FinanceEmployee[]> {
  if (employees.length === 0) return employees;

  const { data, error } = await supabaseAdmin
    .from('salary_revisions')
    .select('employee_id, new_salary, effective_from, reason')
    .in('employee_id', employees.map((e) => e.id))
    .order('effective_from', { ascending: true });
  if (error) throw error;

  const byEmployee = new Map<string, { effectiveFrom: string; newSalary: number; reason: string }[]>();
  for (const row of data ?? []) {
    const key = row['employee_id'] as string;
    const list = byEmployee.get(key) ?? [];
    list.push({
      effectiveFrom: row['effective_from'] as string,
      newSalary: num(row['new_salary']),
      reason: row['reason'] as string,
    });
    byEmployee.set(key, list);
  }

  const today = businessDateStr();
  return employees.map((e) => {
    const revisions = byEmployee.get(e.id) ?? [];
    let baseSalary = e.baseSalary;
    let pendingRevision: FinanceEmployee['pendingRevision'] = null;
    // Ascending order: the last one <= today is the current figure; the first
    // one > today (if any) is the next scheduled change.
    for (const r of revisions) {
      if (r.effectiveFrom <= today) baseSalary = r.newSalary;
      else if (!pendingRevision) pendingRevision = { newSalary: r.newSalary, effectiveFrom: r.effectiveFrom, reason: r.reason };
    }
    return { ...e, baseSalary, pendingRevision };
  });
}

export async function createEmployee(input: CreateEmployeeInput): Promise<FinanceEmployee> {
  const branch = await resolveBranch(input.branchId);
  const { data, error } = await supabaseAdmin
    .from('finance_employees')
    .insert({
      name: input.name,
      department: input.department,
      designation: input.designation,
      branch_id: branch?.id ?? null,
      branch_name: branch?.name ?? null,
      base_salary: round2(input.baseSalary),
      phone: input.phone ?? null,
      joined_on: input.joinedOn ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return { ...rowToApi<FinanceEmployee>(data), pendingRevision: null };
}

export async function updateEmployee(id: string, input: UpdateEmployeeInput): Promise<FinanceEmployee> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row['name'] = input.name;
  if (input.department !== undefined) row['department'] = input.department;
  if (input.designation !== undefined) row['designation'] = input.designation;
  if (input.phone !== undefined) row['phone'] = input.phone;
  if (input.joinedOn !== undefined) row['joined_on'] = input.joinedOn;
  if (input.isActive !== undefined) row['is_active'] = input.isActive;
  if (input.branchId !== undefined) {
    const branch = await resolveBranch(input.branchId);
    row['branch_id'] = branch?.id ?? null;
    row['branch_name'] = branch?.name ?? null;
  }

  const { data, error } = await supabaseAdmin
    .from('finance_employees')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  const employee = rowToApi<FinanceEmployee>(data);
  const [resolved] = await applyEffectiveSalary([
    { ...employee, baseSalary: num(employee.baseSalary), pendingRevision: null },
  ]);
  return resolved!;
}

/**
 * Record a base-salary change with a reason and an effective date.
 *
 * Never touches `finance_employees.base_salary` directly — the effective
 * figure is always resolved on read (`applyEffectiveSalary`), whether this
 * revision lands today or on a future date. That is what keeps an
 * already-created payslip's `gross_salary` untouched no matter when a raise
 * is recorded or when it takes effect.
 */
export async function reviseEmployeeSalary(
  employeeId: string,
  input: CreateSalaryRevisionInput,
  actor: { uid: string; name: string },
): Promise<{ employee: FinanceEmployee; revision: SalaryRevision }> {
  const { data: empRow, error: empErr } = await supabaseAdmin
    .from('finance_employees')
    .select('*')
    .eq('id', employeeId)
    .maybeSingle();
  if (empErr) throw empErr;
  if (!empRow) throw Object.assign(new Error('Employee not found'), { status: 404 });

  const employee = rowToApi<FinanceEmployee>(empRow);
  const [current] = await applyEffectiveSalary([
    { ...employee, baseSalary: num(employee.baseSalary), pendingRevision: null },
  ]);

  const { data: revRow, error: revErr } = await supabaseAdmin
    .from('salary_revisions')
    .insert({
      employee_id: employeeId,
      employee_name: employee.name,
      previous_salary: current!.baseSalary,
      new_salary: round2(input.newSalary),
      reason: input.reason,
      effective_from: input.effectiveFrom,
      changed_by: actor.uid,
      changed_by_name: actor.name,
    })
    .select('*')
    .single();
  if (revErr) throw revErr;

  const [updated] = await applyEffectiveSalary([
    { ...employee, baseSalary: num(employee.baseSalary), pendingRevision: null },
  ]);

  return {
    employee: updated!,
    revision: normaliseRevision(rowToApi<SalaryRevision>(revRow)),
  };
}

function normaliseRevision(r: SalaryRevision): SalaryRevision {
  return { ...r, previousSalary: num(r.previousSalary), newSalary: num(r.newSalary) };
}

export async function listSalaryRevisions(employeeId: string): Promise<SalaryRevision[]> {
  const { data, error } = await supabaseAdmin
    .from('salary_revisions')
    .select('*')
    .eq('employee_id', employeeId)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return rowToApi<SalaryRevision[]>(data ?? []).map(normaliseRevision);
}

// ---------------------------------------------------------------------------
// Salary payments
// ---------------------------------------------------------------------------

export interface SalaryQuery {
  status?: FinanceDocStatus | 'pending';
  salaryMonth?: string;
  employeeId?: string;
  department?: string;
  search?: string;
  limit?: number;
}

export async function listSalaryPayments(q: SalaryQuery): Promise<SalaryPayment[]> {
  let query = supabaseAdmin
    .from('salary_payments')
    .select('*')
    .order('salary_month', { ascending: false })
    .order('employee_name', { ascending: true })
    .limit(Math.min(Math.max(Number(q.limit ?? 300), 1), 1000));

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.salaryMonth) query = query.eq('salary_month', q.salaryMonth);
  if (q.employeeId) query = query.eq('employee_id', q.employeeId);
  if (q.department) query = query.eq('department', q.department);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) query = query.or(`salary_no.ilike.%${term}%,employee_name.ilike.%${term}%,designation.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<SalaryPayment[]>(data ?? []).map(normalise);
}

function normalise(s: SalaryPayment): SalaryPayment {
  return {
    ...s,
    grossSalary: num(s.grossSalary),
    bonus: num(s.bonus),
    deductions: num(s.deductions),
    netSalary: num(s.netSalary),
  };
}

export async function getSalaryPayment(id: string): Promise<SalaryPayment | null> {
  const { data, error } = await supabaseAdmin.from('salary_payments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? normalise(rowToApi<SalaryPayment>(data)) : null;
}

export async function createSalaryPayment(
  input: CreateSalaryPaymentInput,
  actor: { uid: string; name: string },
): Promise<SalaryPayment> {
  const { data: employee, error: empErr } = await supabaseAdmin
    .from('finance_employees')
    .select('id, name, department, designation, is_active')
    .eq('id', input.employeeId)
    .maybeSingle();
  if (empErr) throw empErr;
  if (!employee) throw Object.assign(new Error('Employee not found'), { status: 404 });
  if (!employee.is_active) {
    throw Object.assign(new Error(`${employee.name} is not an active employee.`), { status: 400 });
  }

  const netSalary = round2(input.grossSalary + input.bonus - input.deductions);

  const { data, error } = await supabaseAdmin
    .from('salary_payments')
    .insert({
      employee_id: employee.id,
      // Snapshots: a promotion next year must not restate this month's payslip.
      employee_name: employee.name,
      department: employee.department,
      designation: employee.designation,
      salary_month: input.salaryMonth,
      gross_salary: round2(input.grossSalary),
      bonus: round2(input.bonus),
      deductions: round2(input.deductions),
      net_salary: netSalary,
      payment_date: input.paymentDate ?? null,
      payment_method: input.paymentMethod,
      account: input.account,
      status: input.asDraft ? 'draft' : 'pending_approval',
      notes: input.notes ?? null,
      created_by: actor.uid,
      created_by_name: actor.name,
    })
    .select('*')
    .single();

  if (error) {
    // The partial unique index on (employee_id, salary_month) is what makes
    // paying the same person twice for the same month impossible.
    if (error.code === '23505') {
      throw Object.assign(
        new Error(`${employee.name} already has a salary record for ${input.salaryMonth}.`),
        { status: 409 },
      );
    }
    throw error;
  }
  return normalise(rowToApi<SalaryPayment>(data));
}

export async function updateSalaryPayment(id: string, input: UpdateSalaryPaymentInput): Promise<SalaryPayment> {
  const current = await getSalaryPayment(id);
  if (!current) throw Object.assign(new Error('Salary record not found'), { status: 404 });
  if (!EDITABLE_DOC_STATUSES.includes(current.status)) {
    throw Object.assign(
      new Error(`${current.salaryNo} is ${current.status} and can no longer be edited.`),
      { status: 409 },
    );
  }

  const gross = input.grossSalary ?? current.grossSalary;
  const bonus = input.bonus ?? current.bonus;
  const deductions = input.deductions ?? current.deductions;
  const netSalary = round2(gross + bonus - deductions);
  if (netSalary <= 0) {
    throw Object.assign(new Error('Deductions cannot exceed salary plus bonus.'), { status: 400 });
  }

  const row: Record<string, unknown> = {
    gross_salary: round2(gross),
    bonus: round2(bonus),
    deductions: round2(deductions),
    net_salary: netSalary,
  };
  if (input.paymentDate !== undefined) row['payment_date'] = input.paymentDate;
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.notes !== undefined) row['notes'] = input.notes;
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await supabaseAdmin
    .from('salary_payments')
    .update(row)
    .eq('id', id)
    .in('status', EDITABLE_DOC_STATUSES)
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<SalaryPayment>(data));
}

export async function submitSalaryPayment(id: string): Promise<SalaryPayment> {
  const { data, error } = await supabaseAdmin
    .from('salary_payments')
    .update({ status: 'pending_approval', rejection_reason: null })
    .eq('id', id)
    .in('status', ['draft', 'rejected'])
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected salary record can be submitted.'), { status: 409 });
  return normalise(rowToApi<SalaryPayment>(data));
}

/**
 * Approve a payslip and post it.
 *
 * The ledger date is the payment date when one is set, otherwise the current
 * business date — a salary is booked when it is PAID, not when the payroll run
 * was keyed in, and the two are routinely different days.
 */
export async function approveSalaryPayment(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: SalaryPayment; entry: LedgerEntry }> {
  const doc = await getSalaryPayment(id);
  if (!doc) throw Object.assign(new Error('Salary record not found'), { status: 404 });

  const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.SALARIES);

  const entry = await approveDocument({
    table: 'salary_payments',
    id,
    ref: doc.salaryNo,
    status: doc.status,
    actor,
    notes,
    posting: {
      entryDate: doc.paymentDate ?? businessDateStr(),
      ledgerHeadId: head.id,
      headType: 'expense',
      description: `Salary ${doc.salaryMonth} — ${doc.employeeName}`,
      amount: doc.netSalary,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: null,
      branchName: null,
      sourceType: 'salary',
    },
  });

  // Stamp the payment date if the approver did not set one — the ledger now
  // says the money moved today, and the payslip must agree with it.
  if (!doc.paymentDate) {
    await supabaseAdmin.from('salary_payments').update({ payment_date: entry.entryDate }).eq('id', id);
  }

  return { document: (await getSalaryPayment(id))!, entry };
}

export async function rejectSalaryPayment(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<SalaryPayment> {
  await rejectDocument('salary_payments', id, reason, actor);
  return (await getSalaryPayment(id))!;
}

async function resolveBranch(branchId?: string | null): Promise<{ id: string; name: string } | null> {
  if (!branchId) return null;
  const { data, error } = await supabaseAdmin.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id as string, name: data.name as string } : null;
}
