# Cash Transfers — branch handovers to the company

Migration `20260924000118_cash_transfers.sql` (table, two RPCs) and
`20260924000119_cash_transfer_notifications.sql` (two `notification_type`
values). Both must be applied (`npx supabase db push --linked`) before this code
is deployed; until then every cash-transfer endpoint answers 503 naming the
migration.

## What it is

A branch records money it handed to the company — cash, Easypaisa or a bank
transfer — with a photograph of the slip. Finance approves or rejects it. An
approval posts **one** `RV-` receipt to the Daily Ledger under the system head
`INC-BRANCH-CASH` ("Cash Received from Branch") **in the same database
transaction** that marks the transfer approved (`approve_cash_transfer`), so the
book and the record cannot disagree and no voucher number is consumed by a
failed approval.

The transfer is its own transaction. It never adds to or subtracts from a sale,
a demand, a discount or a previous order balance. The production slip's
"Previous Order Balance" block gains two **display-only** lines — Payment
Received (approved transfers in the slip's window) and Remaining Balance
(`amountToCollect − paymentsReceived`, floored at zero) — and `amountToCollect`
itself is unchanged.

## Lifecycle

```
pending ──approve──▶ approved   (voucher_no, ledger_entry_id set; final)
   └─────reject───▶ rejected   (rejection_reason set; row and photo kept; final)
```

A pending transfer cannot be edited by the branch: the photo is evidence of one
specific handover. A wrong one is rejected (the branch sees the reason) and
raised again.

## Photo

Uploaded first, staged: `POST /api/attachments` with `entity=cash_transfer`
(branch roles and super_admin). The create request carries the returned id in
`attachmentIds` (at least one, at most `ATTACHMENT_MAX_PER_ENTITY`). The Daily
Ledger resolves the same photo from the voucher's `(source_type, source_id)`;
nothing is copied.

## Endpoints

All require `Authorization: Bearer <jwt>`. Rows are camelCase; `business_date`
is returned as `date`; `amount` is a number.

### Branch — `/api/cash-transfers`

Mounted behind `requireRole('super_admin', ...BRANCH_ROLES)`. A branch role is
pinned to its own `branchId` from the JWT; only an admin may pass
`?branchId=`. Any other branch's row answers 404.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/` | `days` (default 90, 1–365), `from`, `to`, `status`, `paymentMethod`, `search`, `sortBy`, `sortDir`, `limit` (≤200), `offset` | `{ transfers: CashTransfer[], total }` |
| GET | `/:id` | — | `CashTransfer` · 404 |
| POST | `/` | `{ amount, paymentMethod: 'cash'\|'easypaisa'\|'bank_account', note?, attachmentIds: uuid[], businessDate? }` — header `Idempotency-Key` optional (the mobile app's client operation id) | 201 `CashTransfer` |

POST errors: 400 validation (Zod), 400 future / out-of-window / closed business
date, 409 a staged photo is no longer available, 422 / 503 idempotency
mismatch / in-flight (see `middleware/idempotency.ts`).

Sort keys: `date`, `createdAt`, `approvedAt`, `transferNo`, `voucherNo`,
`branchName`, `amount`, `paymentMethod`, `status`. Search covers transfer no,
voucher no, branch name and note.

### Finance — `/api/finance/cash-transfers`

Registered **before** the general `/api/finance` router.

| Method | Path | Gate | Body / query | Response |
|---|---|---|---|---|
| GET | `/` | `requireFinance('view')` | as the branch list plus `branchId`; default window is the last 30 business days unless `status=pending` (then the whole queue) | `{ transfers, total }` |
| GET | `/:id` | `requireFinance('view')` | — | `CashTransfer` · 404 |
| PUT | `/:id/approve` | `requireFinance('approve')` | `{ note? }` | `{ transfer, ledgerEntry }` |
| PUT | `/:id/reject` | `requireFinance('approve')` | `{ reason }` (≥ 3 chars) | `{ transfer }` |

Decision errors: 403 no approve permission (super_admin needs the Finance
Settings write toggle, as for every finance document); 404 unknown id; 409
already decided, or the finance day is closed (P0001 → 409); 503 migration 118
not applied.

Both decisions write a `finance_audit_logs` row (`entity: 'cash_transfer'`,
action `approved` / `rejected`) and a `cash_transfer_reviewed` notification to
the branch. A create writes one `cash_transfer` notification per approving
finance role (`finance_admin`, `finance_manager`).

### Ledger date

The receipt is dated the transfer's `business_date`. If Finance has already
closed that day, it is dated the approval day instead (the caller's current
business date); if that is closed too, the approval is refused with 409 and
the transfer stays pending — nothing partial is left behind.

### Production slip

`GET /api/production-orders/:id/previous-balance` now also returns
`paymentsReceivedValue`, `paymentItems[]` (`transferId`, `transferNo`,
`voucherNo`, `date`, `paymentMethod`, `amount`) and `remainingBalance`. The
window is the one returns and discounts already use — after the previous order
was placed, up to and including this one — so each transfer lands on exactly
one slip. The Collections export gains "Payment Received" and "Remaining"
columns after "Amount to Collect".

## Authorisation summary

| Role | Create | See own branch | See all | Approve / reject |
|---|---|---|---|---|
| branch_manager / branch_user | ✓ | ✓ | — | — |
| finance_admin / finance_manager | — | — | ✓ | ✓ |
| accountant / finance_auditor | — | — | ✓ | — |
| super_admin | ✓ (with `?branchId=`) | — | ✓ | only with `allowSuperAdminWrite` |

The RLS policy on `cash_transfers` is a floor under a direct client read; the
API reaches the table on the service-role key and enforces the above in code.

## Rollback

Both migrations are additive. To back out: drop the two functions and the
table (`ledger_entries` rows already posted stay — the ledger is append-only,
and they carry `source_type = 'cash_transfer'`); enum values cannot be removed
and are harmless left in place.
