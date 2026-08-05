/**
 * Every role the app recognises.
 *
 * The four `finance_*` / `accountant` values were added by migration 51 for the
 * Finance Ledger module. They are ordinary members of the `user_role` Postgres
 * enum rather than a parallel claim, so RLS (`app.jwt_role()`), the API's
 * `requireRole()` and the client's RouteGuard all keep working unchanged.
 *
 * ORDER MATTERS to nothing here, but the VALUES must stay identical to the
 * Postgres enum — a drift surfaces as a runtime 22P02 on the first insert.
 */
export type UserRole =
  | 'super_admin'
  | 'branch_manager'
  | 'production_user'
  | 'finance_admin'
  | 'finance_manager'
  | 'accountant'
  | 'finance_auditor';

export const USER_ROLES = [
  'super_admin',
  'branch_manager',
  'production_user',
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
] as const satisfies readonly UserRole[];

export type UserStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  email: string;
  displayName: string;
  phone: string;
  username: string;
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Password-recovery / admin-reset management
  mustChangePassword?: boolean;
  lastPasswordReset?: string | null;
  passwordResetBy?: string | null;
  passwordResetByName?: string | null;
}

export interface UserCustomClaims {
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
}

export interface CreateUserPayload {
  email: string;
  displayName: string;
  phone: string;
  username: string;
  password: string;
  role: UserRole;
  branchId: string | null;
}

export interface UpdateUserPayload {
  displayName?: string;
  phone?: string;
  role?: UserRole;
  branchId?: string | null;
  status?: UserStatus;
}
