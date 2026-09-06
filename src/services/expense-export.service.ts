/**
 * Shape `expenses` rows into a flat sheet.
 *
 * Split out of the route so the column layout can be exercised on its own: the
 * Branch column is present for an admin and absent for a branch account, which
 * shifts every index after it — and the total has to land on the Amount column
 * either way.
 */

export interface ExpenseSheetRow {
  business_date?: string | null;
  expense_number?: string | null;
  branch_name?: string | null;
  category?: string | null;
  description?: string | null;
  payment_method?: string | null;
  amount?: number | string | null;
  remarks?: string | null;
  created_by_name?: string | null;
}

export interface ExpenseSheet {
  headers: string[];
  rows: (string | number)[][];
  total: number;
}

/** The API's two payment methods, title-cased. Anything else passes through as stored. */
function paymentLabel(method: string | null | undefined): string {
  if (method === 'cash') return 'Cash';
  if (method === 'easypaisa') return 'Easypaisa';
  return method ?? '';
}

/**
 * @param branchScoped the caller only ever sees their own branch, so the Branch
 *   column is dead weight — every row would repeat the same shop name.
 */
export function buildExpenseSheet(data: ExpenseSheetRow[], branchScoped: boolean): ExpenseSheet {
  const headers = [
    'Date', 'Expense #', ...(branchScoped ? [] : ['Branch']),
    'Category', 'Description', 'Payment', 'Amount', 'Remarks', 'Recorded By',
  ];

  const rows: (string | number)[][] = data.map((e) => [
    e.business_date ?? '',
    e.expense_number ?? '',
    ...(branchScoped ? [] : [e.branch_name ?? '']),
    e.category ?? '',
    e.description ?? '',
    paymentLabel(e.payment_method),
    // A number, not a formatted string: the point of a spreadsheet is that the
    // column sums. Currency belongs in the reader's own formatting.
    Number(e.amount ?? 0),
    e.remarks ?? '',
    e.created_by_name ?? '',
  ]);

  // Derived from `headers`, never counted by hand — a hardcoded offset totals
  // the wrong column for exactly one of the two roles, which is the kind of bug
  // that reads as plausible right up until someone reconciles against it.
  const amountIdx = headers.indexOf('Amount');
  const total = rows.reduce((s, r) => s + Number(r[amountIdx] ?? 0), 0);

  const totalRow: (string | number)[] = Array(headers.length).fill('');
  totalRow[amountIdx - 1] = 'TOTAL';
  totalRow[amountIdx] = total;
  rows.push(totalRow);

  return { headers, rows, total };
}
