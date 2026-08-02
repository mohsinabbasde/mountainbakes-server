import type { GeofenceOutcome, GeoPoint } from '../utils/geo';

/**
 * A branch's authorised selling area.
 *
 * Its own table rather than columns on `branches` (migration 48). Two reasons:
 * a location is written by a different screen, by a different role, on a different
 * cadence than the rest of a branch record — and keeping it separate means a branch
 * that has never been geofenced is represented by an absent row rather than by four
 * nullable columns that every consumer has to null-check.
 *
 * `branchName` is a denormalised cache of `branches.name`, following the same
 * pattern as `branches.manager_name`: the admin table lists locations, not branches,
 * and this saves a join on the hot path.
 */
export interface BranchLocation {
  id: string;
  branchId: string;
  branchName: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  googlePlaceId: string | null;
  /**
   * Whether this geofence is enforced. Disabling it leaves the coordinates in
   * place — it is how an admin suspends the rule for one branch (a relocation, a
   * temporary stall) without losing the location they configured.
   */
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A branch as the admin module lists it: every active branch, with its location
 * if it has one. Branches with no row are the "Missing GPS" count, so they have to
 * appear in the same list rather than being filtered out of it.
 */
export interface BranchLocationRow {
  branchId: string;
  branchName: string;
  branchAddress: string;
  branchIsActive: boolean;
  location: BranchLocation | null;
}

/** The tiles across the top of Admin → Branch Locations. */
export interface BranchLocationStats {
  totalBranches: number;
  activeBranches: number;
  gpsConfigured: number;
  missingGps: number;
  /** Distinct branch users seen inside the verification window. */
  onlineUsers: number;
  /** Of those, how many reported a position outside their branch radius. */
  usersOutsideRadius: number;
}

/**
 * One row of the geofence audit trail.
 *
 * Written for every checked attempt, allowed or blocked — an audit log that only
 * records refusals cannot answer "was this cashier at the shop when they rang that
 * sale up", which is the question it exists for.
 */
export interface GeofenceLog {
  id: string;
  branchId: string | null;
  branchName: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  /** The guarded operation, e.g. 'sale.create', 'order.create', 'stock.return'. */
  action: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  distanceKm: number | null;
  radiusKm: number | null;
  outcome: GeofenceOutcome;
  allowed: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** What the branch dashboard's status card renders. */
export interface GeofenceStatus {
  outcome: GeofenceOutcome;
  allowed: boolean;
  distanceKm: number | null;
  radiusKm: number | null;
  device: GeoPoint | null;
  branch: GeoPoint | null;
  branchName: string | null;
  /** ISO timestamp of the last successful verification, or null if none yet. */
  lastVerifiedAt: string | null;
}
