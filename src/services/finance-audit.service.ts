import type { Request } from 'express';
import { supabaseAdmin } from '../config/supabase';
import type { AuthRequest } from '../middleware/auth';
import {
  FINANCE_QUERY_PRIORITY_LABELS,
  FINANCE_QUERY_TYPE_LABELS,
  FINANCE_RESOLUTION_TYPE_LABELS,
  FINANCE_TICKET_STATUS_LABELS,
  type FinanceAuditAction,
  type FinanceAuditEntity,
  type FinanceAuditLog,
  type FinanceQueryPriority,
  type FinanceQueryType,
  type FinanceResolutionType,
  type FinanceTicketAuditChange,
  type FinanceTicketAuditEntry,
  type FinanceTicketStatus,
} from '../shared';
import { rowToApi } from '../utils/case';

/**
 * The Finance Ledger's own audit trail.
 *
 * Deliberately NOT `audit_logs` (services/audit.service.ts): that table's
 * `action` is a closed enum of user-management events and its columns describe a
 * TARGET USER. A finance trail describes a target DOCUMENT and has to answer the
 * questions an auditor actually asks — who changed what, from what to what, from
 * where, on what device.
 *
 * Like the other audit writer, this NEVER throws: a trail write that fails must
 * not roll back an approval that has already moved money. It logs instead.
 */

export interface FinanceAuditInput {
  entity: FinanceAuditEntity;
  entityId?: string | null;
  entityRef?: string | null;
  action: FinanceAuditAction;
  previousValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

/**
 * Best-effort client fingerprint.
 *
 * `X-Forwarded-For` is a list when the request has crossed more than one proxy;
 * the FIRST entry is the original client. Express's own `req.ip` respects
 * `trust proxy`, which this app does not set, so it would report the load
 * balancer — hence reading the header directly and falling back to the socket.
 *
 * Neither value is trustworthy in the security sense (a client can send any
 * X-Forwarded-For it likes). That is fine and worth stating plainly: this is
 * forensic context for a human reading the trail, not an authorisation input.
 */
export function requestFingerprint(req: Request): { ipAddress: string | null; deviceInfo: string | null } {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  const ipAddress = (first ?? req.socket.remoteAddress ?? '').trim() || null;

  const agent = req.headers['user-agent'];
  const deviceInfo = (Array.isArray(agent) ? agent[0] : agent)?.slice(0, 400) ?? null;

  return { ipAddress, deviceInfo };
}

export async function logFinanceAudit(req: AuthRequest, input: FinanceAuditInput): Promise<void> {
  try {
    const { ipAddress, deviceInfo } = requestFingerprint(req);
    const { error } = await supabaseAdmin.from('finance_audit_logs').insert({
      entity: input.entity,
      entity_id: input.entityId ?? null,
      entity_ref: input.entityRef ?? null,
      action: input.action,
      actor_id: req.user?.uid ?? null,
      actor_name: req.user?.email ?? 'system',
      actor_role: req.user?.role ?? null,
      previous_values: input.previousValues ?? null,
      new_values: input.newValues ?? null,
      ip_address: ipAddress,
      device_info: deviceInfo,
    });
    if (error) console.error('[finance-audit] failed to write trail', error.message);
  } catch (err) {
    console.error('[finance-audit] failed to write trail', err);
  }
}

export interface FinanceAuditQuery {
  entity?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listFinanceAudit(
  q: FinanceAuditQuery,
): Promise<{ logs: FinanceAuditLog[]; total: number }> {
  const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  let query = supabaseAdmin
    .from('finance_audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.entity) query = query.eq('entity', q.entity);
  if (q.entityId) query = query.eq('entity_id', q.entityId);
  if (q.action) query = query.eq('action', q.action);
  if (q.actorId) query = query.eq('actor_id', q.actorId);
  // Dates arrive as business dates; the trail is stamped with a real instant, so
  // the `to` bound covers the whole of that calendar day.
  if (q.from) query = query.gte('created_at', `${q.from}T00:00:00.000Z`);
  if (q.to) query = query.lte('created_at', `${q.to}T23:59:59.999Z`);

  const { data, error, count } = await query;
  if (error) throw error;

  return { logs: rowToApi<FinanceAuditLog[]>(data ?? []), total: count ?? 0 };
}

/**
 * Reduce a row to the fields worth recording as before/after.
 *
 * Storing the whole row would bloat the trail with timestamps and denormalised
 * names that change for uninteresting reasons, and would bury the one field that
 * actually moved.
 */
export function auditSnapshot<T extends Record<string, unknown>>(row: T, fields: (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (row[f] !== undefined) out[String(f)] = row[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// §14 — the Audit History shown inside one query's detail popup
// ---------------------------------------------------------------------------

/**
 * Two trails, one timeline.
 *
 * A Help Desk query's history lives in two places, and neither on its own
 * answers §14's question ("display every change chronologically"):
 *
 *   · `finance_audit_logs` (entity `finance_ticket`) — what happened to the
 *     QUERY: raised, opened, edited, resolved, reopened, deleted.
 *   · `finance_amendments` (by `ticket_id`) — what happened to the BOOKS under
 *     it: the amount that moved from 50,000 to 55,000 and why.
 *
 * The amendment rows are logged against the RECORD's entity, not the ticket's
 * (see the amend route), so a ticket-scoped query on the audit table alone
 * would show a query resolving with no sign of the correction that resolved it
 * — which is the one line anybody reading the history came for.
 *
 * Merged and ordered here rather than in the client because one of the two
 * needs redacting for a Finance caller, and a redaction the client performs is
 * not a redaction: the row still crosses the wire. Same reasoning as
 * `ticketForCaller`, applied to the trail instead of the row.
 */

/** Column and payload keys → the label the timeline prints. */
const AUDIT_FIELD_LABELS: Record<string, string> = {
  subject: 'Subject',
  message: 'Description',
  queryType: 'Category',
  priority: 'Priority',
  status: 'Status',
  referenceNo: 'Reference ID',
  adminResponse: 'Admin response',
  resolutionNote: 'Resolution',
  resolutionType: 'Resolution type',
  internalNote: 'Internal note',
  assignedToName: 'Assigned admin',
  resolvedByName: 'Resolved by',
  resolvedAt: 'Resolved at',
  reopenCount: 'Times reopened',
  deleteReason: 'Deletion reason',
};

/**
 * Keys that are NOT a field that moved.
 *
 * `reason` is §8's stated justification and is lifted onto the entry itself, so
 * printing it again as "reason: — → Finance correction" would say the same
 * thing twice. `softDeleted` and `assignedTo` are each already stated by the
 * entry's own summary — "Query Deleted", "Assigned to an Admin" — and would
 * otherwise print as a bare `true` and a bare uuid respectively; the assignment
 * keeps `assignedToName`, which is the half a reader can use.
 */
const AUDIT_META_KEYS = new Set(['reason', 'queryNo', 'ticketId', 'softDeleted', 'assignedTo']);

/**
 * A key the label map has never heard of — a field added to a route's audit
 * payload and not to the map above.
 *
 * Humanised rather than printed raw, so the worst case is "Reference Type"
 * instead of a perfect label, not `reference_type` leaking onto a screen a
 * Finance user reads. The map is still where a proper label belongs.
 */
function humaniseAuditKey(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The admin's working note (§6) — stripped for a Finance caller, in BOTH
 * directions, because the audit row carries the previous value as well as the
 * new one and hiding only one of them leaks the other.
 */
const AUDIT_ADMIN_ONLY_KEYS = new Set(['internalNote']);

/** Render a stored audit value as the timeline prints it. */
function auditValue(key: string, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return JSON.stringify(raw);

  const value = String(raw);
  // The four vocabularies the trail stores in their wire form. A history line
  // reading "waiting_for_finance" is the database's spelling leaking onto a
  // screen the raiser reads.
  if (key === 'status') {
    return FINANCE_TICKET_STATUS_LABELS[value as FinanceTicketStatus] ?? value;
  }
  if (key === 'queryType') {
    return FINANCE_QUERY_TYPE_LABELS[value as FinanceQueryType] ?? value;
  }
  if (key === 'priority') {
    return FINANCE_QUERY_PRIORITY_LABELS[value as FinanceQueryPriority] ?? value;
  }
  if (key === 'resolutionType') {
    return FINANCE_RESOLUTION_TYPE_LABELS[value as FinanceResolutionType] ?? value;
  }
  return value;
}

/**
 * "Query Created", "Admin Opened Query", "Query Resolved" — §14's own wording.
 *
 * The status the query moved TO decides the phrase for an `updated` row,
 * because that is what the reader is looking for: a timeline of six lines that
 * all say "Query Updated" answers nothing.
 */
function auditSummary(action: string, next: Record<string, unknown>): string {
  switch (action) {
    case 'created':
      return 'Query Created';
    case 'resolved':
      return 'Query Resolved';
    case 'rejected':
      return 'Query Rejected';
    case 'reopened':
      return 'Query Reopened';
    case 'reopen_requested':
      return 'Reopen Requested by Finance';
    case 'deleted':
      return 'Query Deleted';
    default:
      break;
  }

  const status = next['status'];
  if (typeof status === 'string') {
    switch (status) {
      case 'under_review':
        return 'Admin Opened Query';
      case 'waiting_for_finance':
        return 'Information Requested from Finance';
      case 'closed':
        return 'Query Closed';
      default:
        return `Status Changed to ${FINANCE_TICKET_STATUS_LABELS[status as FinanceTicketStatus] ?? status}`;
    }
  }
  // The assign route logs `assignedTo` with no status; null is an unassign.
  if ('assignedTo' in next) {
    return next['assignedTo'] ? 'Assigned to an Admin' : 'Unassigned';
  }
  if ('adminResponse' in next) return 'Admin Response Added';
  return 'Query Amended';
}

/** `edit` → "Amount Edited", `delete` → "Record Deleted". */
function amendmentSummary(action: string, field: string): string {
  const verb =
    action === 'amend' ? 'Amended'
    : action === 'overwrite' ? 'Overwritten'
    : action === 'delete' ? 'Deleted'
    : 'Edited';
  if (action === 'delete') return 'Record Deleted';
  // `field` is the API (camelCase) name of what changed — "amount",
  // "grossSalary" — so the humanised form reads as §14's own "Amount Amended".
  return `${AUDIT_FIELD_LABELS[field] ?? humaniseAuditKey(field)} ${verb}`;
}

/**
 * Build one query's Audit History, oldest first.
 *
 * `isAdmin` is the caller's, not the query's: a Finance raiser gets the same
 * timeline with the internal note removed from it. Never throws — a trail that
 * cannot be read must not take the query's detail page down with it, for the
 * same reason `logFinanceAudit` never throws on the way in.
 */
export async function financeTicketAuditTrail(
  ticketId: string,
  isAdmin: boolean,
): Promise<FinanceTicketAuditEntry[]> {
  try {
    const [{ data: logs, error: logErr }, { data: amendments, error: amdErr }] = await Promise.all([
      supabaseAdmin
        .from('finance_audit_logs')
        .select('id, action, actor_name, actor_role, previous_values, new_values, created_at')
        .eq('entity', 'finance_ticket')
        .eq('entity_id', ticketId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('finance_amendments')
        .select('id, action, field, original_value, new_value, reason, admin_name, reference_no, created_at')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true }),
    ]);
    if (logErr) throw logErr;
    if (amdErr) throw amdErr;

    const entries: FinanceTicketAuditEntry[] = [];

    for (const row of logs ?? []) {
      const previous = rowToApi<Record<string, unknown>>(row.previous_values ?? {});
      const next = rowToApi<Record<string, unknown>>(row.new_values ?? {});
      const action = String(row.action);

      const changes: FinanceTicketAuditChange[] = [];
      // Union of both sides: a field cleared by an edit appears only in
      // `previous`, and dropping it would show the clearing as no change at all.
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (AUDIT_META_KEYS.has(key)) continue;
        if (!isAdmin && AUDIT_ADMIN_ONLY_KEYS.has(key)) continue;
        const from = auditValue(key, previous[key]);
        const to = auditValue(key, next[key]);
        if (from === to) continue;
        changes.push({ field: AUDIT_FIELD_LABELS[key] ?? humaniseAuditKey(key), from, to });
      }

      const reason = typeof next['reason'] === 'string' && next['reason'].trim() ? next['reason'] : null;

      // An entry left with nothing to show is one whose only content was the
      // internal note, redacted above. Printing "Query Amended" with no fields
      // and no reason tells the raiser that something was hidden from them,
      // which is worse than not listing a note they were never party to.
      if (!changes.length && !reason && action === 'updated') continue;

      entries.push({
        id: String(row.id),
        source: 'query',
        at: String(row.created_at),
        action,
        summary: auditSummary(action, next),
        actorName: String(row.actor_name ?? 'system'),
        actorRole: (row.actor_role as string | null) ?? null,
        changes,
        reason,
      });
    }

    for (const row of amendments ?? []) {
      const field = String(row.field);
      entries.push({
        id: String(row.id),
        source: 'record',
        at: String(row.created_at),
        action: String(row.action),
        summary: amendmentSummary(String(row.action), field),
        actorName: String(row.admin_name ?? 'system'),
        actorRole: null,
        changes: [
          {
            field: `${row.reference_no} · ${AUDIT_FIELD_LABELS[field] ?? humaniseAuditKey(field)}`,
            from: (row.original_value as string | null) ?? null,
            to: (row.new_value as string | null) ?? null,
          },
        ],
        reason: (row.reason as string | null) ?? null,
      });
    }

    // Oldest first — §14 reads downwards, and the two sources interleave.
    return entries.sort((a, b) => a.at.localeCompare(b.at));
  } catch (err) {
    console.error('[finance-audit] failed to build ticket trail', err);
    return [];
  }
}
