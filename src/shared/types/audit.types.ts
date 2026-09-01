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
  | 'branch_location_removed'
  // Session security (migration 98). The first entries that record an admin
  // acting ON somebody's session rather than on their account. Both target a
  // user, so `target_user_id` is populated; `details` names the device, the
  // resolved location and the admin's stated reason, because "revoked a session"
  // without which session is not an audit trail.
  //
  // There is deliberately NO 'login' or 'logout' action here. Every sign-in and
  // sign-out already writes a `login_sessions` row carrying strictly more than
  // an audit line could — IP, device, location, duration — and duplicating them
  // into audit_logs would double the busiest write in the app to say less.
  | 'session_revoked'
  | 'all_sessions_revoked'
  | 'suspicious_login';

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
