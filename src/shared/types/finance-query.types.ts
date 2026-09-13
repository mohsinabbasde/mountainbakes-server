// Named FinanceQueryTxnType (not FinanceQueryType) — that name is already
// taken by finance.types.ts for the unrelated Help Desk ticket category enum.
export type FinanceQueryTxnType = 'income' | 'expense';

/**
 * A Finance Query — a standalone finance record, NOT a Finance Help Desk
 * ticket (see finance.types.ts's FinanceTicket*). The query IS the record:
 * one flat row with no reference to another table and no versioning.
 */
export interface FinanceQuery {
  id: string;
  queryNo: string; // human-readable FIN-### (see next_finance_query_number())
  date: string; // 'YYYY-MM-DD'
  title: string;
  amount: number;
  category: string; // one of FINANCE_QUERY_CATEGORIES (free text in the DB)
  branchId: string;
  branchName: string;
  type: FinanceQueryTxnType;
  comment: string;
  createdBy: string | null;
  createdByName: string;
  createdAt: string; // ISO UTC
  updatedBy: string | null;
  updatedByName: string;
  updatedAt: string; // ISO UTC
}
