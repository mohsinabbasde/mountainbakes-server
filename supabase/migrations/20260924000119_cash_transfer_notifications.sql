-- 119: notification types for cash transfers (see migration 118).
--
-- Own file, by the migration 92 convention: Postgres will not let a newly ADDed
-- enum value be referenced in the SAME transaction that added it, and keeping
-- the ALTER TYPEs alone leaves 118 free to grow a function that names one of
-- these without a silent rollback of the whole batch. Nothing in 118 or 119
-- references either value; only the running app does (push.service.ts).
--
-- Two values for the two directions, as with discounts: a transfer SUBMITTED
-- travels branch → Finance, a transfer DECIDED travels Finance → branch.

-- A branch recorded a cash / Easypaisa / bank handover → Finance.
alter type notification_type add value if not exists 'cash_transfer';

-- Finance approved or rejected it → the raising branch.
alter type notification_type add value if not exists 'cash_transfer_reviewed';
