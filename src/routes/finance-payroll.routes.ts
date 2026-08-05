import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveSchema,
  CreateEmployeeSchema,
  CreateSalaryPaymentSchema,
  RejectSchema,
  UpdateEmployeeSchema,
  UpdateSalaryPaymentSchema,
  type FinanceDocStatus,
} from '../shared';
import {
  approveSalaryPayment,
  createEmployee,
  createSalaryPayment,
  getSalaryPayment,
  listEmployees,
  listSalaryPayments,
  rejectSalaryPayment,
  submitSalaryPayment,
  updateEmployee,
  updateSalaryPayment,
} from '../services/finance-payroll.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';

/**
 * /api/finance/payroll — the employee master and the salary ledger.
 *
 * Employees are `configure`-level: adding someone to the payroll master is a
 * standing commitment, not a per-transaction act, and it belongs with the other
 * things only a Finance Admin sets up. Individual payslips are `create` /
 * `approve` like every other document.
 */

export const router = Router();

router.use(authenticate);

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

router.get('/employees', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const employees = await listEmployees({
      department: (req.query['department'] as string) || undefined,
      includeInactive: req.query['includeInactive'] === 'true',
      search: (req.query['search'] as string) || undefined,
    });
    res.json({ employees, total: employees.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/employees',
  requireFinance('configure'),
  validate(CreateEmployeeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const employee = await createEmployee(req.body);
      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: employee.id,
        entityRef: employee.employeeCode,
        action: 'created',
        newValues: auditSnapshot(employee as unknown as Record<string, unknown>, [
          'name', 'department', 'designation', 'baseSalary', 'branchName',
        ]),
      });
      res.status(201).json({ employee });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/employees/:id',
  requireFinance('configure'),
  validate(UpdateEmployeeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = (await listEmployees({ includeInactive: true })).find((e) => e.id === id);
      const employee = await updateEmployee(id, req.body);

      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: id,
        entityRef: employee.employeeCode,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['name', 'department', 'designation', 'baseSalary', 'isActive'])
          : null,
        newValues: auditSnapshot(employee as unknown as Record<string, unknown>, ['name', 'department', 'designation', 'baseSalary', 'isActive']),
      });

      res.json({ employee });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Salary payments
// ---------------------------------------------------------------------------

router.get('/salaries', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const salaries = await listSalaryPayments({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      salaryMonth: q['salaryMonth'],
      employeeId: q['employeeId'],
      department: q['department'],
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
    });
    res.json({ salaries, total: salaries.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/salaries',
  requireFinance('create'),
  validate(CreateSalaryPaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const salary = await createSalaryPayment(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: salary.id,
        entityRef: salary.salaryNo,
        action: 'created',
        newValues: auditSnapshot(salary as unknown as Record<string, unknown>, [
          'employeeName', 'salaryMonth', 'grossSalary', 'bonus', 'deductions', 'netSalary', 'status',
        ]),
      });
      res.status(201).json({ salary });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/salaries/:id',
  requireFinance('create'),
  validate(UpdateSalaryPaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getSalaryPayment(id);
      const salary = await updateSalaryPayment(id, req.body);

      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: id,
        entityRef: salary.salaryNo,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['grossSalary', 'bonus', 'deductions', 'netSalary', 'paymentDate', 'status'])
          : null,
        newValues: auditSnapshot(salary as unknown as Record<string, unknown>, ['grossSalary', 'bonus', 'deductions', 'netSalary', 'paymentDate', 'status']),
      });

      res.json({ salary });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/salaries/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const salary = await submitSalaryPayment(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'salary_payment',
      entityId: salary.id,
      entityRef: salary.salaryNo,
      action: 'submitted',
      newValues: { netSalary: salary.netSalary, status: salary.status },
    });
    res.json({ salary });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/salaries/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entry } = await approveSalaryPayment(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: document.id,
        entityRef: document.salaryNo,
        action: 'approved',
        newValues: {
          employeeName: document.employeeName,
          salaryMonth: document.salaryMonth,
          netSalary: document.netSalary,
          voucherNo: entry.voucherNo,
        },
      });
      res.json({ salary: document, ledgerEntry: entry });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/salaries/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const salary = await rejectSalaryPayment(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: salary.id,
        entityRef: salary.salaryNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, employeeName: salary.employeeName, netSalary: salary.netSalary },
      });
      res.json({ salary });
    } catch (err) {
      next(err);
    }
  },
);
