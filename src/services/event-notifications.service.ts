import { supabaseAdmin } from '../config/supabase';
import {
  addDaysToDateStr,
  branchReminderOffsets,
  businessDateStr,
  DEMAND_DUE_REMINDER_OFFSETS,
  productionReminderOffsets,
  type EventDispatchResult,
  type EventNotificationAudience,
  type EventReminderKind,
  type EventScheduleResult,
  type NotificationChannel,
} from '../shared';
import { getAppSettings } from './settings.service';
import { notify } from './push.service';
import { getMessageProvider, getRetryPolicy, sendWithRetry, type OutboundChannel } from './messaging';
import { getParticipatingBranchIds } from './special-events.service';

/**
 * Special Event reminders: the schedule, and the dispatcher that drains it.
 *
 * ─── The schedule is RECONCILED, never appended ──────────────────────────────
 * generateEventNotificationSchedule() computes the reminders an event *should*
 * have and makes the table match — but it only ever touches rows still in
 * 'pending'. A reminder that has already been sent, failed or been skipped is
 * immutable. That is what makes moving an event's date safe: the 14-day reminder
 * that went out last week stays sent, and only the ones still ahead move.
 *
 * ─── Three layers stop a double-send ─────────────────────────────────────────
 *   1. event_notifications_key — the schedule physically cannot hold two rows for
 *      the same (event, audience, branch, kind, offset), so regeneration is safe
 *      to call as often as you like.
 *   2. A check-and-set claim (pending → sending) before each send. Zero rows
 *      updated means another process has it. This is what lets a manual dispatch
 *      and the cron job run at the same moment without duplicating anything —
 *      the same atomic pattern as review_production_order.
 *   3. A stale-claim sweep, for the process that died mid-flight.
 *
 * ─── Delivery ────────────────────────────────────────────────────────────────
 * The in-app notification is the reminder; WhatsApp/SMS is an amplifier. A row is
 * 'sent' when the in-app write succeeded, even if every SMS bounced — those
 * failures are visible in notification_logs and must not hide the reminder from
 * the branch. Nothing in here throws: a messaging outage cannot become a 500.
 */

const EVENTS = 'special_events';
const SCHEDULE = 'event_notifications';
const RECIPIENTS = 'notification_recipients';
const LOGS = 'notification_logs';

/** A claim older than this is assumed dead and returned to the queue. */
const STALE_CLAIM_MINUTES = 15;

interface EventRow {
  id: string;
  name: string;
  event_date: string | null;
  event_end_date: string | null;
  demand_due_date: string | null;
  confirmed_date: string | null;
  status: string;
  is_active: boolean;
  applies_to_all_branches: boolean;
  priority: string;
  reminder_lead_days: number;
}

interface DesiredReminder {
  audience: EventNotificationAudience;
  branchId: string | null;
  reminderKind: EventReminderKind;
  offsetDays: number;
  scheduledFor: string;
  title: string;
  message: string;
}

/** 20 March 2027 — the format the reminder bodies read best in. */
function longDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  return d.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function dayWord(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/**
 * The branch reminder body. Mirrors the wording the module was specified with —
 * these go out over WhatsApp verbatim, so they are plain text with blank lines,
 * not markdown.
 */
function branchCountdownMessage(
  companyName: string,
  event: EventRow,
  offsetDays: number,
): { title: string; message: string } {
  const due = event.demand_due_date ? longDate(event.demand_due_date) : 'to be announced';
  const estimateNote = event.confirmed_date
    ? ''
    : '\n\nNote: the event date is an estimate and may shift by a day.';

  return {
    title: `${event.name} — ${dayWord(offsetDays)} to go`,
    message:
      `${companyName}\n\n` +
      `Upcoming Event: ${event.name}\n\n` +
      `Please submit your expected demand before the due date.\n\n` +
      `Demand Due Date:\n${due}` +
      estimateNote,
  };
}

function branchDemandDueMessage(
  companyName: string,
  event: EventRow,
): { title: string; message: string } {
  const due = event.demand_due_date ? longDate(event.demand_due_date) : 'today';
  return {
    title: `${event.name} — demand due tomorrow`,
    message:
      `${companyName}\n\n` +
      `Reminder: advance demand for ${event.name} closes tomorrow.\n\n` +
      `Demand Due Date:\n${due}\n\n` +
      `Branches that have not submitted will not be included in the production plan.`,
  };
}

function productionCountdownMessage(
  companyName: string,
  event: EventRow,
  offsetDays: number,
): { title: string; message: string } {
  const deadline = event.event_date ? longDate(event.event_date) : 'to be announced';
  return {
    title: `${event.name} — ${dayWord(offsetDays)} to go`,
    message:
      `${companyName}\n\n` +
      `Upcoming Event: ${event.name}\n\n` +
      `Please prepare production planning, raw materials, packing materials and manpower ` +
      `according to expected branch demand.\n\n` +
      `Preparation Deadline:\n${deadline}`,
  };
}

/**
 * The reminders an event should have, given its current dates and participants.
 * Pure apart from the branch lookup — the reconcile below decides what to do with
 * the result.
 */
async function buildDesiredSchedule(
  event: EventRow,
  companyName: string,
): Promise<DesiredReminder[]> {
  const out: DesiredReminder[] = [];

  // Nothing to schedule against. A Hijri event whose estimate has not been
  // refreshed yet legitimately lands here.
  if (!event.event_date) return out;

  const branchIds = await getParticipatingBranchIds(event.id, event.applies_to_all_branches);

  // Offsets are per-event, not global: Eid-ul-Adha opens 30 days out while
  // Ashura opens at 7. A fixed cascade either warned the big events too late or
  // nagged for a month about the small ones.
  const branchOffsets = branchReminderOffsets(Number(event.reminder_lead_days));
  const productionOffsets = productionReminderOffsets(Number(event.reminder_lead_days));

  // Branch countdowns — one row per branch rather than a single broadcast, so the
  // in-app notification can carry branchId (the notifications RLS narrows a role
  // broadcast that carries one) and the WhatsApp fan-out hits only that branch's
  // recipients.
  for (const offsetDays of branchOffsets) {
    const { title, message } = branchCountdownMessage(companyName, event, offsetDays);
    for (const branchId of branchIds) {
      out.push({
        audience: 'branch',
        branchId,
        reminderKind: 'event_countdown',
        offsetDays,
        scheduledFor: addDaysToDateStr(event.event_date, -offsetDays),
        title,
        message,
      });
    }
  }

  // The demand deadline reminder is anchored to demand_due_date, not the event.
  if (event.demand_due_date) {
    for (const offsetDays of DEMAND_DUE_REMINDER_OFFSETS) {
      const { title, message } = branchDemandDueMessage(companyName, event);
      for (const branchId of branchIds) {
        out.push({
          audience: 'branch',
          branchId,
          reminderKind: 'demand_due',
          offsetDays,
          scheduledFor: addDaysToDateStr(event.demand_due_date, -offsetDays),
          title,
          message,
        });
      }
    }
  }

  // Production is a central role with no branch claim, so branchId stays null —
  // the same reasoning production-orders.routes.ts documents for the demand
  // notification. A branch id here would filter the reminder out for everyone.
  for (const offsetDays of productionOffsets) {
    const { title, message } = productionCountdownMessage(companyName, event, offsetDays);
    out.push({
      audience: 'production',
      branchId: null,
      reminderKind: 'event_countdown',
      offsetDays,
      scheduledFor: addDaysToDateStr(event.event_date, -offsetDays),
      title,
      message,
    });
  }

  return out;
}

const keyOf = (r: { audience: string; branchId: string | null; reminderKind: string; offsetDays: number }) =>
  `${r.audience}:${r.branchId ?? ''}:${r.reminderKind}:${r.offsetDays}`;

/**
 * Make the schedule match the event's current dates.
 *
 * Call after: create, any update that moves a date or changes participants,
 * confirm-date, an estimate refresh, and roll-forward.
 *
 * A reminder whose date is already past is inserted as 'skipped', NOT 'pending'.
 * Without that, creating an event five days out would fire the 14- and 7-day
 * reminders together in the next dispatch — three messages in one burst for
 * deadlines that have already gone by.
 */
export async function generateEventNotificationSchedule(
  eventId: string,
): Promise<EventScheduleResult> {
  const settings = await getAppSettings();
  const companyName = settings.companyName || 'Mountain Bakes';

  const { data: eventData, error: eventErr } = await supabaseAdmin
    .from(EVENTS)
    .select('id, name, event_date, event_end_date, demand_due_date, confirmed_date, status, is_active, applies_to_all_branches, priority, reminder_lead_days')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) throw eventErr;
  if (!eventData) throw Object.assign(new Error('Event not found'), { status: 404 });

  const event = eventData as EventRow;

  const { data: existingRows, error: exErr } = await supabaseAdmin
    .from(SCHEDULE)
    .select('id, audience, branch_id, reminder_kind, offset_days, scheduled_for, status')
    .eq('event_id', eventId);
  if (exErr) throw exErr;

  const existing = new Map<
    string,
    { id: string; scheduled_for: string; status: string }
  >();
  for (const raw of (existingRows ?? []) as {
    id: string;
    audience: string;
    branch_id: string | null;
    reminder_kind: string;
    offset_days: number;
    scheduled_for: string;
    status: string;
  }[]) {
    existing.set(
      keyOf({
        audience: raw.audience,
        branchId: raw.branch_id,
        reminderKind: raw.reminder_kind,
        offsetDays: raw.offset_days,
      }),
      { id: raw.id, scheduled_for: raw.scheduled_for, status: raw.status },
    );
  }

  // A cancelled or archived event schedules nothing; the desired set is empty and
  // the loop below cancels whatever is still pending.
  const desired =
    event.status === 'cancelled' || !event.is_active ? [] : await buildDesiredSchedule(event, companyName);

  const today = businessDateStr();
  let created = 0;
  let updated = 0;
  let removed = 0;
  let skippedPast = 0;

  const desiredKeys = new Set<string>();

  for (const reminder of desired) {
    const key = keyOf(reminder);
    desiredKeys.add(key);

    const isPast = reminder.scheduledFor < today;
    const prior = existing.get(key);

    if (!prior) {
      const { error } = await supabaseAdmin.from(SCHEDULE).insert({
        event_id: eventId,
        audience: reminder.audience,
        branch_id: reminder.branchId,
        reminder_kind: reminder.reminderKind,
        offset_days: reminder.offsetDays,
        scheduled_for: reminder.scheduledFor,
        title: reminder.title,
        message: reminder.message,
        status: isPast ? 'skipped' : 'pending',
      });
      if (error) throw error;

      if (isPast) skippedPast += 1;
      else created += 1;
      continue;
    }

    // Already sent / failed / skipped — immutable. This is the rule that makes a
    // date change safe to apply at any point in an event's life.
    if (prior.status !== 'pending') continue;

    if (prior.scheduled_for === reminder.scheduledFor && !isPast) continue;

    const { error } = await supabaseAdmin
      .from(SCHEDULE)
      .update({
        scheduled_for: reminder.scheduledFor,
        title: reminder.title,
        message: reminder.message,
        // A pending reminder whose new date is already behind us must not fire in
        // a burst when the dispatcher next runs.
        status: isPast ? 'skipped' : 'pending',
      })
      .eq('id', prior.id)
      .eq('status', 'pending');
    if (error) throw error;

    if (isPast) skippedPast += 1;
    else updated += 1;
  }

  // Reminders that no longer apply — a branch removed from the event, or the
  // event cancelled. Only the pending ones; history is kept.
  const orphanIds = [...existing.entries()]
    .filter(([key, row]) => !desiredKeys.has(key) && row.status === 'pending')
    .map(([, row]) => row.id);

  if (orphanIds.length > 0) {
    const { error } = await supabaseAdmin
      .from(SCHEDULE)
      .update({ status: 'cancelled' })
      .in('id', orphanIds)
      .eq('status', 'pending');
    if (error) throw error;
    removed = orphanIds.length;
  }

  return { created, updated, removed, skippedPast };
}

/** Cancel every pending reminder for an event (soft delete / cancellation path). */
export async function cancelEventNotifications(eventId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from(SCHEDULE)
    .update({ status: 'cancelled' })
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

interface RecipientRow {
  id: string;
  branch_id: string | null;
  department: string | null;
  recipient_name: string;
  mobile_number: string;
  channel: NotificationChannel;
}

interface ScheduleRow {
  id: string;
  event_id: string;
  audience: EventNotificationAudience;
  branch_id: string | null;
  reminder_kind: EventReminderKind;
  offset_days: number;
  scheduled_for: string;
  title: string;
  message: string;
}

/** Return dead claims to the queue before a run picks up work. */
async function sweepStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from(SCHEDULE)
    .update({ status: 'pending' })
    .eq('status', 'sending')
    .lt('claimed_at', cutoff)
    .select('id');
  if (error) throw error;

  const count = (data ?? []).length;
  if (count > 0) console.warn(`[event-notify] returned ${count} stale claim(s) to the queue.`);
  return count;
}

/**
 * Send every reminder due on or before `onDate`.
 *
 * Because the cron schedulers are currently OFF in server.ts, the manual trigger
 * (`trigger: 'manual'`, from the admin screen) is the real delivery mechanism —
 * it is not a convenience. Manual runs deliberately bypass the settings toggle,
 * the same rule dispatchClosingSummaries applies.
 */
export async function dispatchDueEventNotifications(opts: {
  trigger: 'scheduler' | 'manual';
  onDate?: string;
  dryRun?: boolean;
}): Promise<EventDispatchResult> {
  const onDate = opts.onDate ?? businessDateStr();
  const settings = await getAppSettings();

  const empty: EventDispatchResult = {
    onDate,
    dispatched: 0,
    sent: 0,
    failed: 0,
    messagesSent: 0,
    messagesFailed: 0,
  };

  if (opts.trigger === 'scheduler' && !settings.eventNotificationsEnabled) {
    return { ...empty, skipped: 'eventNotificationsEnabled is off' };
  }

  await sweepStaleClaims();

  const { data: dueRows, error: dueErr } = await supabaseAdmin
    .from(SCHEDULE)
    .select('id, event_id, audience, branch_id, reminder_kind, offset_days, scheduled_for, title, message')
    .eq('status', 'pending')
    .lte('scheduled_for', onDate)
    .order('scheduled_for', { ascending: true });
  if (dueErr) throw dueErr;

  const due = (dueRows ?? []) as ScheduleRow[];
  if (due.length === 0) return empty;

  if (opts.dryRun) {
    return { ...empty, dispatched: due.length, skipped: 'dry run — nothing was sent' };
  }

  const { data: recipientRows, error: recErr } = await supabaseAdmin
    .from(RECIPIENTS)
    .select('id, branch_id, department, recipient_name, mobile_number, channel')
    .eq('active', true);
  if (recErr) throw recErr;
  const recipients = (recipientRows ?? []) as RecipientRow[];

  const provider = getMessageProvider();
  const policy = getRetryPolicy();

  let dispatched = 0;
  let sent = 0;
  let failed = 0;
  let messagesSent = 0;
  let messagesFailed = 0;
  const failures: string[] = [];

  for (const row of due) {
    // Check-and-set claim. Zero rows back means another process (the cron job, a
    // second admin click) already owns this reminder.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from(SCHEDULE)
      .update({ status: 'sending', claimed_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id, attempts')
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) continue;

    dispatched += 1;
    const attempts = Number((claimed as { attempts: number }).attempts) + 1;

    // ── In-app: this IS the reminder ──────────────────────────────────────
    let inAppId: string | null = null;
    let inAppError: string | null = null;
    try {
      const targetRole =
        row.audience === 'branch'
          ? 'branch_manager'
          : row.audience === 'production'
            ? 'production_user'
            : 'super_admin';

      const result = await notify({
        type: row.reminder_kind === 'demand_due' ? 'event_demand_due' : 'event_reminder',
        title: row.title,
        message: row.message,
        targetRole,
        branchId: row.branch_id,
        relatedId: row.event_id,
      });
      inAppId = result.id;
    } catch (err) {
      inAppError = err instanceof Error ? err.message : String(err);
    }

    // ── WhatsApp / SMS: an amplifier, logged per attempt ──────────────────
    const targets = recipients.filter((r) => {
      if (row.audience === 'branch') return r.branch_id !== null && r.branch_id === row.branch_id;
      if (row.audience === 'production') return r.department === 'production';
      return r.department === 'admin';
    });

    for (const recipient of targets) {
      const channels: OutboundChannel[] =
        recipient.channel === 'both' ? ['whatsapp', 'sms'] : [recipient.channel as OutboundChannel];

      for (const channel of channels) {
        const result = await sendWithRetry(
          () => provider.send({ to: recipient.mobile_number, body: row.message, channel }),
          policy.maxAttempts,
          policy.baseDelayMs,
        );

        await supabaseAdmin.from(LOGS).insert({
          report_id: null,
          event_notification_id: row.id,
          recipient_id: recipient.id,
          business_date: row.scheduled_for,
          channel,
          status: result.ok ? 'sent' : 'failed',
          provider: provider.name,
          provider_message_id: result.messageId ?? null,
          error_message: result.error ?? null,
          retry_count: result.attempts - 1,
          sent_at: result.ok ? new Date().toISOString() : null,
        });

        if (result.ok) {
          messagesSent += 1;
        } else {
          messagesFailed += 1;
          failures.push(`${recipient.recipient_name} (${recipient.mobile_number}, ${channel}): ${result.error}`);
        }
      }
    }

    // A reminder counts as sent when the in-app write succeeded, even if every
    // outbound message bounced — those are visible in notification_logs and must
    // not hide the reminder from the branch's bell.
    const ok = inAppError === null;
    const { error: finishErr } = await supabaseAdmin
      .from(SCHEDULE)
      .update({
        status: ok ? 'sent' : 'failed',
        attempts,
        in_app_notification_id: inAppId,
        sent_at: ok ? new Date().toISOString() : null,
        error_message: inAppError,
      })
      .eq('id', row.id);
    if (finishErr) throw finishErr;

    if (ok) sent += 1;
    else {
      failed += 1;
      failures.push(`in-app notification for reminder ${row.id}: ${inAppError}`);
    }
  }

  if (failed > 0 || messagesFailed > 0) {
    await escalate(
      onDate,
      `${failed} event reminder(s) failed and ${messagesFailed} message(s) could not be delivered`,
      failures.join('\n'),
      policy.maxAttempts,
    );
  }

  console.log(
    `[event-notify] ${onDate}: ${dispatched} due, ${sent} sent, ${failed} failed, ` +
      `${messagesSent} message(s) delivered, ${messagesFailed} failed (provider=${provider.name}).`,
  );

  return { onDate, dispatched, sent, failed, messagesSent, messagesFailed };
}

/**
 * Surface an unattended failure to the Admin: an in-app notification plus an
 * auto-opened Support Center ticket.
 *
 * Deliberately a local copy of closing-notifications.service.ts's escalate()
 * rather than an extraction. The two differ in their reference id and message,
 * the duplication is ~30 lines, and refactoring a working nightly job to share a
 * helper with a new one is risk with no payoff.
 *
 * Best-effort: it must never throw back into the dispatcher and turn a delivery
 * problem into a failed run.
 */
async function escalate(
  onDate: string,
  title: string,
  detail: string,
  retryCount: number,
): Promise<void> {
  const message = [
    `Dispatch date: ${onDate}`,
    `Retries attempted: ${retryCount}`,
    `Time: ${new Date().toISOString()}`,
    '',
    detail,
  ].join('\n');

  try {
    const { data: ticket, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        reference_type: 'system',
        reference_id: `EVENT-NOTIFY-${onDate}`,
        reference_snapshot: null,
        message: `${title}\n\n${message}`,
        status: 'open',
        raised_by: null,
        raised_by_name: 'System',
        raised_by_role: 'system',
      })
      .select('id, ticket_number')
      .single();
    if (error) throw error;

    await notify({
      type: 'support_query',
      title: `Event reminder issue — ${ticket.ticket_number}`,
      message: `${title} (${onDate})`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: ticket.id,
    });
  } catch (err) {
    console.error('[event-notify] escalation failed:', err instanceof Error ? err.message : err);
  }
}
