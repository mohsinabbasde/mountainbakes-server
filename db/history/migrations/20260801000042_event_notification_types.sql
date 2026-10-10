-- 42: notification_type values for the Special Events module.
--
-- Its own migration file, like 14 and 34 before it: Postgres cannot USE an enum
-- value in the same transaction that adds it. Nothing in SQL consumes these — the
-- inserts happen from application code in a later transaction — so all six can
-- share this one file, but they cannot share migration 41.
--
-- These must be mirrored into the NotificationType union in
-- src/shared/types/notification.types.ts in BOTH repos. notify() takes
-- `type: string`, so nothing mechanically enforces the match; a value missing from
-- this enum fails the insert with a raw 22P02.

alter type notification_type add value if not exists 'event_created';
alter type notification_type add value if not exists 'event_reminder';
alter type notification_type add value if not exists 'event_demand_due';
alter type notification_type add value if not exists 'event_demand_submitted';
alter type notification_type add value if not exists 'event_demand_reviewed';
alter type notification_type add value if not exists 'event_production_updated';
