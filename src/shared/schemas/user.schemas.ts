import { z } from 'zod';
import { BRANCH_SHIFTS, USER_ROLES } from '../types/user.types';

/**
 * `shift` is only meaningful on a `branch_user`, and migration 66 enforces that
 * in the database (`users_shift_only_for_branch_user`). Checking it here too is
 * not redundant: unchecked, a shift sent with any other role reaches Postgres as
 * a 23514 the admin sees as an opaque 500, instead of a message naming the field.
 */
const shiftBelongsToRole = (d: { role?: string; shift?: string | null }) =>
  !d.shift || d.role === 'branch_user';
const shiftRefinement = {
  message: 'Only a branch user has a shift',
  path: ['shift'] as (string | number)[],
};

export const CreateUserSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    displayName: z.string().min(2, 'Name must be at least 2 characters'),
    phone: z.string().min(10, 'Invalid phone number'),
    username: z.string().min(3, 'Username must be at least 3 characters').regex(/^[a-z0-9_]+$/, 'Username can only contain lowercase letters, numbers, and underscores'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    // Driven off USER_ROLES so adding a role to the union (and the Postgres enum)
    // cannot leave this list behind — which would reject the new role with a
    // validation error that names no field the admin can see.
    role: z.enum(USER_ROLES),
    branchId: z.string().nullable(),
    // The shift label, when an admin opens a shift account directly rather than
    // through the branch_user_requests queue (which carries its own shift).
    shift: z.enum(BRANCH_SHIFTS).nullable().optional(),
  })
  .refine(shiftBelongsToRole, shiftRefinement);

export const UpdateUserSchema = z
  .object({
    displayName: z.string().min(2).optional(),
    phone: z.string().min(10).optional(),
    role: z.enum(USER_ROLES).optional(),
    branchId: z.string().nullable().optional(),
    status: z.enum(['active', 'inactive', 'suspended']).optional(),
    // Reassigning morning ↔ evening. Sending a shift WITHOUT a role means the
    // account is already a branch_user, so the refinement below cannot judge it
    // — the route re-checks against the stored role.
    shift: z.enum(BRANCH_SHIFTS).nullable().optional(),
  })
  .refine((d) => d.role === undefined || shiftBelongsToRole(d), shiftRefinement);

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

// ─── Password recovery & reset ────────────────────────────────────────────────

/** Strong password policy: 8+ chars with upper, lower, number and special. */
export const StrongPasswordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .regex(/[A-Z]/, 'One uppercase letter')
  .regex(/[a-z]/, 'One lowercase letter')
  .regex(/[0-9]/, 'One number')
  .regex(/[^A-Za-z0-9]/, 'One special character');

/** Public "Forgot Password" request (admin accounts only, enforced server-side). */
export const ForgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

/** Admin action to reset another user's password (Super Admin only). */
export const AdminResetPasswordSchema = z
  .object({
    generateTemp: z.boolean(),
    sendEmail: z.boolean(),
    forceChange: z.boolean(),
  })
  .refine((d) => d.generateTemp || d.sendEmail, {
    message: 'Choose at least one: generate a temporary password or send a reset email',
    path: ['generateTemp'],
  });

/** A user setting their own new password (e.g. forced change after reset). */
export const ChangePasswordSchema = z
  .object({
    newPassword: StrongPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type AdminResetPasswordInput = z.infer<typeof AdminResetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
