import type { Request } from 'express';
import { supabaseAdmin } from '../config/supabase';
import type { AuthRequest } from '../middleware/auth';
import type { FinanceAuditAction, FinanceAuditEntity, FinanceAuditLog } from '../shared';
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
