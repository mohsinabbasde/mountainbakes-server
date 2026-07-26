-- 32: Order confirmation SMS.
--
-- Extends the messaging pipeline built in migration 27 (notification_recipients /
-- daily_closing_reports / notification_logs) so it also carries per-order
-- confirmations. Those go to the CUSTOMER's own number captured on the order, not
-- to a notification_recipients row — a recipient is a staff member subscribed to
-- a recurring summary, which is a different thing entirely.
--
-- notification_logs is reused rather than duplicated: it already holds exactly
-- the columns a delivery attempt needs (channel, status, provider,
-- provider_message_id, error_message, retry_count, sent_at) and the admin log
-- view reads from it. report_id and recipient_id were already nullable, so an
-- order confirmation simply leaves them null and sets order_id instead.

-- ---------------------------------------------------------------------------
-- notification_logs.order_id — set on order confirmations, null on closing rows.
-- ---------------------------------------------------------------------------
alter table notification_logs
  add column if not exists order_id uuid references orders (id) on delete cascade;

comment on column notification_logs.order_id is
  'Set for order-confirmation sends; null for daily-closing summaries (which use report_id + recipient_id instead).';

create index if not exists notification_logs_order_idx
  on notification_logs (order_id, created_at desc)
  where order_id is not null;

-- Exactly one SUCCESSFUL confirmation per (order, channel). This is the
-- idempotency guard: a retried request, a double-submit from the POS, or a
-- re-run of the same order must not bill a second SMS or text the customer
-- twice. Failed and pending attempts are deliberately NOT covered — they must be
-- allowed to accumulate so the retry history stays visible in the log.
create unique index if not exists notification_logs_order_sent_key
  on notification_logs (order_id, channel)
  where order_id is not null and status = 'sent';

-- A log row is now either a closing-summary attempt or an order confirmation,
-- never both and never neither.
alter table notification_logs
  drop constraint if exists notification_logs_target_ck;
alter table notification_logs
  add constraint notification_logs_target_ck
  check (
    (order_id is not null and report_id is null and recipient_id is null)
    or (order_id is null)
  );

-- ---------------------------------------------------------------------------
-- Admin toggle, mirroring closing_notifications_enabled (migration 27).
--
-- Default false: turning this on starts spending money and texting real
-- customers, so it must be a deliberate act in the Settings UI rather than
-- something a deploy switches on by itself. Twilio credentials stay in server
-- env — secrets never belong in a client-readable settings row.
-- ---------------------------------------------------------------------------
alter table settings
  add column if not exists order_confirmations_enabled boolean not null default false;
