import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance, requireFinanceTicketAdmin } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  CreateFinanceTicketSchema,
  EditFinanceTicketSchema,
  FINANCE_TICKET_PREFIX_MAP,
  FINANCE_TICKET_REFERENCES,
  ResolveFinanceTicketSchema,
  type FinanceAuditEntity,
  type FinanceTicketReferenceLookup,
  type FinanceTicketReferenceType,
} from '../shared';
import { notify } from '../services/push.service';
import { logFinanceAudit } from '../services/finance-audit.service';
import { rowToApi } from '../utils/case';

/**
 * /api/finance/tickets — the Finance Help Desk.
 *
 * An Accountant or Finance Manager raises a query against a finance record; the
 * Finance Admin resolves, rejects, edits or deletes it. Branch and production
 * users never reach any of it: every route sits behind `requireFinance`, which
 * returns false for them on every permission including `view`.
 *
 * Two things are deliberate and worth not "tidying" later:
 *
 *   1. The snapshot is the WHOLE source row, not a hand-picked subset. Picking
 *      columns means guessing which ones matter to whoever reads the query in
 *      three months, and silently losing a column when the source table grows.
 *   2. Delete is a real delete, and a destructive one. The brief asks for it,
 *      and the query queue is not the ledger. The append-only trail records
 *      that a given ticket was deleted and by whom, but NOT what it said — so
 *      the deletion is traceable while the query's text is genuinely gone.
 */

export const router = Router();

router.use(authenticate);

/** A raiser sees their own queue; the resolver and the auditor see all of it. */
function seesWholeQueue(role: string): boolean {
  return role === 'finance_admin' || role === 'finance_auditor' || role === 'super_admin';
}

class LookupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Resolve `FV-000001` to the row it names.
 *
 * The prefix decides the table, so the raiser types one reference and never has
 * to say what kind of record it is. An unknown prefix is a 400 (the caller sent
 * something malformed); a well-formed reference that matches nothing is a 404
 * (they sent something reasonable that does not exist) — the two are different
 * problems for the person typing, and collapsing them makes the Help Desk say
 * "invalid" to a voucher number that is merely from another branch's book.
 */
async function resolveReference(refRaw: string): Promise<FinanceTicketReferenceLookup> {
  const referenceNo = refRaw.trim().toUpperCase();
  const prefix = referenceNo.split('-')[0] ?? '';
  const referenceType = FINANCE_TICKET_PREFIX_MAP[prefix] as FinanceTicketReferenceType | undefined;

  if (!referenceType) {
    const known = Object.values(FINANCE_TICKET_REFERENCES).map((r) => r.prefix).join(', ');
    throw new LookupError(`Unknown reference type "${prefix}". Expected one of: ${known}.`, 400);
  }

  const { table, refColumn, label } = FINANCE_TICKET_REFERENCES[referenceType];
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .eq(refColumn, referenceNo)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new LookupError(`No ${label.toLowerCase()} found for ${referenceNo}.`, 404);

  return {
    referenceType,
    referenceId: data.id as string,
    referenceNo,
    label,
    snapshot: rowToApi(data) as Record<string, unknown>,
  };
}

async function getTicket(id: string) {
  const { data, error } = await supabaseAdmin
    .from('finance_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Lookup — preview the record before raising the query
// ---------------------------------------------------------------------------

router.get('/lookup', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ref = String(req.query['ref'] ?? '').trim();
    if (!ref) {
      res.status(400).json({ error: 'Reference number is required' });
      return;
    }
    res.json({ reference: await resolveReference(ref) });
  } catch (err) {
    if (err instanceof LookupError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('finance_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    // Scoping is decided by role, never by a query parameter — a raiser cannot
    // widen their own view by asking for it.
    if (!seesWholeQueue(req.user!.role)) {
      query = query.eq('raised_by', req.user!.uid);
    }

    const status = String(req.query['status'] ?? 'all');
    if (status !== 'all' && ['open', 'resolved', 'rejected'].includes(status)) {
      query = query.eq('status', status);
    }
    const referenceNo = String(req.query['referenceNo'] ?? '').trim().toUpperCase();
    if (referenceNo) query = query.eq('reference_no', referenceNo);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ tickets: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (!seesWholeQueue(req.user!.role) && ticket.raised_by !== req.user!.uid) {
      res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
      return;
    }
    res.json({ ticket: rowToApi(ticket) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Raise — `create` covers Accountant and Finance Manager, and excludes the
// Read Only Auditor, without this route having to name roles itself.
// ---------------------------------------------------------------------------

router.post('/', requireFinance('create'), validate(CreateFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { referenceNo, subject, message } = req.body;

    let reference: FinanceTicketReferenceLookup;
    try {
      reference = await resolveReference(referenceNo);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }

    const { data, error } = await supabaseAdmin
      .from('finance_tickets')
      .insert({
        reference_type: reference.referenceType,
        reference_id: reference.referenceId,
        reference_no: reference.referenceNo,
        reference_snapshot: reference.snapshot,
        subject,
        message,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.ticket_no,
      action: 'created',
      newValues: { referenceNo: reference.referenceNo, subject, message },
    });

    // Best-effort: a notification that fails must not lose the query.
    try {
      await notify({
        type: 'finance_query',
        title: `New finance query ${data.ticket_no}`,
        message: `${req.user!.email} raised a query on ${reference.referenceNo}: ${subject}`,
        targetRole: 'finance_admin',
        relatedId: data.id,
      });
    } catch { /* notification failure must not fail ticket creation */ }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Administer — Finance Admin only, from here down
// ---------------------------------------------------------------------------

router.patch('/:id', requireFinanceTicketAdmin(), validate(EditFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (req.body.subject !== undefined) patch['subject'] = req.body.subject;
    if (req.body.message !== undefined) patch['message'] = req.body.message;
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;

    const { data, error } = await supabaseAdmin
      .from('finance_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.ticket_no,
      action: 'updated',
      previousValues: {
        subject: before.subject,
        message: before.message,
        resolutionNote: before.resolution_note,
      },
      newValues: patch,
    });

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/resolve', requireFinanceTicketAdmin(), validate(ResolveFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, resolutionNote } = req.body;

    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    // Re-closing an already-closed query would overwrite who closed it and when,
    // which is the one fact the queue exists to record.
    if (before.status !== 'open') {
      res.status(409).json({
        error: `Query ${before.ticket_no} is already ${before.status}. Reopening is not supported — raise a new query.`,
      });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('finance_tickets')
      .update({
        status,
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.ticket_no,
      action: status === 'rejected' ? 'rejected' : 'resolved',
      previousValues: { status: before.status },
      newValues: { status, resolutionNote },
    });

    try {
      if (data.raised_by) {
        await notify({
          type: 'finance_query_resolved',
          title: `Query ${data.ticket_no} ${status}`,
          message: resolutionNote || `Your query on ${data.reference_no} was ${status}.`,
          targetUserId: data.raised_by,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE — removes the query AND the finance record it was raised against.
 *
 * This is the destructive path, and it is destructive twice over. Deleting
 * FQ-000007 also deletes voucher FV-000001 from the ledger, permanently, via
 * delete_finance_ticket_source (migration 61) — which exists solely to punch
 * through the immutability trigger migration 52 installed. Reversal via
 * reverse_finance_ledger_entry remains the correct way to fix a wrong figure;
 * this is here because it was asked for explicitly.
 *
 * The trail records the FACT of both deletions — which ticket, which voucher,
 * by whom, when, from which IP — and deliberately NOT what the query said. No
 * subject, no message, no snapshot. Once gone, the query's text is not
 * recoverable from anywhere, which is the intent.
 *
 * Order matters and is deliberate:
 *
 *   1. audit the ticket deletion   — awaited, so an untraceable deletion cannot happen
 *   2. delete the source record    — the step that can fail on an FK still pointing at it
 *   3. audit the source deletion   — only once it actually happened
 *   4. delete the ticket row       — last, so a failure at (2) leaves the ticket in place
 *                                    and the operation is safe to retry
 *
 * Doing (4) first would, on a failure at (2), destroy the only handle anyone
 * had on the record that was supposed to go with it.
 */
router.delete('/:id', requireFinanceTicketAdmin(), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: ticket.id,
      entityRef: ticket.ticket_no,
      action: 'deleted',
      // previousValues intentionally omitted — see the note above.
    });

    // The referenced record goes first: it is the step that can fail.
    const { data: removed, error: sourceError } = await supabaseAdmin.rpc(
      'delete_finance_ticket_source',
      { p_reference_type: ticket.reference_type, p_reference_id: ticket.reference_id },
    );
    if (sourceError) throw sourceError;

    const source = (removed ?? {}) as {
      deleted?: boolean;
      referenceNo?: string;
      balancesRewritten?: number;
      closingBalance?: number | null;
    };
    if (source.deleted) {
      await logFinanceAudit(req, {
        // Every FinanceTicketReferenceType is also a FinanceAuditEntity, so the
        // trail names the record's own kind rather than flattening it.
        entity: ticket.reference_type as FinanceAuditEntity,
        entityId: ticket.reference_id,
        entityRef: source.referenceNo ?? ticket.reference_no,
        action: 'deleted',
        newValues: {
          deletedVia: 'finance_ticket',
          ticketNo: ticket.ticket_no,
          // Deleting a voucher rewrites the running balance on every later row
          // (migration 64). How many rows moved, and where the book landed, is
          // the part of a deletion an auditor most needs and cannot reconstruct
          // afterwards — the old balances are gone.
          ...(source.balancesRewritten
            ? { balancesRewritten: source.balancesRewritten, closingBalance: source.closingBalance ?? null }
            : {}),
        },
      });
    }

    const { error } = await supabaseAdmin.from('finance_tickets').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, sourceDeleted: Boolean(source.deleted), referenceNo: ticket.reference_no });
  } catch (err) {
    next(err);
  }
});
