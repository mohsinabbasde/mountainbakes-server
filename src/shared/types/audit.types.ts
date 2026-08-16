export type AuditAction =
  | 'password_reset'
  | 'password_changed'
  | 'user_created'
  | 'user_updated'
  | 'user_activated'
  | 'user_deactivated'
  // Geofencing (migration 48). These are the first entries that target something
  // other than a user, which is why they carry no target_user_id — the affected
  // subject is named in `details` instead. Worth auditing because widening a
  // branch's radius, or deleting its location outright, silently removes the
  // restriction on where that branch may sell from.
  | 'branch_location_updated'
  | 'branch_location_removed';

export interface AuditLog {
  id: string;
  action: AuditAction;
  adminId: string;
  adminName: string;
  targetUserId: string | null;
  targetUserName: string | null;
  targetUserRole: string | null;
  details: string | null;
  createdAt: string;
}
