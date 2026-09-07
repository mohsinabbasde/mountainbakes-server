import { z } from 'zod';
import { optionalAttachmentIds } from './attachment.schemas';
import {
  FINANCE_QUERY_PRIORITIES,
  FINANCE_QUERY_TYPES,
  FINANCE_RESOLUTION_TYPES,
  FINANCE_TICKET_PREFIXES,
  FINANCE_TICKET_STATUSES,
} from '../types/finance.types';
import type {
  FinanceQueryPriority,
  FinanceQueryType,
  FinanceTicketStatus,
} from '../types/finance.types';

/**
 * Finance Help Desk payloads.
 *
 * Kept apart from `support.schemas.ts` for the same reason the table is kept
 * apart from `support_tickets`: these are two products that happen to share a
 * shape, and the finance one carries a permission model the admin Support
 * Center does not — a Finance user may REPORT and DISCUSS, and only an Admin may
 * change the record behind the query (migration 94).
 */

const PREFIXES = FINANCE_TICKET_PREFIXES;

/**
 * A finance reference number: RV-000001, SAL-000012, …
 *
 * The prefix list is derived from FINANCE_TICKET_REFERENCES rather than typed
 * out, so adding a seventh referencable record is a one-line change in one
 * place. It includes the alternate prefixes, which is what keeps a query
 * raisable against a pre-migration-71 FV- voucher. Uppercased before matching —
 * a raiser who types `rv-000001` means the same voucher, and rejecting them over
 * case would be pure friction.
 */
export const FinanceReferenceNoSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^(${PREFIXES.join('|')})-\\d{1,10}$`),
    `Reference must look like ${PREFIXES.map((p) => `${p}-000001`).join(', ')}`,
  );

/**
 * The same, but blank-tolerant.
 *
 * A reference became OPTIONAL in migration 94: the brief's query types include
 * "Calculation Issue" and "Other", which by their nature name no single record.
 * An empty string from a form field is normalised to `undefined` BEFORE the
 * regex sees it — otherwise clearing the input would fail validation with a
 * message about voucher prefixes, which is not what went wrong.
 */
export const OptionalFinanceReferenceNoSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .pipe(FinanceReferenceNoSchema.optional())
  .optional();

/**
 * A money figure from a form field. Blank means "no amount", not zero — a query
 * about a missing voucher has no amount, and storing 0 for it would make the
 * Amount column claim the voucher was for nothing.
 */
const OptionalAmountSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (v === '' || v === null ? null : Number(v)))
  .pipe(
    z
      .number()
      .min(0, 'Amount cannot be negative')
      .max(9_999_999_999.99, 'Amount is too large')
      .nullable(),
  )
  .optional();

/** A short free-text handle: Transaction ID, Expense ID, Income ID, Voucher. */
const OptionalHandleSchema = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/** `YYYY-MM-DD`, blank-tolerant. */
const OptionalBusinessDateSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Business date must be YYYY-MM-DD').nullable())
  .nullable()
  .optional();

const OptionalUuidSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.string().uuid('Choose a branch from the list').nullable())
  .nullable()
  .optional();

/**
 * The FEED fields — everything the one centralised query form (§4) can set,
 * shared by create, edit, amend and recreate so the four never drift on what a
 * query may say. Each is optional here; create makes subject and description
 * required on top.
 *
 * `amount` is a statement ON THE QUERY (§17). It is never written to the finance
 * record; the route that changes a record is POST /:id/amend and takes a
 * different payload with its own reason.
 */
export const FinanceTicketFeedSchema = z.object({
  subject: z.string().trim().min(3, 'Give the query a short subject').max(200).optional(),
  queryType: z.enum(FINANCE_QUERY_TYPES).optional(),
  priority: z.enum(FINANCE_QUERY_PRIORITIES).optional(),
  description: z.string().trim().min(3, 'Please describe the issue').max(4000).optional(),
  amount: OptionalAmountSchema,
  branchId: OptionalUuidSchema,
  businessDate: OptionalBusinessDateSchema,
  remarks: z.string().trim().max(2000).transform((v) => (v === '' ? null : v)).nullable().optional(),
  /** `null` CLEARS the reference; `undefined` leaves it; a string must resolve. */
  referenceNo: z.union([z.null(), OptionalFinanceReferenceNoSchema]),
  /**
   * The brief's separate "Ledger/Voucher ID". Free text, never resolved: it is
   * the handle the raiser wants the admin to look at when it differs from the
   * reference, and constraining its shape would reject the perfectly useful
   * "the FV- voucher behind SAL-000012".
   */
  voucherRef: OptionalHandleSchema,
  transactionRef: OptionalHandleSchema,
  expenseRef: OptionalHandleSchema,
  incomeRef: OptionalHandleSchema,
});
export type FinanceTicketFeedInput = z.infer<typeof FinanceTicketFeedSchema>;

/** The feed keys, for routes that diff "what did this PATCH touch". */
export const FINANCE_TICKET_FEED_KEYS = Object.keys(FinanceTicketFeedSchema.shape) as (keyof FinanceTicketFeedInput)[];

/**
 * Help Desk → a Finance user raises a query. Goes straight to Admin — or, with
 * `draft: true`, stays with the raiser until they submit it (§2 Save Draft).
 */
export const CreateFinanceTicketSchema = FinanceTicketFeedSchema.extend({
  queryType: z.enum(FINANCE_QUERY_TYPES),
  priority: z.enum(FINANCE_QUERY_PRIORITIES).default('normal'),
  subject: z.string().trim().min(3, 'Give the query a short subject').max(200),
  description: z.string().trim().min(3, 'Please describe the issue').max(4000),
  attachmentIds: optionalAttachmentIds,
  draft: z.boolean().optional().default(false),
});
export type CreateFinanceTicketInput = z.infer<typeof CreateFinanceTicketSchema>;

/**
 * Help Desk → the RAISER edits their own draft. Same feed fields; no reason
 * needed, because nothing has been sent yet and nobody else has read it.
 */
export const EditFinanceDraftSchema = FinanceTicketFeedSchema.extend({
  attachmentIds: optionalAttachmentIds,
});
export type EditFinanceDraftInput = z.infer<typeof EditFinanceDraftSchema>;

/**
 * Help Desk → Admin edits the query text or the internal note.
 *
 * `.refine` rather than making every field optional and shrugging: a PATCH that
 * sets nothing is a caller bug, and answering it 200 OK hides the bug rather
 * than surfacing it.
 */
export const EditFinanceTicketSchema = FinanceTicketFeedSchema
  .extend({
    /** Alias kept for the pre-106 payload; `description` is the feed's name. */
    message: z.string().trim().min(3).max(4000).optional(),
    resolutionNote: z.string().trim().max(4000).optional(),
    /**
     * §6's "internal notes" — the admin's working notes on the query, never
     * shown to the raiser and never part of the resolution the raiser reads.
     * Appended to the audit trail like every other field on this PATCH.
     */
    internalNote: z.string().trim().max(4000).optional(),
    /**
     * Why the query itself was edited. Required by the route, not here: §8 asks
     * for a reason on an amendment, and an edit to the query TEXT is the same
     * kind of change to the same record — but a PATCH that only sets
     * `internalNote` is not amending anything a raiser will ever see.
     */
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => Object.entries(v).some(([k, val]) => k !== 'reason' && val !== undefined),
    { message: 'Nothing to update — send at least one field.' },
  );
export type EditFinanceTicketInput = z.infer<typeof EditFinanceTicketSchema>;

/**
 * Help Desk → ADMIN amends the query (§6). The same feed as an edit, but the
 * reason is required by the schema, the query is marked AMENDED, and a version
 * is written whether or not anything the raiser sees changed — an amendment is
 * an act on the record, and the record says so.
 */
export const AmendFinanceTicketSchema = FinanceTicketFeedSchema.extend({
  message: z.string().trim().min(3).max(4000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
  reason: z.string().trim().min(3, 'State why this query is being amended').max(1000),
});
export type AmendFinanceTicketInput = z.infer<typeof AmendFinanceTicketSchema>;

/**
 * Help Desk → ADMIN writes or updates the response block (§11) without moving
 * the status. Resolving still goes through PATCH /:id/status, which needs the
 * resolution type; this is for answering while the query stays live.
 */
export const FinanceTicketResponseSchema = z
  .object({
    adminResponse: z.string().trim().max(4000).optional(),
    resolutionNote: z.string().trim().max(4000).optional(),
    resolutionAmount: OptionalAmountSchema,
    remarks: z.string().trim().max(2000).optional(),
    internalNote: z.string().trim().max(4000).optional(),
  })
  .refine((v) => Object.values(v).some((val) => val !== undefined), {
    message: 'Nothing to save — write a response, a resolution, an amount or a note.',
  });
export type FinanceTicketResponseInput = z.infer<typeof FinanceTicketResponseSchema>;

/** Help Desk → ADMIN restores a soft-deleted query (§8). */
export const RestoreFinanceTicketSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this query is being restored').max(1000),
});
export type RestoreFinanceTicketInput = z.infer<typeof RestoreFinanceTicketSchema>;

/**
 * Help Desk → ADMIN recreates a query under a NEW Query ID (§9). The feed
 * fields are overrides applied on top of the copy; omit them all to copy the
 * query as it stands. The old ID is never reused — the database issues the new
 * one, and both rows point at each other.
 */
export const RecreateFinanceTicketSchema = FinanceTicketFeedSchema.extend({
  message: z.string().trim().min(3).max(4000).optional(),
  reason: z.string().trim().min(3, 'Say why this query is being recreated').max(1000),
  /** Copy the original's attachments onto the new query. Default on. */
  copyAttachments: z.boolean().optional().default(true),
});
export type RecreateFinanceTicketInput = z.infer<typeof RecreateFinanceTicketSchema>;

/**
 * Help Desk → Admin moves the query along.
 *
 * One endpoint for the whole workflow rather than a verb per transition
 * (/review, /await-info, /resolve, /reject, /close). The legal moves are a
 * property of the pair of statuses, and five routes would be five places to
 * re-derive the same table — see FINANCE_TICKET_TRANSITIONS on the route.
 *
 * `resolutionNote` is required by the route, not here, and only for a terminal
 * status: the check needs the CURRENT status, which the schema cannot see.
 */
export const FinanceTicketStatusSchema = z.object({
  status: z.enum(FINANCE_TICKET_STATUSES).exclude(['draft', 'amended', 'reopened']),
  adminResponse: z.string().trim().max(4000).optional(),
  resolutionNote: z.string().trim().max(4000).optional(),
  /** §11's Resolution Type. Required by the route when resolving; see there. */
  resolutionType: z.enum(FINANCE_RESOLUTION_TYPES).optional(),
  /** §11's Resolution Amount, stated on the query when resolving. */
  resolutionAmount: OptionalAmountSchema,
});
export type FinanceTicketStatusInput = z.infer<typeof FinanceTicketStatusSchema>;

/**
 * Help Desk → a resolved query is disputed and goes live again (§12).
 *
 * Its own endpoint rather than another target on FinanceTicketStatusSchema,
 * because reopening is not a status move that happens to be legal from a
 * terminal state — it has to ARCHIVE the resolution it is undoing (onto
 * `finance_tickets.resolution_history`) in the same write that clears it. Folded
 * into the status route, that archive step would be a branch every other
 * transition has to skip, and the one nobody notices is missing.
 *
 * `reason` is required and non-empty here, in the route, and in
 * `finance_tickets_reopen_check`. A resolution overturned without a stated
 * reason tells the next reader that the first answer was wrong and nothing
 * about why — which is the half that matters when it is reopened again.
 *
 * BOTH SIDES may call it, and they get different outcomes: an Admin reopens the
 * query, a Finance raiser records a REQUEST to reopen against their own query
 * (§12 — "Finance or Admin may request reopening depending on permissions").
 * The route decides which from the JWT; the payload is the same either way.
 */
export const ReopenFinanceTicketSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this query is being reopened').max(1000),
});
export type ReopenFinanceTicketInput = z.infer<typeof ReopenFinanceTicketSchema>;

/** Help Desk → either side adds a message to the conversation. */
export const FinanceTicketMessageSchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(4000),
  attachmentIds: optionalAttachmentIds,
});
export type FinanceTicketMessageInput = z.infer<typeof FinanceTicketMessageSchema>;

/**
 * Help Desk → ADMIN amends, overwrites or edits the finance record behind the
 * query. This is the payload that changes the books.
 *
 * `reason` is required and non-empty at every layer — here, in the route, and in
 * `finance_amendments`' own CHECK constraint. The brief's §21 asks that every
 * admin change be traceable to the issue that prompted it, and a correction with
 * no stated reason is traceable to a click.
 *
 * `confirmOverwrite` exists only for `overwrite`. §11 requires an explicit
 * acknowledgement before an APPROVED financial record is written over, and a
 * confirmation the server cannot see is a dialog, not a control: the checkbox
 * has to reach the API or it guards nothing.
 */
export const AmendFinanceRecordSchema = z
  .object({
    action: z.enum(['edit', 'amend', 'overwrite']),
    field: z.string().trim().min(1).max(60),
    newValue: z.string().trim().max(500),
    reason: z.string().trim().min(3, 'State why this record is being changed').max(2000),
    confirmOverwrite: z.boolean().optional(),
  })
  .refine((v) => v.action !== 'overwrite' || v.confirmOverwrite === true, {
    path: ['confirmOverwrite'],
    message:
      'An overwrite of an approved financial record must be confirmed. ' +
      'The action is recorded in the audit trail.',
  });
export type AmendFinanceRecordInput = z.infer<typeof AmendFinanceRecordSchema>;

/**
 * Help Desk → ADMIN deletes the finance record behind the query.
 *
 * Soft, always (§10, migration 94): the row is stamped and stays readable to an
 * admin. There is no hard-delete payload because there is no hard-delete route.
 */
export const DeleteFinanceRecordSchema = z.object({
  reason: z.string().trim().min(3, 'State why this record is being deleted').max(2000),
  confirmDelete: z
    .boolean()
    .refine((v) => v === true, 'Deleting a financial record must be confirmed.'),
});
export type DeleteFinanceRecordInput = z.infer<typeof DeleteFinanceRecordSchema>;

/** Help Desk → ADMIN takes a query, or hands it to another admin. */
export const AssignFinanceTicketSchema = z.object({
  /** Null unassigns — the brief's "Unassigned" admin card is what reads it. */
  assignedTo: z.string().uuid().nullable(),
});
export type AssignFinanceTicketInput = z.infer<typeof AssignFinanceTicketSchema>;

/**
 * Help Desk → the queue filter (§19).
 *
 * Every one of these NARROWS what the caller may already see. None of them
 * widens it: the route scopes a Finance user to their own queries from the JWT
 * before any of this is applied, so `mine=false` from an accountant changes
 * nothing.
 */
/**
 * The filter vocabularies: the stored values plus the 'all' sentinel.
 *
 * Written out rather than spread from the shared constants. `z.enum` needs a
 * literal tuple, and `[...CONST, 'all']` is a spread whose tuple-ness
 * TypeScript preserves only in some positions — where it does not, the enum
 * degrades to `string` and the filter silently stops validating. A drifted
 * value here is caught by the `satisfies` on each line.
 */
const STATUS_FILTERS = [
  'draft', 'open', 'under_review', 'waiting_for_finance', 'amended', 'reopened',
  'resolved', 'rejected', 'closed', 'all',
] as const satisfies readonly (FinanceTicketStatus | 'all')[];

const QUERY_TYPE_FILTERS = [
  'income', 'expense', 'company_transaction', 'partner_advance', 'company_share',
  'branch_share', 'salary', 'ledger', 'payment', 'stock_finance_difference',
  'calculation_issue', 'other', 'all',
] as const satisfies readonly (FinanceQueryType | 'all')[];

const PRIORITY_FILTERS = [
  'low', 'normal', 'high', 'urgent', 'all',
] as const satisfies readonly (FinanceQueryPriority | 'all')[];

export const FinanceTicketQuerySchema = z.object({
  status: z.enum(STATUS_FILTERS).optional().default('all'),
  queryType: z.enum(QUERY_TYPE_FILTERS).optional().default('all'),
  priority: z.enum(PRIORITY_FILTERS).optional().default('all'),
  /** Matches the Query ID, the reference, or the voucher/ledger handle. */
  search: z.string().trim().max(80).optional(),
  referenceNo: z.string().trim().max(40).optional(),
  raisedBy: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Raiser-scoped view; the route forces this on for non-admin roles. */
  mine: z.coerce.boolean().optional(),
  /** Admin-only: show soft-deleted queries too. Ignored for everyone else. */
  includeDeleted: z.coerce.boolean().optional(),
  /** Admin-only: ONLY soft-deleted queries — the Deleted Queries screen (§8). */
  deletedOnly: z.coerce.boolean().optional(),
  branchId: z.string().uuid().optional(),
  /** Exact Query ID. `search` matches partially; this is for a scanned/pasted one. */
  queryNo: z.string().trim().max(40).optional(),
  amountMin: z.coerce.number().min(0).optional(),
  amountMax: z.coerce.number().min(0).optional(),
  /** Server-side pagination (§19). One-based; capped so a page is never the table. */
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});
export type FinanceTicketQueryInput = z.infer<typeof FinanceTicketQuerySchema>;
