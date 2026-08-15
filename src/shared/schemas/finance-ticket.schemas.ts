import { z } from 'zod';
import { FINANCE_TICKET_PREFIXES } from '../types/finance.types';

/**
 * Finance Help Desk payloads.
 *
 * Kept apart from `support.schemas.ts` for the same reason the table is kept
 * apart from `support_tickets`: these are two products that happen to share a
 * shape, and merging them would put finance queries under admin control.
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

/** Help Desk → raise a query against a finance record. */
export const CreateFinanceTicketSchema = z.object({
  referenceNo: FinanceReferenceNoSchema,
  subject: z.string().trim().min(3, 'Give the query a short subject').max(200),
  message: z.string().trim().min(3, 'Please describe the issue').max(2000),
});
export type CreateFinanceTicketInput = z.infer<typeof CreateFinanceTicketSchema>;

/**
 * Help Desk → Finance Admin edits the query text or the internal note.
 *
 * `.refine` rather than making both optional and shrugging: a PATCH that sets
 * nothing is a caller bug, and answering it 200 OK hides the bug rather than
 * surfacing it.
 */
export const EditFinanceTicketSchema = z
  .object({
    subject: z.string().trim().min(3).max(200).optional(),
    message: z.string().trim().min(3).max(2000).optional(),
    resolutionNote: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update — send subject, message or resolutionNote.',
  });
export type EditFinanceTicketInput = z.infer<typeof EditFinanceTicketSchema>;

/** Help Desk → Finance Admin resolves or rejects the query. */
export const ResolveFinanceTicketSchema = z.object({
  status: z.enum(['resolved', 'rejected']),
  resolutionNote: z.string().trim().max(2000).optional().default(''),
});
export type ResolveFinanceTicketInput = z.infer<typeof ResolveFinanceTicketSchema>;

/** Help Desk → the queue filter. */
export const FinanceTicketQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'rejected', 'all']).optional().default('all'),
  referenceNo: z.string().trim().max(40).optional(),
  /** Raiser-scoped view; the route forces this on for non-admin roles. */
  mine: z.coerce.boolean().optional(),
});
export type FinanceTicketQueryInput = z.infer<typeof FinanceTicketQuerySchema>;
