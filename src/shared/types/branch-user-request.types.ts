// Branch user requests — the branch_manager → Admin queue for opening a shift
// account on the manager's own branch.
//
// The manager cannot create the account: only an admin may mint a login, and
// role/branch claims live in Supabase `app_metadata`, which the service-role key
// alone can write. So the manager forwards what they know (who the account is
// for, which shift, how to reach them) and an admin approves it, at which point
// the account is created ON THE MANAGER'S BEHALF — same `branchId`, so the shift
// user reads and writes the manager's branch data rather than a set of its own.
//
// This is deliberately NOT a support ticket. A support ticket is raised against
// one existing record and snapshots its figures so an admin can correct them; a
// request for an account that does not exist yet has no reference to snapshot
// and nothing to correct.

import type { BranchShift } from './user.types';

export type BranchUserRequestStatus = 'pending' | 'approved' | 'rejected';

export interface BranchUserRequest {
  id: string;
  /** Human-readable BUR-######, from the shared `counters` sequence. */
  requestNo: string;

  // The branch is taken from the requesting manager's JWT, never from the form —
  // a manager can only ever open an account on their own branch.
  branchId: string;
  branchName: string;
  requestedBy: string;
  requestedByName: string;

  // What the account should be. `email` is the login id; the password is set by
  // the admin at approval time and is never carried on the request.
  displayName: string;
  email: string;
  phone: string;
  shift: BranchShift;
  /** Free text from the manager — why the account is needed, when it starts. */
  note: string;

  status: BranchUserRequestStatus;

  // Review outcome. All null while pending.
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null; // ISO UTC
  /** Required on reject, so the manager is told why rather than left guessing. */
  rejectionReason: string | null;
  /** The account that was created, once approved. Null otherwise. */
  createdUserId: string | null;

  createdAt: string; // ISO UTC
}
