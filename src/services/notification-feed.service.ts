import { dbFor } from '../db';
import type { Notification, UserRole } from '../shared';
import { rowToApi } from '../utils/case';

const db = dbFor('notification-feed');

/**
 * The in-app notification feed, served by the API.
 *
 * The browser used to read `notifications` and `notification_reads` straight
 * from PostgREST with the user's JWT, and RLS was the only thing scoping the
 * result (migrations 09 and 28). This module is that same scoping, restated in
 * application code so the feed no longer needs a database the browser can reach:
 *
 *   notifications_select_own       →  `visibilityFilter` below
 *   notification_reads_select_own  →  `.eq('user_id', uid)`
 *   notification_reads_insert_own  →  `user_id` is always the caller's own
 *
 * The API's database connection bypasses RLS, so these predicates are the WHOLE
 * boundary on this path. Changing one changes who can see whose notifications.
 */

/** How many recent notifications the feed holds. Matches the bell's own cap. */
export const FEED_LIMIT = 50;

/** The most ids one mark-read call may carry — a full feed, marked at once. */
export const MARK_READ_MAX = FEED_LIMIT;

const SELECT =
  'id, type, title, message, is_read, target_user_id, target_role, branch_id, related_id, created_at';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FeedReader {
  uid: string;
  role: UserRole;
  branchId: string | null;
}

/**
 * `notifications_select_own`, as a PostgREST filter:
 *
 *   target_user_id = uid
 *   or (target_role = role and (branch_id is null or branch_id = branchId))
 *
 * A reader with no branch sees only the un-branched broadcasts for their role —
 * in SQL `branch_id = null` is never true, and the second form says the same.
 *
 * The values are interpolated into filter grammar, so each is checked first:
 * `role` is already one of USER_ROLES (middleware/auth.ts fails closed on
 * anything else), and the two ids must be UUIDs or this throws rather than
 * build a filter out of whatever the token carried.
 */
function visibilityFilter(reader: FeedReader): string {
  if (!UUID.test(reader.uid)) throw new Error('notification feed: caller id is not a UUID');
  if (reader.branchId && !UUID.test(reader.branchId)) {
    throw new Error('notification feed: caller branch id is not a UUID');
  }
  const branch = reader.branchId
    ? `or(branch_id.is.null,branch_id.eq.${reader.branchId})`
    : 'branch_id.is.null';
  return `target_user_id.eq.${reader.uid},and(target_role.eq.${reader.role},${branch})`;
}

export interface NotificationFeed {
  /** Newest first. `isRead` is the legacy per-row flag only — see `readIds`. */
  notifications: Notification[];
  /** Ids from `notifications` this reader has a `notification_reads` row for. */
  readIds: string[];
}

export async function getNotificationFeed(reader: FeedReader): Promise<NotificationFeed> {
  const { data, error } = await db
    .from('notifications')
    .select(SELECT)
    .or(visibilityFilter(reader))
    .order('created_at', { ascending: false })
    .limit(FEED_LIMIT);
  if (error) throw error;

  const notifications = rowToApi<Notification[]>(data ?? []);
  if (notifications.length === 0) return { notifications, readIds: [] };

  // Only the read rows for what is in the feed. A long-serving account has far
  // more read rows than the feed has entries, and the rest are of no use here.
  const { data: reads, error: readsErr } = await db
    .from('notification_reads')
    .select('notification_id')
    .eq('user_id', reader.uid)
    .in('notification_id', notifications.map((n) => n.id));
  if (readsErr) throw readsErr;

  return { notifications, readIds: (reads ?? []).map((r) => r.notification_id as string) };
}

/**
 * Record that the reader has seen these notifications. Returns the ids written.
 *
 * Narrowed to what the reader can actually see before anything is written. RLS
 * never required that — its insert policy only pinned `user_id` — but a read row
 * for a notification addressed to somebody else means nothing, and an id that
 * does not exist would otherwise surface as a foreign-key 500.
 *
 * ON CONFLICT DO NOTHING, so marking the same notification twice is a no-op.
 */
export async function markNotificationsRead(reader: FeedReader, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];

  const { data: visible, error: visibleErr } = await db
    .from('notifications')
    .select('id')
    .in('id', wanted)
    .or(visibilityFilter(reader));
  if (visibleErr) throw visibleErr;

  const visibleIds = (visible ?? []).map((r) => r.id as string);
  if (visibleIds.length === 0) return [];

  const { error } = await db
    .from('notification_reads')
    .upsert(
      visibleIds.map((notification_id) => ({ notification_id, user_id: reader.uid })),
      { onConflict: 'notification_id,user_id', ignoreDuplicates: true },
    );
  if (error) throw error;

  return visibleIds;
}
