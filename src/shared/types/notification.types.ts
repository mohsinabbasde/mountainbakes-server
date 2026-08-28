/**
 * Must stay in lockstep with the Postgres `notification_type` enum — that enum is
 * the authority, and `notifications.type` is `not null` against it, so a value
 * missing there fails the insert with a raw 22P02. The enum is declared in
 * migration 01 and extended by 14 (`password_reset`), 25 (the two `support_*`),
 * 42 (the six `event_*`), 72 (`production_demand_cancelled`) and 92 (the two
 * `branch_discount*`).
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
  | 'production_return' // a product return was raised, or reviewed by production
  | 'production_order_verified' // branch verified physical receipt of a demand → Production
  | 'production_demand_cancelled' // branch deleted a still-pending demand → Production (migration 72)
  // Branch discount claims (migration 92) — money asked for against a demand.
  // Two values where returns make do with one, because the two directions have
  // different audiences: a claim raised goes to Production, a claim decided goes
  // back to the branch.
  | 'branch_discount' // a branch raised a discount claim → Production
  | 'branch_discount_reviewed' // Production approved/rejected/sent it back → branch
  // Help Desk → Support Center queries (migration 25)
  | 'support_query' // a branch/production user raised a query → Admin
  | 'support_resolved' // Admin resolved/rejected or corrected the figures → raiser
  // Finance Help Desk queries (migration 60) — a separate queue from the two above
  | 'finance_query' // an Accountant/Finance Manager raised a query → Finance Admin
  | 'finance_query_resolved' // Finance Admin resolved/rejected it → raiser
  // Branch shift accounts (migration 65) — branch_manager asks, Admin decides
  | 'branch_user_requested' // a manager forwarded a request for a shift account → Admin
  | 'branch_user_reviewed' // Admin approved or rejected it → the requesting manager
  // Special Events (migration 42)
  | 'event_created' // a new event was published → branches + Production
  | 'event_reminder' // a scheduled countdown reminder fired → branch or Production
  | 'event_demand_due' // the branch demand deadline is tomorrow → branch
  | 'event_demand_submitted' // a branch submitted its advance demand → Production
  | 'event_demand_reviewed' // Production/Admin approved or rejected a demand → branch
  | 'event_production_updated'; // a preparation stage moved → Admin

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
