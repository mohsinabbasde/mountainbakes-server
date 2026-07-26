/**
 * Must stay in lockstep with the Postgres `notification_type` enum — that enum is
 * the authority, and `notifications.type` is `not null` against it, so a value
 * missing there fails the insert with a raw 22P02. The enum is declared in
 * migration 01 and extended by 14 (`password_reset`) and 25 (the two `support_*`).
 *
 * Note `notify()` takes `type: string`, not this union (services/push.service.ts) —
 * nothing mechanically enforces the match, so add values in BOTH places.
 */
export type NotificationType =
  | 'order_created'
  | 'order_ready'
  | 'order_cancelled'
  | 'low_stock'
  | 'new_user'
  | 'branch_added'
  | 'price_changed'
  | 'password_reset' // migration 14 — admin reset a user's password → that user
  // Production module
  | 'production_demand' // branch submitted a new production demand → Production
  | 'production_reviewed' // Production approved/rejected a demand → branch
  | 'production_return' // a product return was recorded/accepted
  // Help Desk → Support Center queries (migration 25)
  | 'support_query' // a branch/production user raised a query → Admin
  | 'support_resolved'; // Admin resolved/rejected or corrected the figures → raiser

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  targetUserId: string | null;
  targetRole: string | null;
  branchId: string | null;
  relatedId: string | null;
  createdAt: string;
}
