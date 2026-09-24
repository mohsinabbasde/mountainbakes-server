# WhatsApp Business integration — audit and architecture

Full spec: `../frontend/.claude/ProjectMDFiles/whatsappUI.md` (155 sections, 10 phases). This
doc is the living account of what actually exists, in this repo's own convention (a flat
top-level `*.md`, like `DATA-ENGINE.md` / `PRINTING.md` — not the spec's literal `docs/`
suggestion, which doesn't match how this repo organizes cross-cutting docs).

## Phase 1 — audit (what already exists)

### Outbound messaging already has a WhatsApp channel — via Twilio, not Meta directly

`src/services/messaging/`:

- `provider.ts` — `OutboundChannel = 'whatsapp' | 'sms'` is already a first-class value, and
  the module comment already names swapping in "WhatsApp Business API" as the reason this
  interface exists. `MessageProvider { name, send(msg: OutboundMessage): Promise<SendResult> }`.
- `twilio.provider.ts` — sends WhatsApp **today**, through Twilio's WhatsApp channel
  (`whatsapp:` prefix, `TWILIO_WHATSAPP_FROM`), with a comment already flagging Meta's 24-hour
  session window / template-message rule and Twilio's error 63016 for it.
- `log.provider.ts` — channel-agnostic fallback, logs instead of sending.
- `index.ts` — `getMessageProvider()` picks `'twilio' | 'log'` from `NOTIFICATION_PROVIDER`;
  `sendWithRetry()` / `getRetryPolicy()` already exist.
- Callers today: `closing-notifications.service.ts` (2 AM staff summaries),
  `order-notifications.service.ts` (per-order customer SMS confirmation). Both gated by
  settings toggles defaulting OFF, both text-only.

**What this buys the new work, and what it doesn't:** `OutboundMessage`/`SendResult`/
`MessageProvider` are generic enough that a native Meta Cloud API provider can sit next to
`TwilioProvider` without changing the interface shape. What it does NOT cover — genuinely new
surface area, not a drop-in adapter:

- `OutboundMessage.body` is a plain string. Meta's Cloud API is template/media/interactive
  oriented (template name + positional params, buttons, media IDs) — a single string field
  doesn't represent that.
- There is no inbound side at all today. No webhook receiver, no delivery-status callback
  handling, no contact/conversation model. Everything under `services/messaging/` is
  outbound-send-and-forget.
- No `WHATSAPP_*` / `META_*` env vars exist yet (`.env.example` only has `TWILIO_*` +
  `NOTIFICATION_PROVIDER`/`NOTIFICATION_RETRY_*`). A direct-to-Meta credential set is new
  naming, not an extension of an existing one.
- No Meta/WhatsApp SDK is installed (`package.json` has no `whatsapp*`/`meta*`/`graph-api`
  dependency; Twilio itself isn't a dependency either — `twilio.provider.ts` calls Twilio's
  REST API via `fetch`).

**Decision:** build the Meta Cloud API integration as its own service tree
(`services/whatsapp/`), independent of `services/messaging/`'s Twilio-SMS path. They are
different transports with different message shapes; forcing Meta traffic through the
`OutboundChannel`/`MessageProvider` interface built for one-way SMS/Twilio-WhatsApp text sends
would strain that interface for no reuse benefit. `services/messaging/` is untouched.

### Vendor / procurement: zero existing concept

Searched all of `src/**/*.ts` and `supabase/migrations/*.sql` for vendor/supplier/purchase
order/procurement:

- **Zero** matches for "vendor" anywhere.
- **Zero** matches for "purchase order" / "procurement".
- **One** match for "supplier": `production_expenses.supplier` — a free-text nullable label
  on a central-kitchen expense row (migration `20260719000003_orders_expenses.sql:154`). No
  vendor table, no FK, no vendor master data, no link to any payable/purchase concept.

This is entirely new schema and business logic — nothing to reuse or extend here, per the
spec's own §3 ("do not create duplicate versions of existing data").

### Payment methods (Cash / EasyPaisa / Bank): already fully modeled — reuse, don't rebuild

`src/shared/types/finance.types.ts` already has exactly the taxonomy the spec asks for in
§31–§37:

```ts
FINANCE_ACCOUNTS = ['cash', 'bank']                                    // which pot the money moved through
FINANCE_PAYMENT_METHODS = ['cash', 'easypaisa', 'bank_transfer', 'cheque', 'foodpanda', 'online', 'other']
```

Both back the finance ledger's running balance and daily-closing split already. **Decision:**
`vendor_payments` reuses `finance_account` / `finance_payment_method` directly — no new
payment-method enum, no new "Payment Accounts" concept. What's genuinely new is the
vendor-payable side: attaching an existing payment method/account to a vendor purchase.

### Vendor payments belong in the existing finance document lifecycle, not a bespoke status enum

The spec's §36 proposes payment statuses `PENDING / RECORDED / CONFIRMED / CANCELLED`. This
repo already has a battle-tested equivalent — `FinanceDocStatus`
(`draft → pending_approval → approved → posted`, or `rejected`) — plus the shared
`approveDocument()` / `rejectDocument()` / `assertEditable()` machinery in
`finance-documents.service.ts` that every other document type (`finance_transactions`,
`partner_expenses`, `salary_payments`, ...) already uses to post to the immutable
`ledger_entries` table. Per the spec's own instruction (§3, §154: money records are Finance's
job, WhatsApp is only the channel), `vendor_payments` will be modeled as a new `LedgerSourceType`
alongside `partner_expense`, reusing that same approve → post pipeline, rather than inventing a
parallel, unaudited payment status machine. This is a Phase 7 (Finance) decision documented
here now because it shapes the Phase 2 schema below (status/approval columns on
`vendor_payments` match `FinanceDocStatus` shape from day one).

### Vendor ledger: computed on read, not stored

`getPartnerShareSummary()` already establishes the pattern this codebase uses for "running
balance across many transactions": compute from the posted ledger + transaction rows at read
time, never store a running-balance table. A stored `vendor_ledger_entries` table would be a
second source of truth that drifts from `ledger_entries` the first time a payment is reversed.
**Decision:** no `vendor_ledger_entries` table. A vendor's balance = purchase order totals
minus posted `vendor_payments`, computed the same way Partner Share Detail is.

### Attachments: reuse the existing entity, don't build new photo storage

`ATTACHMENT_ENTITIES` (`src/shared/types/attachment.types.ts`) already covers every
photo-evidence site in the app through one bucket/signing/binding pipeline
(`services/attachments.service.ts`). **Decision:** add `vendor_purchase_receipt` and
`vendor_payment` to that enum rather than building separate WhatsApp media storage for
business documents. Inbound WhatsApp media (a vendor's photo of stock, a delivery note) is a
different case — those arrive unsolicited via webhook, not captured by a staff member — and
will get their own `whatsapp_messages.media_id` handling, storing to the same private bucket
under a `whatsapp_inbound` prefix, but is NOT bound through `bindAttachments()` (that flow
assumes a staff-uploaded, staged-then-claimed photo; a vendor's inbound media has no "claiming"
step — it's already tied to its message the moment the webhook processes it).

### Migration numbering

Convention: `YYYYMMDDNNNNNN_description.sql`, with the 6-digit counter — not the date —
being what actually increments run to run. Latest in the repo: `…000114`. Next: `…000115`.

### Mobile app (`../mobile`) — real and active, but zero existing surface for any of this

Audited separately (read-only). Summary: a genuine, actively-developed offline-first
React Native app (React Navigation v7, TanStack Query, op-sqlite, ~3 weeks of dense commits),
not a scaffold. It already has a `Vendors` tab/route entry — but `screenRegistry.tsx` carries
an explicit comment: *"NO SERVER RESOURCE EXISTS ... no vendors router, no service, no table
and no migration."* No Purchase feature, no Payment module, no messaging/chat/push
infrastructure of any kind exists in the mobile app today (confirmed: no WhatsApp/chat/push
SDK in `package.json`). This is Phase 9 territory — out of scope until Phases 1–8 land on the
server and web frontend, since the mobile app's own placeholder already correctly identifies
what it's blocked on.

## Phases actually being executed, and in what order

Per the spec's own §155 recommended order, adapted to this codebase's realities above:

1. **Audit** — this document. ✅
2. **Data model** — one migration adding the WhatsApp core tables + vendor procurement
   tables. See `supabase/migrations/…_whatsapp_and_vendor_procurement.sql`.
3. **Meta integration** — `services/whatsapp/` (client, webhook, contacts, conversations,
   messages, media, templates, status, queue/retry). Needs real Meta credentials in
   `WHATSAPP_*` env vars (never committed — same pattern as `TWILIO_*`/`SUPABASE_*`) before
   live sending/receiving can be verified; the code itself does not require secrets to write
   or typecheck.
4. **Vendor procurement API + Production UI** (web) — purchase requests, quotations,
   receiving, tied to the new schema.
5. **Branch ↔ Production WhatsApp notifications** — event-driven, off the existing demand/
   production-order lifecycle.
6. **Vendor payments in Finance** — reusing `approveDocument`/ledger posting.
7. **Automation settings, queue/retry, idempotency hardening.**
8. **Mobile UI** — only once the server resource the app's own placeholder is waiting on
   exists.
9. **Testing, documentation, final report** against the spec's §151 acceptance checklist.

This file is updated as each phase lands, rather than written once and left stale.
