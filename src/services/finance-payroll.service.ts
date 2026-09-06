import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  SYSTEM_LEDGER_HEAD_CODES,
  type CreateEmployeeAdvanceInput,
  type CreateEmployeeInput,
  type CreateSalaryPaymentInput,
  type CreateSalaryRevisionInput,
  type EmployeeAdvance,
  type EmployeeAdvanceSummary,
  type FinanceDocStatus,
  type FinanceEmployee,
  type LedgerEntry,
  type SalaryPayment,
  type SalaryRevision,
  type UpdateEmployeeAdvanceInput,
  type UpdateEmployeeInput,
  type UpdateSalaryPaymentInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
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
 *
 * Employee advances (bottom of the file) post to the SAME head, and that is what
 * makes the arithmetic come out: an advance books the cash when it leaves, and
 * the payslip that recovers it books only the net. Splitting them onto a
 * separate head would state payroll twice on the way in and negative on the way
 * out. See migration 87.
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
  let query = withoutDeleted(
    supabaseAdmin
      .from('salary_payments')
      .select('*')
      .order('salary_month', { ascending: false })
      .order('employee_name', { ascending: true })
      .limit(Math.min(Math.max(Number(q.limit ?? 300), 1), 1000)),
  );

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

  const rows = rowToApi<SalaryPayment[]>(data ?? []).map(normalise);
  const photos = await listAttachmentsFor(
    'salary_payment',
    rows.map((s) => s.id),
  );
  return rows.map((s) => ({ ...s, attachments: photos.get(s.id) ?? [] }));
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
  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('salary_payments').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...normalise(rowToApi<SalaryPayment>(data)),
    attachments: await listAttachments('salary_payment', id),
  };
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

  const salary = normalise(rowToApi<SalaryPayment>(data));

  // Claim the advances this payslip settles, BEFORE binding the photo — a
  // payslip that could not take the advances it was priced against is wrong by
  // exactly that amount, and must not exist.
  //
  // The claim cannot come first: `recovered_by_salary_id` is a foreign key, so
  // there is nothing to point at until the row is inserted. If it comes up short
  // (another payroll run took the same advance in between), the payslip is
  // deleted and the caller sees a 409. Deleting is safe here and nowhere else:
  // the row is seconds old, has no ledger entry, and has no photo bound yet.
  const claimed = await claimAdvancesForSalary(salary.id, employee.id, input.recoverAdvanceIds);
  if (claimed.length !== input.recoverAdvanceIds.length) {
    // The FK is ON DELETE SET NULL, so this releases whatever it did claim.
    //
    // A HARD delete, and deliberately not routed through the soft-delete path
    // migration 94 added: this is rolling back a row created a few statements
    // ago that no other request has been able to see. Stamping it instead would
    // leave a permanent "deleted salary payment" in the audit view for a payslip
    // that never existed, which is noise an auditor has to learn to ignore.
    await supabaseAdmin.from('salary_payments').delete().eq('id', salary.id);
    throw Object.assign(
      new Error(
        `Some of ${employee.name}'s advances were recovered by another payslip while this one was being saved. Reopen the form to pick up the current balance.`,
      ),
      { status: 409 },
    );
  }

  const attachments = await bindAttachments({
    entity: 'salary_payment',
    entityId: salary.id,
    attachmentIds: input.attachmentIds,
    actor,
  });
  return { ...salary, attachments };
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

  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('salary_payments').update(row).eq('id', id).in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .single();
  if (error) throw error;
  return normalise(rowToApi<SalaryPayment>(data));
}

export async function submitSalaryPayment(id: string): Promise<SalaryPayment> {
  const { data, error } = await withoutDeleted(
    supabaseAdmin
      .from('salary_payments')
      .update({ status: 'pending_approval', rejection_reason: null })
      .eq('id', id)
      .in('status', ['draft', 'rejected']),
  )
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
    await withoutDeleted(
      supabaseAdmin.from('salary_payments').update({ payment_date: entry.entryDate }).eq('id', id),
    );
  }

  // The advances this payslip claimed at creation are now actually recovered.
  // `recovered_at` is the narrower fact than the claim itself: the claim says a
  // payslip intends to deduct them, this says the deduction reached the book.
  // Left as a stamp on the existing claim rather than a fresh one, so approving
  // twice cannot double-count and a failure here cannot un-recover anything.
  const { error: recoverErr } = await withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .update({ recovered_at: new Date().toISOString() })
      .eq('recovered_by_salary_id', id)
      .is('recovered_at', null),
  );
  // The deduction is already in the posted figure, so a failure here costs a
  // timestamp, not money. Logged rather than thrown: the approval happened.
  if (recoverErr) console.error(`[finance] could not stamp advance recovery for ${doc.salaryNo}:`, recoverErr.message);

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

// ---------------------------------------------------------------------------
// Employee advances
//
// Money handed over between payslips: an advance against this month's salary, a
// bonus paid early, a loan, or any mix of the three in one handover. Same
// document lifecycle as a payslip, same head, and — the part worth reading
// carefully — a claim mechanism that stops the same money being deducted twice.
//
// AN ADVANCE IS "OUTSTANDING" when it has posted and no LIVE payslip has claimed
// it. `recovered_by_salary_id` alone is not enough to answer that, because a
// claim made by a payslip that was later REJECTED has to be released: the
// partial unique index on salary_payments exempts rejected rows precisely so a
// bad payslip can be replaced, and the replacement must be able to recover the
// same advances. So every read that cares resolves the claimer's status —
// `withRecovery` below is the one place that happens.
// ---------------------------------------------------------------------------

export interface AdvanceQuery {
  status?: FinanceDocStatus | 'pending';
  employeeId?: string;
  department?: string;
  from?: string;
  to?: string;
  /** The advances one payslip settled — what its Deduction figure is made of. */
  salaryId?: string;
  /** Posted advances no live payslip has claimed — what the next one recovers. */
  outstandingOnly?: boolean;
  search?: string;
  limit?: number;
}

function normaliseAdvance(a: EmployeeAdvance): EmployeeAdvance {
  return {
    ...a,
    advanceAmount: num(a.advanceAmount),
    bonusAmount: num(a.bonusAmount),
    loanAmount: num(a.loanAmount),
    totalAmount: num(a.totalAmount),
  };
}

/**
 * Resolve each row's claiming payslip and derive `isRecovered`.
 *
 * One batched query for the whole page rather than one per row, and the ONLY
 * place the rejected-claimer rule is implemented — anything that needs to know
 * whether an advance is still owed goes through here rather than reading
 * `recoveredBySalaryId` and drawing its own conclusion.
 */
async function withRecovery(rows: EmployeeAdvance[]): Promise<EmployeeAdvance[]> {
  const salaryIds = Array.from(
    new Set(rows.map((r) => r.recoveredBySalaryId).filter((id): id is string => Boolean(id))),
  );
  if (salaryIds.length === 0) {
    return rows.map((r) => ({ ...r, recoveredBySalaryNo: null, isRecovered: false }));
  }

  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('salary_payments').select('id, salary_no, status').in('id', salaryIds),
  );
  if (error) throw error;

  const byId = new Map(
    (data ?? []).map((r) => [
      r['id'] as string,
      { no: r['salary_no'] as string, status: r['status'] as FinanceDocStatus },
    ]),
  );

  return rows.map((r) => {
    const claimer = r.recoveredBySalaryId ? byId.get(r.recoveredBySalaryId) : undefined;
    return {
      ...r,
      recoveredBySalaryNo: claimer?.no ?? null,
      // A rejected claimer releases its hold; the advance is owed again.
      isRecovered: Boolean(claimer) && claimer!.status !== 'rejected',
    };
  });
}

export async function listEmployeeAdvances(q: AdvanceQuery): Promise<EmployeeAdvance[]> {
  let query = withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .select('*')
      .order('business_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(q.limit ?? 300), 1), 1000)),
  );

  if (q.outstandingOnly) query = query.in('status', ['posted', 'locked']);
  else if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);

  if (q.employeeId) query = query.eq('employee_id', q.employeeId);
  if (q.salaryId) query = query.eq('recovered_by_salary_id', q.salaryId);
  if (q.department) query = query.eq('department', q.department);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) query = query.or(`advance_no.ilike.%${term}%,employee_name.ilike.%${term}%,designation.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  let rows = await withRecovery(rowToApi<EmployeeAdvance[]>(data ?? []).map(normaliseAdvance));
  // Filtered here rather than in SQL: "unclaimed OR claimed by a rejected
  // payslip" spans two tables, and PostgREST cannot express the second half.
  if (q.outstandingOnly) rows = rows.filter((r) => !r.isRecovered);

  const photos = await listAttachmentsFor(
    'employee_advance',
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, attachments: photos.get(r.id) ?? [] }));
}

export async function getEmployeeAdvance(id: string): Promise<EmployeeAdvance | null> {
  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('employee_advances').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [resolved] = await withRecovery([normaliseAdvance(rowToApi<EmployeeAdvance>(data))]);
  return { ...resolved!, attachments: await listAttachments('employee_advance', id) };
}

/**
 * One employee's advance position — the "Previous payment" panel on the advance
 * form, and the figures the payslip form prefills its Bonus and Deduction from.
 *
 * Computed from the documents every time rather than kept as a running balance
 * on the employee row. A stored balance is a number that can disagree with the
 * advances behind it, and the first time it does, nobody can tell which of the
 * two is wrong.
 */
export async function getEmployeeAdvanceSummary(employeeId: string): Promise<EmployeeAdvanceSummary> {
  const { data: emp, error: empErr } = await supabaseAdmin
    .from('finance_employees')
    .select('id, name')
    .eq('id', employeeId)
    .maybeSingle();
  if (empErr) throw empErr;
  if (!emp) throw Object.assign(new Error('Employee not found'), { status: 404 });

  const { data, error } = await withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .select('*')
      .eq('employee_id', employeeId)
      .in('status', ['posted', 'locked'])
      .order('business_date', { ascending: true })
      .order('created_at', { ascending: true }),
  );
  if (error) throw error;

  const rows = await withRecovery(rowToApi<EmployeeAdvance[]>(data ?? []).map(normaliseAdvance));
  const outstandingRows = rows.filter((r) => !r.isRecovered);

  const sum = (list: EmployeeAdvance[], key: 'totalAmount' | 'bonusAmount') =>
    round2(list.reduce((t, r) => t + r[key], 0));

  const totalPaid = sum(rows, 'totalAmount');
  const outstanding = sum(outstandingRows, 'totalAmount');

  return {
    employeeId,
    employeeName: emp['name'] as string,
    totalPaid,
    totalRecovered: round2(totalPaid - outstanding),
    outstanding,
    outstandingBonus: sum(outstandingRows, 'bonusAmount'),
    advances: outstandingRows,
  };
}

export async function createEmployeeAdvance(
  input: CreateEmployeeAdvanceInput,
  actor: { uid: string; name: string },
): Promise<EmployeeAdvance> {
  const { data: employee, error: empErr } = await supabaseAdmin
    .from('finance_employees')
    .select('id, name, department, designation, is_active')
    .eq('id', input.employeeId)
    .maybeSingle();
  if (empErr) throw empErr;
  if (!employee) throw Object.assign(new Error('Employee not found'), { status: 404 });
  if (!employee['is_active']) {
    throw Object.assign(new Error(`${employee['name']} is not an active employee.`), { status: 400 });
  }

  const advanceAmount = round2(input.advanceAmount);
  const bonusAmount = round2(input.bonusAmount);
  const loanAmount = round2(input.loanAmount);
  // Rounded parts summed, not the sum rounded: the CHECK in migration 87
  // compares stored column to stored column, and 0.005 either way fails it.
  const totalAmount = round2(advanceAmount + bonusAmount + loanAmount);

  const { data, error } = await supabaseAdmin
    .from('employee_advances')
    .insert({
      employee_id: employee['id'],
      employee_name: employee['name'],
      department: employee['department'],
      designation: employee['designation'],
      business_date: input.businessDate ?? businessDateStr(),
      advance_amount: advanceAmount,
      bonus_amount: bonusAmount,
      loan_amount: loanAmount,
      total_amount: totalAmount,
      payment_method: input.paymentMethod,
      account: input.account,
      status: input.asDraft ? 'draft' : 'pending_approval',
      notes: input.notes ?? null,
      created_by: actor.uid,
      created_by_name: actor.name,
    })
    .select('*')
    .single();
  if (error) throw error;

  const [advance] = await withRecovery([normaliseAdvance(rowToApi<EmployeeAdvance>(data))]);
  const attachments = await bindAttachments({
    entity: 'employee_advance',
    entityId: advance!.id,
    attachmentIds: input.attachmentIds,
    actor,
  });
  return { ...advance!, attachments };
}

export async function updateEmployeeAdvance(
  id: string,
  input: UpdateEmployeeAdvanceInput,
): Promise<EmployeeAdvance> {
  const current = await getEmployeeAdvance(id);
  if (!current) throw Object.assign(new Error('Advance not found'), { status: 404 });
  if (!EDITABLE_DOC_STATUSES.includes(current.status)) {
    throw Object.assign(
      new Error(`${current.advanceNo} is ${current.status} and can no longer be edited.`),
      { status: 409 },
    );
  }

  // The "at least one amount" rule lives here rather than on the schema: a
  // payload carrying only `bonusAmount` says nothing about the two figures it is
  // not touching, so the rule can only be applied to the merged document.
  const advanceAmount = round2(input.advanceAmount ?? current.advanceAmount);
  const bonusAmount = round2(input.bonusAmount ?? current.bonusAmount);
  const loanAmount = round2(input.loanAmount ?? current.loanAmount);
  const totalAmount = round2(advanceAmount + bonusAmount + loanAmount);
  if (totalAmount <= 0) {
    throw Object.assign(new Error('Enter an advance, a bonus or a loan amount.'), { status: 400 });
  }

  const row: Record<string, unknown> = {
    advance_amount: advanceAmount,
    bonus_amount: bonusAmount,
    loan_amount: loanAmount,
    total_amount: totalAmount,
  };
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.notes !== undefined) row['notes'] = input.notes;
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await withoutDeleted(
    supabaseAdmin.from('employee_advances').update(row).eq('id', id).in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .single();
  if (error) throw error;
  const [advance] = await withRecovery([normaliseAdvance(rowToApi<EmployeeAdvance>(data))]);
  return advance!;
}

export async function submitEmployeeAdvance(id: string): Promise<EmployeeAdvance> {
  const { data, error } = await withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .update({ status: 'pending_approval', rejection_reason: null })
      .eq('id', id)
      .in('status', ['draft', 'rejected']),
  )
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected advance can be submitted.'), { status: 409 });
  const [advance] = await withRecovery([normaliseAdvance(rowToApi<EmployeeAdvance>(data))]);
  return advance!;
}

/**
 * Approve an advance and post it.
 *
 * Books the FULL `totalAmount` — bonus included — under EXP-SALARIES on the date
 * the money changed hands. The bonus is not held back for the payslip to book
 * later: it was handed over with the rest, and a cash book that says otherwise
 * is wrong about the till on the day it was counted.
 */
export async function approveEmployeeAdvance(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: EmployeeAdvance; entry: LedgerEntry }> {
  const doc = await getEmployeeAdvance(id);
  if (!doc) throw Object.assign(new Error('Advance not found'), { status: 404 });

  const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.SALARIES);

  const entry = await approveDocument({
    table: 'employee_advances',
    id,
    ref: doc.advanceNo,
    status: doc.status,
    actor,
    notes,
    posting: {
      entryDate: doc.businessDate,
      ledgerHeadId: head.id,
      headType: 'expense',
      description: `Advance to ${doc.employeeName} (${doc.advanceNo})`,
      amount: doc.totalAmount,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: null,
      branchName: null,
      sourceType: 'employee_advance',
    },
  });

  return { document: (await getEmployeeAdvance(id))!, entry };
}

export async function rejectEmployeeAdvance(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<EmployeeAdvance> {
  await rejectDocument('employee_advances', id, reason, actor);
  return (await getEmployeeAdvance(id))!;
}

/**
 * Point a set of advances at the payslip that recovers them.
 *
 * The update is CONDITIONAL — an advance is claimable only if it is posted, it
 * belongs to this employee, and it is either unclaimed or held by a payslip that
 * was rejected. Two payroll runs keyed at the same moment therefore cannot both
 * take the same advance: one update matches the row, the other does not, and the
 * caller sees the shortfall.
 *
 * Returns the ids actually claimed, which is always what the caller must check
 * against what it asked for.
 */
async function claimAdvancesForSalary(
  salaryId: string,
  employeeId: string,
  advanceIds: string[],
): Promise<string[]> {
  if (advanceIds.length === 0) return [];

  // Which of the currently-held ones are held by a rejected payslip, and so are
  // fair game. Resolved first because the filter below has to name them.
  const { data: held, error: heldErr } = await withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .select('recovered_by_salary_id')
      .in('id', advanceIds)
      .not('recovered_by_salary_id', 'is', null),
  );
  if (heldErr) throw heldErr;

  const heldBy = Array.from(
    new Set((held ?? []).map((r) => r['recovered_by_salary_id'] as string)),
  );
  let releasable: string[] = [];
  if (heldBy.length > 0) {
    const { data: claimers, error: claimerErr } = await withoutDeleted(
      supabaseAdmin.from('salary_payments').select('id, status').in('id', heldBy).eq('status', 'rejected'),
    );
    if (claimerErr) throw claimerErr;
    releasable = (claimers ?? []).map((r) => r['id'] as string);
  }

  let update = withoutDeleted(
    supabaseAdmin
      .from('employee_advances')
      .update({ recovered_by_salary_id: salaryId })
      .in('id', advanceIds)
      .eq('employee_id', employeeId)
      .in('status', ['posted', 'locked']),
  );

  update =
    releasable.length > 0
      ? update.or(`recovered_by_salary_id.is.null,recovered_by_salary_id.in.(${releasable.join(',')})`)
      : update.is('recovered_by_salary_id', null);

  const { data, error } = await update.select('id');
  if (error) throw error;
  return (data ?? []).map((r) => r['id'] as string);
}

async function resolveBranch(branchId?: string | null): Promise<{ id: string; name: string } | null> {
  if (!branchId) return null;
  const { data, error } = await supabaseAdmin.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id as string, name: data.name as string } : null;
}
