import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import {
  requireFinance,
  requireFinanceHelpDeskAdmin,
  requireFinanceHelpDeskParticipant,
} from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  AmendFinanceRecordSchema,
  AssignFinanceTicketSchema,
  CreateFinanceTicketSchema,
  DeleteFinanceRecordSchema,
  EditFinanceTicketSchema,
  FINANCE_AMENDABLE_FIELDS,
  FINANCE_TICKET_PREFIX_MAP,
  FINANCE_TICKET_PREFIXES,
  FINANCE_TICKET_REFERENCES,
  FINANCE_TICKET_STATUS_LABELS,
  businessDateStr,
  FinanceTicketMessageSchema,
  FinanceTicketStatusSchema,
  ReopenFinanceTicketSchema,
  financeHelpDeskCan,
  isFinanceTicketTerminal,
  type FinanceAmendmentAction,
  type FinanceAuditEntity,
  type FinanceResolutionType,
  type FinanceTicketReferenceLookup,
  type FinanceTicketReferenceType,
  type FinanceTicketResolution,
  type FinanceTicketStatus,
} from '../shared';
import { notify } from '../services/push.service';
import { logFinanceAudit, requestFingerprint } from '../services/finance-audit.service';
import { bindAttachments, listAttachments, listAttachmentsFor } from '../services/attachments.service';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';

/**
 * /api/finance/tickets — the Finance Help Desk.
 *
 *     Finance User  →  Finance Help Desk  →  ADMIN
 *
 * A Finance user REPORTS, VIEWS and DISCUSSES. An Admin — and only an Admin —
 * responds, moves the query along, and changes, amends, overwrites or deletes
 * the finance record behind it. That is the brief's §21, and the split runs
 * through every route below: the reporting half sits behind `requireFinance`,
 * the acting half behind `requireFinanceHelpDeskAdmin`.
 *
 * Migration 94 reversed migration 60 here, and the reversal is the thing most
 * likely to surprise: the queue used to belong to `finance_admin`, and no longer
 * does. See requireFinanceHelpDeskAdmin's own header for why, and for why the
 * `allowSuperAdminWrite` toggle is deliberately not consulted.
 *
 * Four things are deliberate and worth not "tidying" later:
 *
 *   1. The snapshot is the WHOLE source row, not a hand-picked subset. Picking
 *      columns means guessing which ones matter to whoever reads the query in
 *      three months, and silently losing a column when the source table grows.
 *   2. A reference is OPTIONAL. "Calculation Issue" and "Other" name no single
 *      record, and forcing a raiser to invent one sends the admin to the wrong
 *      row.
 *   3. Nothing is destroyed. Delete is `soft_delete_finance_record` — a stamp —
 *      and the query itself is stamped too. Migration 60's real delete is gone.
 *   4. Every write that touches the BOOKS goes through one handler
 *      (`applyRecordChange`) so the amendment record, the audit row and the
 *      notification cannot be written for one verb and forgotten for another.
 */

export const router = Router();

router.use(authenticate);

/** A raiser sees their own queue; the admin and the auditor see all of it. */
function seesWholeQueue(role: string): boolean {
  return financeHelpDeskCan(role, 'respond') || role === 'finance_auditor';
}

/** Which side of the desk this caller speaks from, for the conversation thread. */
function sideOf(role: string): 'finance' | 'admin' {
  return financeHelpDeskCan(role, 'respond') ? 'admin' : 'finance';
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
 * The legal status moves.
 *
 * A table rather than five verb-routes (/review, /await-info, /resolve, …): the
 * legality of a move is a property of the PAIR, and five routes would be five
 * places to re-derive the same fact and four chances to disagree.
 *
 * Note what is absent from every terminal status, and from `reopened` as a
 * TARGET: there is no way into or out of a terminal state through this table.
 * Reopening (§12) is a real transition but not one of these — it has to archive
 * the resolution it is undoing before clearing it, so it lives on its own route
 * (POST /:id/reopen) and writes `reopened` itself. Listing it here as well would
 * be a second door into the same room, and only one of them keeps the history.
 */
const FINANCE_TICKET_TRANSITIONS: Record<FinanceTicketStatus, FinanceTicketStatus[]> = {
  open: ['under_review', 'rejected', 'resolved'],
  under_review: ['waiting_for_finance', 'resolved', 'rejected'],
  waiting_for_finance: ['under_review', 'resolved', 'rejected'],
  // A reopened query rejoins the workflow exactly where a fresh one under
  // investigation sits — §12's REOPENED → UNDER_REVIEW — and can be answered
  // again from there without passing back through `open`.
  reopened: ['under_review', 'waiting_for_finance', 'resolved', 'rejected'],
  resolved: ['closed'],
  rejected: ['closed'],
  closed: [],
};

/**
 * The statuses a query may be REOPENED from — the terminal three.
 *
 * Separate from the table above on purpose: this is the one move that is legal
 * *out* of a terminal status, and keeping it out of `FINANCE_TICKET_TRANSITIONS`
 * is what stops PATCH /:id/status from ever performing it. See migration 95.
 */
const FINANCE_TICKET_REOPENABLE: readonly FinanceTicketStatus[] = ['resolved', 'rejected', 'closed'];

/**
 * The row as this caller may see it.
 *
 * `internal_note` is the admin's working note (§6) and is stripped for everyone
 * else HERE, at the boundary, rather than by the UI declining to render it — a
 * note the raiser must not read is not protected by a component, because the row
 * still crosses the wire either way.
 */
function ticketForCaller<T extends Record<string, unknown>>(row: T, isAdmin: boolean) {
  if (isAdmin) return rowToApi(row);
  const { internal_note: _internalNote, ...visible } = row;
  return rowToApi(visible);
}

/**
 * Resolve `RV-000001` to the row it names.
 *
 * The prefix decides the table, so the raiser types one reference and never has
 * to say what kind of record it is. An unknown prefix is a 400 (the caller sent
 * something malformed); a well-formed reference that matches nothing is a 404
 * (they sent something reasonable that does not exist) — the two are different
 * problems for the person typing, and collapsing them makes the Help Desk say
 * "invalid" to a voucher number that is merely from another branch's book.
 *
 * A soft-deleted record still resolves, and says so. Refusing it would make the
 * one query most worth raising — "where did this voucher go?" — the one query
 * that cannot be raised.
 */
async function resolveReference(refRaw: string): Promise<FinanceTicketReferenceLookup> {
  const referenceNo = refRaw.trim().toUpperCase();
  const prefix = referenceNo.split('-')[0] ?? '';
  const referenceType = FINANCE_TICKET_PREFIX_MAP[prefix] as FinanceTicketReferenceType | undefined;

  if (!referenceType) {
    const known = FINANCE_TICKET_PREFIXES.join(', ');
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

/** The live row behind a query, deleted or not — the admin's working copy. */
async function liveReference(
  referenceType: FinanceTicketReferenceType | null,
  referenceId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!referenceType || !referenceId) return null;
  const { table } = FINANCE_TICKET_REFERENCES[referenceType];
  const { data, error } = await supabaseAdmin.from(table).select('*').eq('id', referenceId).maybeSingle();
  if (error) throw error;
  return data ? (rowToApi(data) as Record<string, unknown>) : null;
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

/** May this caller read this query at all? */
function canSee(req: AuthRequest, ticket: Record<string, unknown>): boolean {
  if (seesWholeQueue(req.user!.role)) return true;
  return ticket['raised_by'] === req.user!.uid;
}

// ---------------------------------------------------------------------------
// Lookup — preview the record before raising the query (§13)
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
// The queue (§4, §18, §19)
// ---------------------------------------------------------------------------

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');

    let query = supabaseAdmin
      .from('finance_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    // A stamped query is an ADMIN view and off by default even for them: the
    // queue is a list of work, and deleted rows are not work.
    if (!(isAdmin && String(req.query['includeDeleted'] ?? '') === 'true')) {
      query = withoutDeleted(query);
    }

    // Scoping is decided by ROLE, never by a query parameter — a raiser cannot
    // widen their own view by asking for it, and every filter below only
    // narrows what this line already allowed.
    if (!seesWholeQueue(req.user!.role)) query = query.eq('raised_by', req.user!.uid);
    else if (String(req.query['mine'] ?? '') === 'true') query = query.eq('raised_by', req.user!.uid);

    const eq = (param: string, column: string) => {
      const v = String(req.query[param] ?? 'all');
      if (v && v !== 'all') query = query.eq(column, v);
    };
    eq('status', 'status');
    eq('queryType', 'query_type');
    eq('priority', 'priority');
    eq('raisedBy', 'raised_by');

    const referenceNo = String(req.query['referenceNo'] ?? '').trim().toUpperCase();
    if (referenceNo) query = query.eq('reference_no', referenceNo);

    const from = String(req.query['from'] ?? '').trim();
    const to = String(req.query['to'] ?? '').trim();
    if (from) query = query.gte('created_at', `${from}T00:00:00.000Z`);
    if (to) query = query.lte('created_at', `${to}T23:59:59.999Z`);

    // Free text across the three handles a person actually remembers. PostgREST
    // `or` takes a comma-separated filter list; the term is escaped for the
    // commas and parentheses that would otherwise break out of it.
    const search = String(req.query['search'] ?? '').trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) {
        query = query.or(
          [
            `query_no.ilike.*${term}*`,
            `ticket_no.ilike.*${term}*`,
            `reference_no.ilike.*${term}*`,
            `voucher_ref.ilike.*${term}*`,
            `subject.ilike.*${term}*`,
          ].join(','),
        );
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ tickets: (data ?? []).map((row) => ticketForCaller(row, isAdmin)) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// One query, in full — the View popup (§5)
// ---------------------------------------------------------------------------

router.get('/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (!canSee(req, ticket)) {
      res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
      return;
    }

    const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');

    const [{ data: messages, error: msgErr }, { data: amendments, error: amdErr }, ticketPhotos] =
      await Promise.all([
        supabaseAdmin
          .from('finance_ticket_messages')
          .select('*')
          .eq('ticket_id', ticket.id)
          .order('created_at', { ascending: true }),
        supabaseAdmin
          .from('finance_amendments')
          .select('*')
          .eq('ticket_id', ticket.id)
          .order('created_at', { ascending: false }),
        listAttachments('finance_ticket', ticket.id),
      ]);
    if (msgErr) throw msgErr;
    if (amdErr) throw amdErr;

    // One query for every message's photos rather than one per message.
    const photosByMessage = await listAttachmentsFor(
      'finance_ticket_message',
      (messages ?? []).map((m) => m.id as string),
    );

    res.json({
      ticket: {
        ...ticketForCaller(ticket, isAdmin),
        attachments: ticketPhotos,
        messages: (messages ?? []).map((m) => ({
          ...rowToApi(m),
          attachments: photosByMessage.get(m.id as string) ?? [],
        })),
        // The correction history is what an admin acted on and what an auditor
        // checks. A raiser sees it too: §7 gives them the Admin response, and a
        // response of "corrected to Rs.45,000" is not readable without it.
        amendments: rowToApi(amendments ?? []),
        // The record as it stands NOW, beside the snapshot of how it stood when
        // the query was raised. Admin-only: it is the working copy the Amend
        // dialog reads its current values from, and a raiser has no use for it.
        liveRecord: isAdmin
          ? await liveReference(
              ticket.reference_type as FinanceTicketReferenceType | null,
              ticket.reference_id as string | null,
            )
          : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Raise (§2, §3) — `create` covers Accountant, Finance Manager and Finance
// Admin, and excludes the Read Only Auditor, without this route naming roles.
// ---------------------------------------------------------------------------

router.post('/', requireFinance('create'), validate(CreateFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { queryType, priority, referenceNo, voucherRef, subject, description, attachmentIds } = req.body;

    // A reference is optional, but a reference that is GIVEN must resolve — a
    // typo'd voucher number silently accepted is a query the admin cannot action.
    let reference: FinanceTicketReferenceLookup | null = null;
    if (referenceNo) {
      try {
        reference = await resolveReference(referenceNo);
      } catch (err) {
        if (err instanceof LookupError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const { data, error } = await supabaseAdmin
      .from('finance_tickets')
      .insert({
        query_type: queryType,
        priority,
        reference_type: reference?.referenceType ?? null,
        reference_id: reference?.referenceId ?? null,
        reference_no: reference?.referenceNo ?? null,
        reference_snapshot: reference?.snapshot ?? null,
        voucher_ref: voucherRef || null,
        subject,
        message: description,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    if (attachmentIds?.length) {
      await bindAttachments({
        entity: 'finance_ticket',
        entityId: data.id,
        attachmentIds,
        actor: { uid: req.user!.uid },
      });
    }

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.query_no,
      action: 'created',
      newValues: { queryType, priority, referenceNo: reference?.referenceNo ?? null, subject },
    });

    // §16. Straight to ADMIN — never to another Finance user, which is the whole
    // point of §3. Best-effort: a notification that fails must not lose the query.
    try {
      await notify({
        type: 'finance_query',
        title: `New Finance Help Desk Query`,
        message:
          `Query ID: ${data.query_no}\n` +
          `Subject: ${subject}\n` +
          `Priority: ${String(priority).toUpperCase()}\n` +
          `Submitted By: ${req.user!.email}`,
        targetRole: 'super_admin',
        relatedId: data.id,
      });
    } catch { /* notification failure must not fail query creation */ }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Conversation (§17) — BOTH sides, which is why it is not admin-gated.
// ---------------------------------------------------------------------------

router.post(
  '/:id/messages',
  // NOT requireFinance('create') — that gate grants a super admin nothing but
  // `view` unless `allowSuperAdminWrite` is on, and it ships off, so an Admin
  // could read a query and not answer it. See the middleware's own header.
  requireFinanceHelpDeskParticipant(),
  validate(FinanceTicketMessageSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (!canSee(req, ticket)) {
        res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
        return;
      }
      if (ticket['deleted_at']) {
        res.status(409).json({ error: `Query ${ticket['query_no']} has been deleted.` });
        return;
      }
      if (ticket['status'] === 'closed') {
        res.status(409).json({
          error: `Query ${ticket['query_no']} is closed. Raise a new query for anything further.`,
        });
        return;
      }

      const side = sideOf(req.user!.role);

      const { data, error } = await supabaseAdmin
        .from('finance_ticket_messages')
        .insert({
          ticket_id: ticket.id,
          author_id: req.user!.uid,
          author_name: req.user!.email,
          author_role: req.user!.role,
          author_side: side,
          body: req.body.body,
        })
        .select('*')
        .single();
      if (error) throw error;

      if (req.body.attachmentIds?.length) {
        await bindAttachments({
          entity: 'finance_ticket_message',
          entityId: data.id,
          attachmentIds: req.body.attachmentIds,
          actor: { uid: req.user!.uid },
        });
      }

      // §7's "Mark information as received": the raiser answering a
      // WAITING_FOR_FINANCE query is the act itself, not a separate button to
      // remember to press. The status goes back to the admin's court.
      if (side === 'finance' && ticket['status'] === 'waiting_for_finance') {
        await supabaseAdmin
          .from('finance_tickets')
          .update({ status: 'under_review', information_received_at: new Date().toISOString() })
          .eq('id', ticket.id);
      }

      try {
        if (side === 'finance') {
          await notify({
            type: 'finance_query_message',
            title: `Reply on ${ticket['query_no']}`,
            message: `${req.user!.email}: ${String(req.body.body).slice(0, 140)}`,
            targetRole: 'super_admin',
            relatedId: ticket.id as string,
          });
        } else if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_message',
            title: `Admin replied on ${ticket['query_no']}`,
            message: String(req.body.body).slice(0, 140),
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket.id as string,
          });
        }
      } catch { /* best-effort */ }

      res.status(201).json({ message: rowToApi(data) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Administer — ADMIN ONLY, from here down (§6, §14, §21)
// ---------------------------------------------------------------------------

router.patch('/:id', requireFinanceHelpDeskAdmin(), validate(EditFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    // A deleted query is a record, not a working row. Editing one would produce
    // an audit entry describing a change to something the desk considers gone.
    if (before['deleted_at']) {
      res.status(409).json({ error: `Query ${before['query_no']} has been deleted.` });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (req.body.subject !== undefined) patch['subject'] = req.body.subject;
    if (req.body.message !== undefined) patch['message'] = req.body.message;
    if (req.body.queryType !== undefined) patch['query_type'] = req.body.queryType;
    if (req.body.priority !== undefined) patch['priority'] = req.body.priority;
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;
    if (req.body.internalNote !== undefined) patch['internal_note'] = req.body.internalNote;

    // §8: a change the RAISER will see needs a stated reason, and the reason is
    // what the audit row is worth reading for. An edit that only touches the
    // admin's own internal note changes nothing the raiser sees, so it does not.
    const touchesRaiserVisible = ['subject', 'message', 'query_type', 'priority', 'resolution_note']
      .some((k) => k in patch);
    const reason = String(req.body.reason ?? '').trim();
    if (touchesRaiserVisible && !reason) {
      res.status(400).json({
        error:
          `Editing ${before['query_no']} needs a reason. It is kept with the previous values in ` +
          'the audit history, and it is how the next reader knows why the query changed.',
      });
      return;
    }

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

    // §19: the PREVIOUS value of every field this PATCH touched, and only those.
    // Logging the whole row would bury the change; logging a fixed list would
    // record "subject: unchanged → unchanged" on a priority-only edit.
    const columnOf: Record<string, string> = {
      subject: 'subject',
      message: 'message',
      query_type: 'query_type',
      priority: 'priority',
      resolution_note: 'resolution_note',
      internal_note: 'internal_note',
    };
    const previousValues = Object.fromEntries(
      Object.keys(patch).map((k) => [k, before[columnOf[k] as string] ?? null]),
    );

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.query_no,
      action: 'updated',
      previousValues,
      newValues: { ...patch, ...(reason ? { reason } : {}) },
    });

    // The raiser is told their query was changed under them. Silently editing
    // someone's report and leaving them to notice is exactly the "data loss"
    // §19 is about, even when every previous value is safe in the trail.
    if (touchesRaiserVisible && data.raised_by && data.raised_by !== req.user!.uid) {
      try {
        await notify({
          type: 'finance_query_updated',
          title: `Query ${data.query_no} — updated by Admin`,
          message: reason,
          targetUserId: data.raised_by as string,
          relatedId: data.id,
        });
      } catch { /* best-effort */ }
    }

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

/** §14's Assign / take. Null unassigns, which is what the "Unassigned" card counts. */
router.patch(
  '/:id/assign',
  requireFinanceHelpDeskAdmin(),
  validate(AssignFinanceTicketSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const assignedTo: string | null = req.body.assignedTo;

      let assignedName: string | null = null;
      if (assignedTo) {
        const { data: user, error: userErr } = await supabaseAdmin
          .from('users')
          .select('id, name, email, role')
          .eq('id', assignedTo)
          .maybeSingle();
        if (userErr) throw userErr;
        if (!user) {
          res.status(404).json({ error: 'That user does not exist.' });
          return;
        }
        // A query can only be assigned to somebody who is allowed to act on it —
        // assigning it to a Finance user would produce a queue entry nobody can
        // clear, and §3 says the query does not go to a Finance user at all.
        if (!financeHelpDeskCan(user.role as string, 'respond')) {
          res.status(400).json({
            error: `${user.name ?? user.email} is not an Admin and cannot action a Help Desk query.`,
          });
          return;
        }
        assignedName = (user.name as string) || (user.email as string);
      }

      const { data, error } = await supabaseAdmin
        .from('finance_tickets')
        .update({
          assigned_to: assignedTo,
          assigned_to_name: assignedName,
          assigned_at: assignedTo ? new Date().toISOString() : null,
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
        entityRef: data.query_no,
        action: 'updated',
        newValues: { assignedTo, assignedToName: assignedName },
      });

      res.json({ ticket: rowToApi(data) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §8's workflow, as one route.
 *
 *     OPEN → UNDER REVIEW → (investigate, correct if required) → RESOLVED
 *
 * The move is checked against FINANCE_TICKET_TRANSITIONS rather than accepted as
 * sent: a query that jumps from `open` straight to `closed` skips the record
 * that anybody looked at it, and the workflow's value is that the queue can be
 * read at a glance.
 */
router.patch(
  '/:id/status',
  requireFinanceHelpDeskAdmin(),
  validate(FinanceTicketStatusSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { status, adminResponse, resolutionNote, resolutionType } = req.body as {
        status: FinanceTicketStatus;
        adminResponse?: string;
        resolutionNote?: string;
        resolutionType?: FinanceResolutionType;
      };

      const before = await getTicket(req.params.id as string);
      if (!before) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (before['deleted_at']) {
        res.status(409).json({ error: `Query ${before['query_no']} has been deleted.` });
        return;
      }

      const from = before['status'] as FinanceTicketStatus;
      if (from === status) {
        res.status(409).json({ error: `Query ${before['query_no']} is already ${FINANCE_TICKET_STATUS_LABELS[status]}.` });
        return;
      }
      if (!FINANCE_TICKET_TRANSITIONS[from].includes(status)) {
        const allowed = FINANCE_TICKET_TRANSITIONS[from].map((s) => FINANCE_TICKET_STATUS_LABELS[s]);
        res.status(409).json({
          error: allowed.length
            ? `A ${FINANCE_TICKET_STATUS_LABELS[from]} query can only move to: ${allowed.join(', ')}.`
            : `Query ${before['query_no']} is ${FINANCE_TICKET_STATUS_LABELS[from]} and cannot change again. ` +
              'Raise a new query for anything further.',
        });
        return;
      }

      // §8: ending a query says why it ended. Enforced here rather than in the
      // schema because the requirement depends on the TARGET status, which the
      // schema can see, and on the note already on the row, which it cannot.
      const note = resolutionNote ?? (before['resolution_note'] as string | null) ?? '';
      if (isFinanceTicketTerminal(status) && status !== 'closed' && !note.trim() && !adminResponse?.trim()) {
        res.status(400).json({
          error:
            `Resolving or rejecting ${before['query_no']} needs a note saying what was done, ` +
            'or why this is not an error. It is what the raiser sees.',
        });
        return;
      }

      // §11's Resolution Type. Required when a query is RESOLVED or REJECTED,
      // optional on `closed` — closing is filing a query that was already
      // answered, and demanding the type again would ask the admin to restate a
      // decision the resolution already recorded.
      if (isFinanceTicketTerminal(status) && status !== 'closed' && !resolutionType
          && !before['resolution_type']) {
        res.status(400).json({
          error:
            `Say what kind of resolution this is — Fixed, Information Provided, Rejected, ` +
            `Duplicate or Other. It is what ${before['query_no']} is counted as in reports.`,
        });
        return;
      }

      const patch: Record<string, unknown> = { status };
      if (resolutionType !== undefined) patch['resolution_type'] = resolutionType;
      if (adminResponse !== undefined) {
        patch['admin_response'] = adminResponse;
        patch['responded_by'] = req.user!.uid;
        patch['responded_by_name'] = req.user!.email;
        patch['responded_at'] = new Date().toISOString();
      }
      if (resolutionNote !== undefined) patch['resolution_note'] = resolutionNote;
      if (isFinanceTicketTerminal(status)) {
        patch['resolved_by'] = req.user!.uid;
        patch['resolved_by_name'] = req.user!.email;
        patch['resolved_at'] = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from('finance_tickets')
        .update(patch)
        .eq('id', req.params.id)
        // Optimistic guard: two admins resolving the same query at once must not
        // both succeed and overwrite each other's closing record.
        .eq('status', from)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: 'Someone else moved this query while you were working on it.' });
        return;
      }

      await logFinanceAudit(req, {
        entity: 'finance_ticket',
        entityId: data.id,
        entityRef: data.query_no,
        action: status === 'rejected' ? 'rejected' : status === 'resolved' ? 'resolved' : 'updated',
        previousValues: { status: from },
        newValues: { status, adminResponse, resolutionNote, resolutionType },
      });

      try {
        if (data.raised_by) {
          await notify({
            type: isFinanceTicketTerminal(status) ? 'finance_query_resolved' : 'finance_query_updated',
            title: `Query ${data.query_no} — ${FINANCE_TICKET_STATUS_LABELS[status]}`,
            message: adminResponse || resolutionNote || `Your query is now ${FINANCE_TICKET_STATUS_LABELS[status]}.`,
            targetUserId: data.raised_by,
            relatedId: data.id,
          });
        }
      } catch { /* best-effort */ }

      res.json({ ticket: rowToApi(data) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §12 — a resolution is disputed, and the query goes live again.
 *
 *     RESOLVED  →  REOPENED  →  UNDER_REVIEW
 *
 * ONE ROUTE, TWO OUTCOMES, decided from the JWT and not from the payload:
 *
 *   · An Admin REOPENS the query. The resolution being overturned is archived
 *     onto `resolution_history` in the same UPDATE that clears it, so there is
 *     no instant at which the query has neither the old answer nor a record of
 *     it, and no way for a failure between two writes to lose one.
 *   · The Finance RAISER records a REQUEST to reopen. §12 says either side may
 *     ask "depending on permissions", and a Finance user's permission is to ask:
 *     the request is posted as a message on the thread — where it is
 *     append-only and the admin's reply sits beside it — and the admin is
 *     notified. The status does not move, which is the whole difference.
 *
 * Anyone else who reaches here is a Finance user looking at somebody else's
 * query, and `canSee` has already turned them away.
 *
 * WHY NOT PATCH /:id/status WITH status='reopened'. Because reopening is the one
 * transition that must UNDO a previous write rather than follow it, and the undo
 * has a precondition — archive first — that no other transition has. Expressed
 * as a row in FINANCE_TICKET_TRANSITIONS it would be a branch every other
 * transition skips, and the archive step would be one `if` away from being
 * forgotten by the next person who adds a status.
 */
router.post(
  '/:id/reopen',
  requireFinanceHelpDeskParticipant(),
  validate(ReopenFinanceTicketSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const reason = String(req.body.reason).trim();

      const before = await getTicket(req.params.id as string);
      if (!before) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (!canSee(req, before)) {
        res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
        return;
      }
      if (before['deleted_at']) {
        res.status(409).json({ error: `Query ${before['query_no']} has been deleted.` });
        return;
      }

      const from = before['status'] as FinanceTicketStatus;
      if (!FINANCE_TICKET_REOPENABLE.includes(from)) {
        res.status(409).json({
          error:
            `Query ${before['query_no']} is ${FINANCE_TICKET_STATUS_LABELS[from]} and is already ` +
            'open. Only a resolved, rejected or closed query can be reopened.',
        });
        return;
      }

      const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');

      // ---- The raiser's side: a request, not a reopening ----
      if (!isAdmin) {
        const { data: message, error: msgErr } = await supabaseAdmin
          .from('finance_ticket_messages')
          .insert({
            ticket_id: before['id'],
            author_id: req.user!.uid,
            author_name: req.user!.email,
            author_role: req.user!.role,
            author_side: 'finance',
            body: `Requested to reopen this query.\n\nReason: ${reason}`,
          })
          .select('*')
          .single();
        if (msgErr) throw msgErr;

        await logFinanceAudit(req, {
          entity: 'finance_ticket',
          entityId: before['id'] as string,
          entityRef: before['query_no'] as string,
          action: 'reopen_requested',
          previousValues: { status: from },
          newValues: { reason },
        });

        try {
          await notify({
            type: 'finance_query',
            title: `Reopen requested — ${before['query_no']}`,
            message: `${req.user!.email} disputes the resolution.\n\nReason: ${reason}`,
            targetRole: 'super_admin',
            relatedId: before['id'] as string,
          });
        } catch { /* best-effort */ }

        // 202, not 200: the request was accepted and nothing has changed yet.
        // A 200 with an unchanged ticket would read to the client as "reopened"
        // and to the raiser as a status that refused to update.
        res.status(202).json({
          requested: true,
          ticket: ticketForCaller(before, false),
          message: rowToApi(message),
        });
        return;
      }

      // ---- The admin's side: the reopening itself ----
      //
      // The answer being overturned is preserved verbatim, including its
      // resolution type and who gave it, and stamped with who overturned it and
      // why. Reopening three times leaves three of these, oldest first.
      const archived: FinanceTicketResolution = {
        status: from,
        resolutionType: (before['resolution_type'] as FinanceResolutionType | null) ?? null,
        resolutionNote: (before['resolution_note'] as string | null) ?? null,
        adminResponse: (before['admin_response'] as string | null) ?? null,
        resolvedBy: (before['resolved_by'] as string | null) ?? null,
        resolvedByName: (before['resolved_by_name'] as string | null) ?? null,
        resolvedAt: (before['resolved_at'] as string | null) ?? null,
        reopenedAt: new Date().toISOString(),
        reopenedByName: req.user!.email,
        reopenReason: reason,
      };
      const history = [
        ...((before['resolution_history'] as FinanceTicketResolution[] | null) ?? []),
        archived,
      ];

      const { data, error } = await supabaseAdmin
        .from('finance_tickets')
        .update({
          status: 'reopened',
          resolution_history: history,
          reopen_count: history.length,
          reopened_at: archived.reopenedAt,
          reopened_by: req.user!.uid,
          reopened_by_name: req.user!.email,
          reopen_reason: reason,
          // Cleared because `finance_tickets_resolution_check` forbids a live
          // query from carrying a resolver — and because the query genuinely no
          // longer has a current answer. Both are safe to clear only because
          // `history` above already holds them, in this same statement.
          resolved_by: null,
          resolved_by_name: null,
          resolved_at: null,
          resolution_note: null,
          resolution_type: null,
        })
        .eq('id', req.params.id)
        // Same optimistic guard as the status route: two admins reopening at
        // once must not both archive, or the history grows a duplicate entry
        // for a resolution that was only overturned once.
        .eq('status', from)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: 'Someone else moved this query while you were working on it.' });
        return;
      }

      await logFinanceAudit(req, {
        entity: 'finance_ticket',
        entityId: data.id,
        entityRef: data.query_no,
        action: 'reopened',
        previousValues: {
          status: from,
          resolutionType: archived.resolutionType,
          resolutionNote: archived.resolutionNote,
          resolvedByName: archived.resolvedByName,
          resolvedAt: archived.resolvedAt,
        },
        newValues: { status: 'reopened', reason, reopenCount: history.length },
      });

      try {
        if (data.raised_by && data.raised_by !== req.user!.uid) {
          await notify({
            type: 'finance_query_updated',
            title: `Query ${data.query_no} — Reopened`,
            message: `An Admin reopened your query.\n\nReason: ${reason}`,
            targetUserId: data.raised_by as string,
            relatedId: data.id,
          });
        }
      } catch { /* best-effort */ }

      res.json({ ticket: rowToApi(data) });
    } catch (err) {
      next(err);
    }
  },
);
// ---------------------------------------------------------------------------
// Changing the BOOKS (§9, §11, §12) — the reason this module has a Help Desk
// ---------------------------------------------------------------------------

/**
 * Write the amendment record for a change that has already happened.
 *
 * Called AFTER the database has done the work, never before, and from the
 * database's own report of what it did rather than from the request that asked
 * for it. The difference matters: `amend_finance_record` recomputes derived
 * columns and re-posts vouchers, so "what the admin typed" and "what changed"
 * are not the same thing, and the second is the one an auditor needs.
 *
 * `finance_amendments` is append-only and its `ticket_id` is ON DELETE RESTRICT,
 * so this row is the thing that makes §21 true — every correction to the books
 * is permanently tied to the query that justified it.
 */
async function recordAmendment(
  req: AuthRequest,
  ticket: Record<string, unknown>,
  action: FinanceAmendmentAction,
  applied: {
    referenceType: string;
    referenceNo: string;
    field: string;
    originalValue: string | null;
    newValue: string | null;
    difference: number | null;
  },
  reason: string,
): Promise<void> {
  const { ipAddress } = requestFingerprint(req);
  const { error } = await supabaseAdmin.from('finance_amendments').insert({
    ticket_id: ticket['id'],
    query_no: ticket['query_no'],
    reference_type: applied.referenceType,
    reference_id: ticket['reference_id'],
    reference_no: applied.referenceNo,
    action,
    field: applied.field,
    original_value: applied.originalValue,
    new_value: applied.newValue,
    difference: applied.difference,
    reason,
    admin_id: req.user!.uid,
    admin_name: req.user!.email,
    ip_address: ipAddress,
  });
  // Unlike the audit trail, this one THROWS. The trail is forensic context and
  // must never roll back a change that already moved money; this row is the
  // justification the brief requires the change to carry, and a correction that
  // silently loses it is exactly what §21 exists to prevent. It is written
  // immediately after the change, so the window in which one can exist without
  // the other is a single statement wide.
  if (error) throw error;
}

/**
 * §14's Edit / Amend / Overwrite, as one route.
 *
 * The three verbs differ in what the UI demands before calling — an overwrite of
 * an approved record needs §11's confirmation, which `AmendFinanceRecordSchema`
 * requires to reach the server rather than being a dialog the API cannot see —
 * and in what gets recorded. They do NOT differ in what happens to the row,
 * which is why they share `amend_finance_record()`: three code paths would drift
 * into three subtly different definitions of "corrected".
 *
 * What a Finance user cannot do here is the whole point, and it is enforced by
 * `requireFinanceHelpDeskAdmin()` on the line below, not by the button being
 * hidden.
 */
router.post(
  '/:id/amend',
  requireFinanceHelpDeskAdmin(),
  validate(AmendFinanceRecordSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { action, field, newValue, reason } = req.body as {
        action: FinanceAmendmentAction;
        field: string;
        newValue: string;
        reason: string;
      };

      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      const referenceType = ticket['reference_type'] as FinanceTicketReferenceType | null;
      if (!referenceType || !ticket['reference_id']) {
        res.status(409).json({
          error:
            `Query ${ticket['query_no']} names no finance record, so there is nothing to change. ` +
            'Answer it with a response, or ask the raiser for the reference.',
        });
        return;
      }

      // The field whitelist, checked here as well as in the function. The
      // function is the boundary; this is the message — it names the fields that
      // WOULD work, which a generic 400 out of Postgres cannot.
      const allowed = FINANCE_AMENDABLE_FIELDS[referenceType] ?? [];
      const spec = allowed.find((f) => f.key === field);
      if (!spec) {
        res.status(400).json({
          error: allowed.length
            ? `"${field}" cannot be changed on this record. Try: ${allowed.map((f) => f.key).join(', ')}.`
            : 'Nothing on this record can be changed directly.',
        });
        return;
      }

      const { data: applied, error } = await supabaseAdmin.rpc('amend_finance_record', {
        p_reference_type: referenceType,
        p_reference_id: ticket['reference_id'],
        p_field: field,
        p_new_value: newValue,
        p_reason: reason,
        p_actor_id: req.user!.uid,
        p_actor_name: req.user!.email,
        // The reversal and its correction are posted to TODAY, not to the
        // original entry's date: post_finance_ledger_entry refuses a closed day,
        // and the day a wrong voucher was posted is usually closed by the time
        // anybody notices it was wrong.
        p_entry_date: businessDateStr(),
      });
      if (error) throw asAmendError(error);

      const result = applied as {
        referenceType: string;
        referenceNo: string;
        field: string;
        originalValue: string | null;
        newValue: string | null;
        difference: number | null;
        ledger?: { ledgerAmended?: boolean; reversalVoucherNo?: string; correctedVoucherNo?: string };
      };

      await recordAmendment(req, ticket, action, result, reason);

      await logFinanceAudit(req, {
        // Every FinanceTicketReferenceType is also a FinanceAuditEntity, so the
        // trail names the record's own kind rather than flattening it.
        entity: referenceType as FinanceAuditEntity,
        entityId: ticket['reference_id'] as string,
        entityRef: result.referenceNo,
        action: action === 'overwrite' ? 'adjusted' : 'updated',
        previousValues: { [result.field]: result.originalValue },
        newValues: {
          [result.field]: result.newValue,
          queryNo: ticket['query_no'],
          reason,
          ...(result.ledger?.ledgerAmended
            ? {
                reversalVoucherNo: result.ledger.reversalVoucherNo,
                correctedVoucherNo: result.ledger.correctedVoucherNo,
              }
            : {}),
        },
      });

      try {
        if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_amended',
            title: `${result.referenceNo} corrected`,
            message:
              `${spec.label}: ${result.originalValue ?? '—'} → ${result.newValue ?? '—'}` +
              `\nQuery ID: ${ticket['query_no']}`,
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket['id'] as string,
          });
        }
      } catch { /* best-effort */ }

      res.json({
        applied: result,
        record: await liveReference(referenceType, ticket['reference_id'] as string),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §10's delete — soft, always.
 *
 * The record is stamped and stays readable to an Admin; the query stays too, and
 * carries the same stamp. Migration 60's real delete, which destroyed both the
 * query text and the voucher and left only the fact in the trail, is gone: a
 * query is now the justification for the corrections made under it (§21), and a
 * justification the actor can destroy is not one.
 *
 * The order is deliberate:
 *
 *   1. stamp the RECORD   — the step that recomputes the ledger and can fail
 *   2. write the amendment — only once the record actually went
 *   3. stamp the QUERY     — last, so a failure at (1) leaves both in place and
 *                            the operation is safe to retry
 */
router.delete(
  '/:id/record',
  requireFinanceHelpDeskAdmin(),
  validate(DeleteFinanceRecordSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { reason } = req.body as { reason: string };

      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      const referenceType = ticket['reference_type'] as FinanceTicketReferenceType | null;
      if (!referenceType || !ticket['reference_id']) {
        res.status(409).json({ error: `Query ${ticket['query_no']} names no finance record to delete.` });
        return;
      }

      const { data: removed, error } = await supabaseAdmin.rpc('soft_delete_finance_record', {
        p_reference_type: referenceType,
        p_reference_id: ticket['reference_id'],
        p_reason: reason,
        p_actor_id: req.user!.uid,
        p_actor_name: req.user!.email,
        p_query_id: ticket['id'],
        p_query_no: ticket['query_no'],
      });
      if (error) throw error;

      const source = (removed ?? {}) as {
        deleted?: boolean;
        referenceNo?: string;
        balancesRewritten?: number;
        closingBalance?: number | null;
        reason?: string;
      };
      if (!source.deleted) {
        res.status(409).json({
          error: `${ticket['reference_no'] ?? 'That record'} could not be deleted — ${source.reason ?? 'it is no longer there'}.`,
        });
        return;
      }

      await recordAmendment(
        req,
        ticket,
        'delete',
        {
          referenceType,
          referenceNo: source.referenceNo ?? String(ticket['reference_no'] ?? ''),
          field: 'record',
          originalValue: 'present',
          newValue: 'deleted',
          difference: null,
        },
        reason,
      );

      await logFinanceAudit(req, {
        entity: referenceType as FinanceAuditEntity,
        entityId: ticket['reference_id'] as string,
        entityRef: source.referenceNo ?? String(ticket['reference_no'] ?? ''),
        action: 'deleted',
        newValues: {
          softDeleted: true,
          deletedVia: 'finance_help_desk',
          queryNo: ticket['query_no'],
          reason,
          // Deleting a voucher rewrites the running balance on every later row.
          // How many rows moved, and where the book landed, is the part of a
          // deletion an auditor most needs and cannot reconstruct afterwards.
          ...(source.balancesRewritten
            ? { balancesRewritten: source.balancesRewritten, closingBalance: source.closingBalance ?? null }
            : {}),
        },
      });

      try {
        if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_amended',
            title: `${source.referenceNo} deleted`,
            message: `${reason}\nQuery ID: ${ticket['query_no']}`,
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket['id'] as string,
          });
        }
      } catch { /* best-effort */ }

      res.json({
        success: true,
        referenceNo: source.referenceNo,
        balancesRewritten: source.balancesRewritten ?? 0,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Delete the QUERY (not the record it names). Soft, and admin-only.
 *
 * Kept separate from `/​:id/record` because they are genuinely different acts:
 * one removes a wrong voucher from the books, the other removes a query that
 * should not have been raised. Migration 60 did both at once from a single
 * button, which is how deleting a duplicate help-desk entry could take a posted
 * voucher with it.
 */
router.delete('/:id', requireFinanceHelpDeskAdmin(), validate(DeleteFinanceRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    const { reason } = req.body as { reason: string };

    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (ticket['deleted_at']) {
      res.status(409).json({ error: `Query ${ticket['query_no']} is already deleted.` });
      return;
    }

    const { error } = await supabaseAdmin
      .from('finance_tickets')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: req.user!.uid,
        deleted_by_name: req.user!.email,
        delete_reason: reason,
      })
      .eq('id', ticket.id);
    if (error) throw error;

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: ticket.id,
      entityRef: ticket['query_no'] as string,
      action: 'deleted',
      // The query's TEXT is deliberately not copied into the trail — unlike
      // migration 60, it does not need to be. The row is still there.
      newValues: { softDeleted: true, reason },
    });

    res.json({ success: true, queryNo: ticket['query_no'] });
  } catch (err) {
    next(err);
  }
});

/**
 * Turn a `raise exception` from amend_finance_record into an HTTP status.
 *
 * Every message that function raises is written for a person — "field X is not
 * amendable on a salary payment (…)", "the finance day Y is closed" — and
 * passing them through as a 500 would replace a usable sentence with "Internal
 * server error". They are all caller mistakes, so 409 is the honest code: the
 * request was well-formed and the state refused it.
 */
function asAmendError(error: { message?: string; code?: string }): Error {
  const message = error.message ?? 'The correction could not be applied.';
  // PostgREST surfaces a plpgsql RAISE as P0001. Anything else — a constraint
  // violation, a connection failure — is a real fault and keeps its 500.
  const status = error.code === 'P0001' ? 409 : 500;
  return Object.assign(new Error(message), { status });
}
