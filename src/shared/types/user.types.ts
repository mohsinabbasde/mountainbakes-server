/**
 * Every role the app recognises.
 *
 * The four `finance_*` / `accountant` values were added by migration 51 for the
 * Finance Ledger module, and `branch_user` by migration 65. They are ordinary
 * members of the `user_role` Postgres enum rather than a parallel claim, so RLS
 * (`app.jwt_role()`), the API's `requireRole()` and the client's RouteGuard all
 * keep working unchanged.
 *
 * ORDER MATTERS to nothing here, but the VALUES must stay identical to the
 * Postgres enum — a drift surfaces as a runtime 22P02 on the first insert.
 */
export type UserRole =
  | 'super_admin'
  | 'branch_manager'
  | 'branch_user'
  | 'production_user'
  | 'finance_admin'
  | 'finance_manager'
  | 'accountant'
  | 'finance_auditor';

export const USER_ROLES = [
  'super_admin',
  'branch_manager',
  'branch_user',
  'production_user',
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
] as const satisfies readonly UserRole[];

/**
 * The roles that work a shop floor, in descending authority.
 *
 * A `branch_user` is a shift account created for a `branch_manager`'s branch, and
 * it carries the SAME `branchId` claim — so every branch-scoped query it makes
 * returns the manager's branch data, not a private set of its own. That sharing
 * is the point of the role, and it is why the two belong in one group: an
 * endpoint that scopes by branch must treat them identically or the shift user
 * sees an empty shop.
 *
 * Use this for the branch-scoping test (`isBranchRole`) and for gates that both
 * roles pass. Do NOT use it as a shorthand for "any branch-ish endpoint": a
 * branch_user is deliberately barred from the Help Desk, Reports, user
 * management and settings, and those sites keep naming `'branch_manager'`
 * literally so the narrower grant stays visible at the call site.
 */
export const BRANCH_ROLES = ['branch_manager', 'branch_user'] as const satisfies readonly UserRole[];

/**
 * True for both shop-floor roles. Replaces `role === 'branch_manager'` wherever
 * that test meant "scope this to the caller's own branch" rather than "only a
 * manager may do this".
 *
 * Takes a loose `string` for the same reason `financeCan` does: the client reads
 * the role off a JWT claim, where it is whatever Supabase put there, and the
 * guard that has to cope with an unrecognised value is exactly the caller that
 * must not be forced to cast one in.
 */
export function isBranchRole(role: UserRole | string | null | undefined): boolean {
  return (BRANCH_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * Which shift a `branch_user` account is for. A label: it is stored on the
 * account, shown in lists and carried in the audit trail, and it gates NOTHING.
 * Sign-in and every write work the same at any hour, deliberately — staff swap
 * and extend shifts constantly, and an account that locks its holder out at the
 * wrong moment is worse than one that records the wrong label.
 */
export type BranchShift = 'morning' | 'evening';

export const BRANCH_SHIFTS = ['morning', 'evening'] as const satisfies readonly BranchShift[];

export const BRANCH_SHIFT_LABELS: Record<BranchShift, string> = {
  morning: 'Morning shift',
  evening: 'Evening shift',
};

export type UserStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  /**
   * Mountain Bakes staff ID — `MBU-000125`. Allocated by Postgres on insert
   * (migration 98) and never reassigned, so it is safe to print, quote and
   * search by. `MBU-`, not `MB-`: `MB-######` has meant a sales order since
   * migration 03 and one namespace cannot mean two things.
   */
  userCode: string;
  email: string;
  displayName: string;
  phone: string;
  username: string;
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
  /** Set only on `branch_user`; null for every other role. */
  shift: BranchShift | null;
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
  shift?: BranchShift | null;
}

export interface UpdateUserPayload {
  displayName?: string;
  phone?: string;
  role?: UserRole;
  branchId?: string | null;
  status?: UserStatus;
}
