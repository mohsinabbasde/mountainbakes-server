import { z } from 'zod';

/**
 * Suggested categories for a Finance Query. Validated as a bounded string
 * rather than z.enum, matching expense.schemas.ts's EXPENSE_CATEGORIES: the
 * list can grow or be renamed without a migration, and a historical row
 * keeps whatever was stored even if a value is later retired.
 */
export const FINANCE_QUERY_CATEGORIES = [
  'Sale', 'Purchase', 'Salary', 'Rent', 'Utilities', 'Company Transaction',
  'Branch Share', 'Partner Advance', 'Loan', 'Other',
] as const;

// Named FINANCE_QUERY_TXN_TYPES (not FINANCE_QUERY_TYPES) — that name is
// already taken by finance.types.ts for the unrelated Help Desk ticket
// category enum (income, expense, company_transaction, salary, ...).
export const FINANCE_QUERY_TXN_TYPES = ['income', 'expense'] as const;

export const CreateFinanceQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  title: z.string().min(1, 'Title is required').max(200),
  amount: z.number().positive('Amount must be greater than 0'),
  category: z.string().min(1, 'Category is required').max(100),
  branchId: z.string().uuid('Select a branch'),
  // A single field, not two amount columns — the only way this record can be
  // Income or Expense, never both.
  type: z.enum(FINANCE_QUERY_TXN_TYPES),
  comment: z.string().max(2000).default(''),
});

export type CreateFinanceQueryInput = z.infer<typeof CreateFinanceQuerySchema>;

/**
 * Every field optional, independently, rather than `CreateFinanceQuerySchema.partial()` —
 * so `comment: z.string().default('')` cannot resurface a default on a field
 * the caller never touched.
 */
export const UpdateFinanceQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional(),
  title: z.string().min(1, 'Title is required').max(200).optional(),
  amount: z.number().positive('Amount must be greater than 0').optional(),
  category: z.string().min(1, 'Category is required').max(100).optional(),
  branchId: z.string().uuid('Select a branch').optional(),
  type: z.enum(FINANCE_QUERY_TXN_TYPES).optional(),
  comment: z.string().max(2000).optional(),
});

export type UpdateFinanceQueryInput = z.infer<typeof UpdateFinanceQuerySchema>;
