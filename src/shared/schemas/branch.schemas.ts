import { z } from 'zod';

/**
 * The branch's own company-share percentage.
 *
 * Nullable AND optional, and the two mean different things at the API boundary:
 * omitted leaves whatever is stored alone, explicit `null` CLEARS the override
 * and puts the branch back on the global split (`apiToRow` preserves an explicit
 * null for exactly this). Only the company half is ever accepted — the branch
 * share is derived, see `resolveShareSplit` in utils/share.ts.
 */
const companySharePct = z
  .number({ invalid_type_error: 'Company share must be a number' })
  .min(0, 'Company share cannot be negative')
  .max(100, 'Company share cannot exceed 100%')
  .nullable()
  .optional();

export const CreateBranchSchema = z.object({
  name: z.string().min(2, 'Branch name is required'),
  location: z.string().min(2, 'Location is required'),
  phone: z.string().min(10, 'Invalid phone number'),
  address: z.string().min(5, 'Address is required'),
  city: z.string().min(2, 'City is required'),
  dailyBudget: z.number().min(0).optional(),
  weeklyBudget: z.number().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
  companySharePct,
});

export const UpdateBranchSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  address: z.string().min(5).optional(),
  city: z.string().min(2).optional(),
  managerId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  dailyBudget: z.number().min(0).optional(),
  weeklyBudget: z.number().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
  companySharePct,
});

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
