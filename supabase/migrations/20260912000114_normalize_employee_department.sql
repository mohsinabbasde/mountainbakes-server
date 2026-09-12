-- Normalize existing `finance_employees.department` values: trim whitespace,
-- collapse internal runs of whitespace, and canonicalize casing via
-- initcap() -- so "production", "Production " and "PRODUCTION" all become
-- one stored value. `department` is a free-text `<Input>`, not a fixed list
-- (see EmployeeForm), so without this a dropdown built from distinct employee
-- departments shows the same department more than once, and an exact filter
-- match can silently miss rows spelled with a different casing.
--
-- `createEmployee`/`updateEmployee` now normalize the same way on save (see
-- `normalizeDepartment()` in finance-payroll.service.ts), so this is a
-- one-time cleanup for rows written before that change, not an
-- every-deploy migration.
--
-- salary_payments and employee_advances each carry their OWN denormalized
-- snapshot of department (as of the transaction), so updating
-- finance_employees alone would leave historical rows disagreeing with
-- their own employee -- propagate the same canonical value to both, joined
-- by employee_id.
update finance_employees
set department = initcap(regexp_replace(trim(department), '\s+', ' ', 'g'))
where department is distinct from initcap(regexp_replace(trim(department), '\s+', ' ', 'g'));

update salary_payments sp
set department = fe.department
from finance_employees fe
where sp.employee_id = fe.id
  and sp.department is distinct from fe.department;

update employee_advances ea
set department = fe.department
from finance_employees fe
where ea.employee_id = fe.id
  and ea.department is distinct from fe.department;
