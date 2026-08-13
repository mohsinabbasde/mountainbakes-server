import { z } from 'zod';
import { BRANCH_SHIFTS } from '../types/user.types';

/**
 * What a branch manager forwards to Admin.
 *
 * There is no `branchId` and no `password` here, on purpose. The branch comes
 * from the requesting manager's JWT — accepting it from the form would let a
 * manager open an account on someone else's branch — and the password is set by
 * the admin at approval, so it never travels on a row that sits in a queue.
 */
export const CreateBranchUserRequestSchema = z.object({
  displayName: z.string().min(1, 'Name is required').max(120),
  email: z.string().email('Enter a valid email').max(200),
  phone: z.string().max(30).default(''),
  shift: z.enum(BRANCH_SHIFTS),
  note: z.string().max(500).default(''),
});

/**
 * Approval. The admin supplies the login password here and nowhere else.
 *
 * `username` is optional because `users.username` is unique and the manager may
 * not have proposed one; the route derives it from the email local part when it
 * is omitted.
 */
export const ApproveBranchUserRequestSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  username: z.string().min(1).max(60).optional(),
});

/** Rejection. A reason is mandatory — the manager is told why, not just "no". */
export const RejectBranchUserRequestSchema = z.object({
  reason: z.string().min(1, 'A reason is required').max(500),
});

export type CreateBranchUserRequestInput = z.infer<typeof CreateBranchUserRequestSchema>;
export type ApproveBranchUserRequestInput = z.infer<typeof ApproveBranchUserRequestSchema>;
export type RejectBranchUserRequestInput = z.infer<typeof RejectBranchUserRequestSchema>;
