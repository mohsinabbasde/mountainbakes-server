-- 115: WhatsApp Business integration (core) + vendor procurement.
--
-- Two feature areas landing in one migration because they exist for each
-- other: Production reaches a vendor over WhatsApp, the vendor's reply
-- becomes a quotation, and every step stays linked back to the conversation
-- that carried it. See ../../WHATSAPP.md for the audit this schema follows —
-- in particular, why there is no vendor_ledger_entries table (computed on
-- read, same as Partner Share Detail), why vendor_payments carries
-- finance_doc_status columns (it will post through the existing
-- approveDocument()/ledger pipeline in a later phase, not a bespoke status
-- machine), and why payment method/account reuse finance_payment_method /
-- finance_account rather than a new taxonomy.
--
-- RLS is intentionally absent here, matching every other finance/production
-- table: the server only ever talks to Postgres through the service-role
-- client, which bypasses RLS, so authorization lives in application code
-- (requireRole/requireFinance-style middleware), not in policies nobody's
-- request path ever goes through.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type whatsapp_number_purpose as enum ('production', 'branch', 'admin', 'customer_service', 'other');
create type whatsapp_number_status  as enum ('connected', 'disconnected', 'pending', 'configuration_required', 'webhook_error');
create type whatsapp_contact_type   as enum ('vendor', 'branch', 'production', 'customer', 'other');
create type whatsapp_msg_direction  as enum ('inbound', 'outbound');
create type whatsapp_msg_type       as enum ('text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive', 'button', 'list');
create type whatsapp_msg_status     as enum ('queued', 'sent', 'delivered', 'read', 'failed');
create type whatsapp_template_status as enum ('pending', 'approved', 'rejected');

create type vendor_purchase_status as enum (
  'draft', 'sent', 'vendor_responded', 'quotation_received', 'approved',
  'confirmed', 'partially_received', 'received', 'cancelled'
);
create type vendor_quotation_status as enum ('pending', 'accepted', 'rejected', 'change_requested');

-- Reused, not duplicated: vendor payments post to the SAME immutable ledger
-- every other finance document does, once Phase 7 wires
-- approveDocument({ table: 'vendor_payments', ... }) the way partner_expenses
-- already does. Adding the value now, unused, is safe — nothing in this
-- migration writes it.
alter type finance_ledger_source add value if not exists 'vendor_payment';

-- ---------------------------------------------------------------------------
-- Counters — one per document family, same pattern as migration 52.
-- ---------------------------------------------------------------------------

insert into counters (id, count) values
  ('vendor_po',        0),
  ('vendor_quotation',  0),
  ('vendor_payment',   0)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Vendors — created before whatsapp_contacts, which references it.
-- ---------------------------------------------------------------------------

create table vendors (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  company           text,
  phone             text,
  whatsapp_number   text,
  contact_person    text,
  category          text,
  address           text,
  payment_terms     text,
  opening_balance   numeric(14,2) not null default 0,
  is_active         boolean not null default true,
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Same soft-delete shape as every finance-adjacent table (migration 94) —
  -- a vendor with posted purchases/payments against it must not vanish from
  -- those historical records.
  deleted_at        timestamptz,
  deleted_by        uuid references users (id) on delete set null,
  deleted_by_name   text,
  delete_reason     text
);

create trigger vendors_touch before update on vendors
  for each row execute function app.touch_updated_at();

create index vendors_active_idx on vendors (is_active) where deleted_at is null;
create index vendors_whatsapp_idx on vendors (whatsapp_number) where whatsapp_number is not null;

-- ---------------------------------------------------------------------------
-- WhatsApp core
-- ---------------------------------------------------------------------------

create table whatsapp_business_numbers (
  id                  uuid primary key default gen_random_uuid(),
  phone_number        text not null unique,
  phone_number_id     text not null unique,
  business_account_id text not null,
  display_name        text not null,
  purpose             whatsapp_number_purpose not null,
  -- Only set when purpose = 'branch'; Production/Admin/Other numbers leave
  -- this null rather than needing a placeholder branch.
  branch_id           uuid references branches (id) on delete set null,
  department          text,
  status              whatsapp_number_status not null default 'pending',
  last_connected_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger whatsapp_business_numbers_touch before update on whatsapp_business_numbers
  for each row execute function app.touch_updated_at();

create index whatsapp_numbers_branch_idx on whatsapp_business_numbers (branch_id) where branch_id is not null;

create table whatsapp_contacts (
  id            uuid primary key default gen_random_uuid(),
  -- Normalized (+923001234567-style) by the service layer before insert —
  -- never trust a client-supplied format. This column holds the result, not
  -- raw input, which is what keeps it a reliable unique join key (spec §9).
  phone_number  text not null unique,
  display_name  text,
  contact_type  whatsapp_contact_type not null default 'other',
  vendor_id     uuid references vendors (id) on delete set null,
  branch_id     uuid references branches (id) on delete set null,
  customer_id   uuid references customers (id) on delete set null,
  is_active     boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger whatsapp_contacts_touch before update on whatsapp_contacts
  for each row execute function app.touch_updated_at();

create index whatsapp_contacts_vendor_idx on whatsapp_contacts (vendor_id) where vendor_id is not null;
create index whatsapp_contacts_branch_idx on whatsapp_contacts (branch_id) where branch_id is not null;

create table whatsapp_conversations (
  id                 uuid primary key default gen_random_uuid(),
  business_number_id uuid not null references whatsapp_business_numbers (id) on delete restrict,
  contact_id         uuid not null references whatsapp_contacts (id) on delete restrict,
  -- Denormalized off contact_id for cheap filtering ("Vendors" / "Branches"
  -- tabs in the inbox) without a join on every list query.
  vendor_id          uuid references vendors (id) on delete set null,
  branch_id          uuid references branches (id) on delete set null,
  department         text,
  status             text not null default 'open' check (status in ('open', 'archived')),
  unread_count       integer not null default 0,
  last_message_id    uuid,
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One open conversation per (number, contact) pair — a second inbound
  -- message from the same vendor to the same number continues the existing
  -- thread rather than forking a duplicate.
  unique (business_number_id, contact_id)
);

create trigger whatsapp_conversations_touch before update on whatsapp_conversations
  for each row execute function app.touch_updated_at();

create index whatsapp_conversations_vendor_idx on whatsapp_conversations (vendor_id) where vendor_id is not null;
create index whatsapp_conversations_branch_idx on whatsapp_conversations (branch_id) where branch_id is not null;
create index whatsapp_conversations_last_msg_idx on whatsapp_conversations (last_message_at desc);

create table whatsapp_messages (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references whatsapp_conversations (id) on delete cascade,
  -- Meta's own message id. Null briefly for an outbound message between
  -- being queued and Meta accepting the send call.
  whatsapp_message_id  text unique,
  direction            whatsapp_msg_direction not null,
  message_type         whatsapp_msg_type not null default 'text',
  message_body         text,
  media_id             text,
  template_name        text,
  status               whatsapp_msg_status not null default 'queued',
  from_number          text not null,
  to_number            text not null,
  -- §58: optional link to the business record this message is about, so the
  -- UI can render "[Open Purchase]" / "[Open Payment]" next to it. No join
  -- table — a message belongs to at most one related record, and a lookup
  -- table for a 1:1 optional reference would only add a join for nothing.
  related_entity_type  text,
  related_entity_id    uuid,
  -- §55 idempotency: the operation that CAUSED this send (e.g. "approve
  -- purchase PO-000123"), not the message itself — retrying that operation
  -- must not double-send. Null for messages typed by a human in the inbox,
  -- which have no operation to be idempotent against.
  operation_id         text unique,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  failure_reason       text,
  created_by           uuid references users (id) on delete set null,
  created_at           timestamptz not null default now()
);

create index whatsapp_messages_conversation_idx on whatsapp_messages (conversation_id, created_at desc);
create index whatsapp_messages_related_idx on whatsapp_messages (related_entity_type, related_entity_id) where related_entity_id is not null;
create index whatsapp_messages_status_idx on whatsapp_messages (status) where status in ('queued', 'failed');

alter table whatsapp_conversations
  add constraint whatsapp_conversations_last_message_fk
  foreign key (last_message_id) references whatsapp_messages (id) on delete set null;

create table whatsapp_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  -- Meta's own event/entry id — the dedupe key for §65's "already processed?" check.
  event_id      text not null unique,
  event_type    text not null,
  payload_hash  text not null,
  payload       jsonb not null,
  processed     boolean not null default false,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

create index whatsapp_webhook_events_unprocessed_idx on whatsapp_webhook_events (created_at) where processed = false;

create table whatsapp_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  category    text not null,
  language    text not null default 'en',
  body_text   text not null,
  -- e.g. ["vendor_name", "order_no", "amount"] — §22's variable list, kept as
  -- data so the send-time substitution code has no hard-coded template shapes.
  variables   jsonb not null default '[]'::jsonb,
  status      whatsapp_template_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger whatsapp_templates_touch before update on whatsapp_templates
  for each row execute function app.touch_updated_at();

-- Singleton settings row, same shape as finance_settings (migration 52).
create table whatsapp_settings (
  id                                boolean primary key default true check (id),
  vendor_purchase_notification      boolean not null default true,
  payment_notification              boolean not null default true,
  branch_demand_notification        boolean not null default true,
  production_ready_notification     boolean not null default true,
  delivery_notification             boolean not null default true,
  stock_alert_notification          boolean not null default false,
  updated_at                        timestamptz not null default now()
);

insert into whatsapp_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Vendor procurement
-- ---------------------------------------------------------------------------

create table vendor_purchase_orders (
  id                     uuid primary key default gen_random_uuid(),
  po_no                  text not null unique default app.next_finance_number('vendor_po', 'PO'),
  vendor_id              uuid not null references vendors (id) on delete restrict,
  status                 vendor_purchase_status not null default 'draft',
  purchase_date          date not null default current_date,
  expected_delivery_date date,
  remarks                text,
  payment_terms          text,
  -- The conversation this PO was sent/negotiated through, when it was raised
  -- via WhatsApp rather than typed directly into the Purchase Request form.
  conversation_id        uuid references whatsapp_conversations (id) on delete set null,
  created_by             uuid references users (id) on delete set null,
  created_by_name        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  deleted_by             uuid references users (id) on delete set null,
  deleted_by_name        text,
  delete_reason          text
);

create trigger vendor_purchase_orders_touch before update on vendor_purchase_orders
  for each row execute function app.touch_updated_at();

create index vendor_po_vendor_idx on vendor_purchase_orders (vendor_id, purchase_date desc);
create index vendor_po_status_idx on vendor_purchase_orders (status) where deleted_at is null;

create table vendor_purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references vendor_purchase_orders (id) on delete cascade,
  -- Optional: a raw-material purchase (flour, sugar) rarely has a matching
  -- row in the finished-goods `products` catalog, so this stays free text
  -- with an optional link rather than a mandatory FK.
  product_id        uuid references products (id) on delete set null,
  product_name      text not null,
  unit              text not null default 'unit',
  quantity          numeric(12,3) not null check (quantity > 0),
  expected_price    numeric(14,2),
  unit_price        numeric(14,2),
  -- Cumulative across all receiving events for this line — see
  -- vendor_purchase_receipt_items for the per-event history.
  received_qty      numeric(12,3) not null default 0,
  rejected_qty      numeric(12,3) not null default 0
);

create index vendor_po_items_po_idx on vendor_purchase_order_items (purchase_order_id);

create table vendor_quotations (
  id                 uuid primary key default gen_random_uuid(),
  quotation_no       text not null unique default app.next_finance_number('vendor_quotation', 'VQ'),
  purchase_order_id  uuid not null references vendor_purchase_orders (id) on delete cascade,
  quotation_date     date not null default current_date,
  tax_amount         numeric(14,2) not null default 0,
  discount_amount    numeric(14,2) not null default 0,
  delivery_charge    numeric(14,2) not null default 0,
  subtotal           numeric(14,2) not null default 0,
  final_total        numeric(14,2) not null default 0,
  validity_date      date,
  remarks            text,
  status             vendor_quotation_status not null default 'pending',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger vendor_quotations_touch before update on vendor_quotations
  for each row execute function app.touch_updated_at();

create index vendor_quotations_po_idx on vendor_quotations (purchase_order_id);

create table vendor_purchase_receipts (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references vendor_purchase_orders (id) on delete restrict,
  vendor_id         uuid not null references vendors (id) on delete restrict,
  received_date     date not null default current_date,
  received_by       uuid references users (id) on delete set null,
  received_by_name  text,
  remarks           text,
  created_at        timestamptz not null default now()
);

create index vendor_receipts_po_idx on vendor_purchase_receipts (purchase_order_id);

create table vendor_purchase_receipt_items (
  id                       uuid primary key default gen_random_uuid(),
  purchase_receipt_id      uuid not null references vendor_purchase_receipts (id) on delete cascade,
  purchase_order_item_id   uuid not null references vendor_purchase_order_items (id) on delete restrict,
  received_qty             numeric(12,3) not null default 0,
  rejected_qty             numeric(12,3) not null default 0,
  unit_price               numeric(14,2),
  total                    numeric(14,2),
  remarks                  text
);

create index vendor_receipt_items_receipt_idx on vendor_purchase_receipt_items (purchase_receipt_id);

-- vendor_payments carries finance_doc_status columns, not the spec's own
-- PENDING/RECORDED/CONFIRMED/CANCELLED enum — see the note at the top of
-- this file. It becomes a real finance document (draft → pending_approval →
-- approved → posted, ledger_entry_id filled on posting) once Phase 7 wires
-- it through approveDocument(), exactly like partner_expenses.
create table vendor_payments (
  id                 uuid primary key default gen_random_uuid(),
  payment_no         text not null unique default app.next_finance_number('vendor_payment', 'VPAY'),
  vendor_id          uuid not null references vendors (id) on delete restrict,
  purchase_order_id  uuid references vendor_purchase_orders (id) on delete set null,
  amount             numeric(14,2) not null check (amount > 0),
  payment_method     text not null,
  account            finance_account not null,
  transaction_reference text,
  payment_date       date not null default current_date,
  status             finance_doc_status not null default 'pending_approval',
  notes              text,
  created_by         uuid references users (id) on delete set null,
  created_by_name    text,
  approved_by        uuid references users (id) on delete set null,
  approved_by_name   text,
  approved_at        timestamptz,
  rejection_reason   text,
  ledger_entry_id    uuid references ledger_entries (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid references users (id) on delete set null,
  deleted_by_name    text,
  delete_reason      text
);

create trigger vendor_payments_touch before update on vendor_payments
  for each row execute function app.touch_updated_at();

create index vendor_payments_vendor_idx on vendor_payments (vendor_id, payment_date desc);
create index vendor_payments_po_idx on vendor_payments (purchase_order_id) where purchase_order_id is not null;
create index vendor_payments_status_idx on vendor_payments (status) where deleted_at is null;
