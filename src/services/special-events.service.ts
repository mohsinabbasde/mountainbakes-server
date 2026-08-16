import { supabaseAdmin } from '../config/supabase';
import {
  addDaysToDateStr,
  businessDateStr,
  daysBetweenDateStr,
  estimateGregorianForHijri,
  formatHijriFor,
  hijriAnniversariesIn,
  lastWeekdayOfHijriMonthIn,
  nthWeekdayOf,
  type EventCalendarSystem,
  type EventProductionStage,
  type SpecialEvent,
  type SpecialEventView,
} from '../shared';
import { rowToApi } from '../utils/case';

/**
 * Special Events — date resolution and the two maintenance jobs.
 *
 * The one idea worth holding onto: an event's date has TWO sources. The anchor
 * (a Hijri month/day, a Gregorian month/day, or an nth-weekday rule) produces an
 * ESTIMATE; the admin's `confirmed_date` overrides it. `event_date` is a
 * generated column over coalesce(confirmed, estimated), so every query has one
 * indexable column and nothing downstream has to know which source won.
 *
 * That is also why `estimated_date` is stored rather than computed on read:
 * Postgres cannot call the Hijri helper, and a computed value cannot be indexed
 * by the calendar, list, countdown and reminder queries that all filter on it.
 */

const EVENTS = 'special_events';
const EVENT_BRANCHES = 'event_branches';
const DEMANDS = 'event_branch_demands';
const DEMAND_ITEMS = 'event_branch_demand_items';
const PRODUCTION_STATUS = 'event_production_status';

/** The anchor columns the resolver reads. Deliberately a plain shape, not a row type. */
export interface EventAnchorInput {
  calendarSystem: EventCalendarSystem;
  eventYear: number;
  hijriMonth?: number | null;
  hijriDay?: number | null;
  gregorianMonth?: number | null;
  gregorianDay?: number | null;
  nthWeekday?: number | null;
  weekday?: number | null;
  /** Days added after the anchor resolves. Black Friday = 4th Thursday + 1. */
  anchorOffsetDays?: number | null;
  isRecurring?: boolean;
  confirmedDate?: string | null;
  demandLeadDays?: number | null;
  /** Explicit override; when absent the due date is derived from the lead days. */
  demandDueDate?: string | null;
  preparationStartDate?: string | null;
}

export interface ResolvedEventDates {
  estimatedDate: string | null;
  demandDueDate: string | null;
  preparationStartDate: string | null;
}

/** Preparation starts this many days before the event when nothing else says otherwise. */
const DEFAULT_PREPARATION_LEAD_DAYS = 21;

/**
 * Resolve an event's dates from its anchor.
 *
 * Pure and synchronous on purpose — it takes columns and returns columns, which
 * is what makes it checkable by scripts/verify-hijri.ts without a database.
 *
 * A null estimate is a legitimate outcome, not an error: a Hijri anniversary can
 * fall zero times in a given Gregorian year (a Hijri year is ~354 days), and an
 * nth-weekday rule can ask for a 5th Sunday a month does not have.
 */
export function resolveEventDates(input: EventAnchorInput): ResolvedEventDates {
  let estimatedDate: string | null = null;

  if (input.calendarSystem === 'hijri' && input.hijriMonth && input.hijriDay) {
    estimatedDate = estimateGregorianForHijri(input.hijriMonth, input.hijriDay, input.eventYear);
  } else if (input.calendarSystem === 'gregorian' && input.gregorianMonth && input.gregorianDay) {
    const month = String(input.gregorianMonth).padStart(2, '0');
    const day = String(input.gregorianDay).padStart(2, '0');
    const candidate = `${input.eventYear}-${month}-${day}`;
    // Rejects 31 April and 29 February in a common year rather than letting Date
    // roll it silently into the next month.
    const parsed = new Date(`${candidate}T12:00:00.000Z`);
    estimatedDate = Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
      ? null
      : candidate;
  } else if (
    input.calendarSystem === 'gregorian_nth_weekday' &&
    input.gregorianMonth &&
    input.nthWeekday !== null &&
    input.nthWeekday !== undefined &&
    input.weekday !== null &&
    input.weekday !== undefined
  ) {
    estimatedDate = nthWeekdayOf(input.eventYear, input.gregorianMonth, input.nthWeekday, input.weekday);
  } else if (
    input.calendarSystem === 'hijri_last_weekday' &&
    input.hijriMonth &&
    input.weekday !== null &&
    input.weekday !== undefined
  ) {
    estimatedDate = lastWeekdayOfHijriMonthIn(input.hijriMonth, input.weekday, input.eventYear)[0] ?? null;
  }

  // Applied AFTER the anchor resolves, never folded into it: Black Friday is
  // "the 4th Thursday of November, plus one day", and collapsing that to "the
  // last Friday of November" is wrong in any year November starts on a Thursday.
  const offset = input.anchorOffsetDays ?? 0;
  if (estimatedDate && offset !== 0) estimatedDate = addDaysToDateStr(estimatedDate, offset);

  // The confirmation wins for every derived date too — otherwise confirming a
  // date two days later would leave the demand deadline anchored to the estimate.
  const effectiveDate = input.confirmedDate ?? estimatedDate;

  const leadDays = input.demandLeadDays ?? 10;
  const demandDueDate =
    input.demandDueDate ?? (effectiveDate ? addDaysToDateStr(effectiveDate, -leadDays) : null);

  const preparationStartDate =
    input.preparationStartDate ??
    (effectiveDate ? addDaysToDateStr(effectiveDate, -DEFAULT_PREPARATION_LEAD_DAYS) : null);

  return { estimatedDate, demandDueDate, preparationStartDate };
}

/**
 * Derive a series code from an event name when the caller did not supply one:
 * "Weekend Mega Sale" → "CO-WEEKEND-MEGA-SALE". The series code is what ties
 * next year's occurrence to this one, so it has to be stable and readable.
 */
export function deriveSeriesCode(name: string, category: string): string {
  const prefix =
    category === 'islamic'
      ? 'ISL'
      : category === 'ahlul_bayt'
        ? 'AB'
        : category === 'national'
          ? 'NAT'
          : category === 'international'
            ? 'INT'
            : 'CO';
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${prefix}-${slug || 'EVENT'}`;
}

/** Row → API view, plus the fields the UI would otherwise re-derive everywhere. */
export function toEventView(row: Record<string, unknown>): SpecialEventView {
  const event = rowToApi<SpecialEvent>(row);
  const today = businessDateStr();

  return {
    ...event,
    // Numeric columns come back from PostgREST as strings for numeric(), but
    // these are smallint/integer and arrive as numbers. Coerced anyway so the
    // contract holds if a column type ever changes.
    durationDays: Number(event.durationDays),
    demandLeadDays: Number(event.demandLeadDays),
    reminderLeadDays: Number(event.reminderLeadDays),
    anchorOffsetDays: Number(event.anchorOffsetDays),
    dateIsEstimated: event.confirmedDate === null,
    daysRemaining: event.eventDate ? daysBetweenDateStr(today, event.eventDate) : null,
    hijriLabel: event.eventDate ? formatHijriFor(event.eventDate) : null,
  };
}

/**
 * The branch ids an event applies to. Returns null when it applies to every
 * branch — callers use that to skip the per-branch filter entirely rather than
 * fetching and comparing a full branch list.
 */
export async function getEventBranchIds(
  eventId: string,
  appliesToAllBranches: boolean,
): Promise<string[] | null> {
  if (appliesToAllBranches) return null;

  const { data, error } = await supabaseAdmin
    .from(EVENT_BRANCHES)
    .select('branch_id')
    .eq('event_id', eventId);
  if (error) throw error;

  return (data ?? []).map((r) => (r as { branch_id: string }).branch_id);
}

/** Every active branch id — the participant list when appliesToAllBranches is true. */
export async function getActiveBranchIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('branches').select('id').eq('is_active', true);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { id: string }).id);
}

/** Resolved participant list for an event, whichever way it is scoped. */
export async function getParticipatingBranchIds(
  eventId: string,
  appliesToAllBranches: boolean,
): Promise<string[]> {
  const assigned = await getEventBranchIds(eventId, appliesToAllBranches);
  return assigned ?? (await getActiveBranchIds());
}

/**
 * 403 unless the branch participates in the event.
 *
 * Load-bearing, because the API reaches Postgres with the service-role key and
 * bypasses RLS: this function IS the access check, not a second line of defence.
 * The branchId passed in must come from req.user, never from the request.
 */
export async function assertBranchMayAccessEvent(
  eventId: string,
  branchId: string | null,
): Promise<void> {
  if (!branchId) {
    throw Object.assign(new Error('No branch assigned to this account'), { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from(EVENTS)
    .select('id, applies_to_all_branches, is_active')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Event not found'), { status: 404 });

  const row = data as { applies_to_all_branches: boolean; is_active: boolean };
  if (!row.is_active) throw Object.assign(new Error('Event not found'), { status: 404 });
  if (row.applies_to_all_branches) return;

  const { data: assignment, error: assignErr } = await supabaseAdmin
    .from(EVENT_BRANCHES)
    .select('branch_id')
    .eq('event_id', eventId)
    .eq('branch_id', branchId)
    .maybeSingle();
  if (assignErr) throw assignErr;

  if (!assignment) {
    throw Object.assign(new Error('This event does not apply to your branch'), { status: 403 });
  }
}

/** Replace an event's branch assignment list. */
export async function setEventBranches(eventId: string, branchIds: string[]): Promise<void> {
  const { error: delErr } = await supabaseAdmin.from(EVENT_BRANCHES).delete().eq('event_id', eventId);
  if (delErr) throw delErr;

  if (branchIds.length === 0) return;

  const unique = [...new Set(branchIds)];
  const { error } = await supabaseAdmin
    .from(EVENT_BRANCHES)
    .insert(unique.map((branchId) => ({ event_id: eventId, branch_id: branchId })));
  if (error) throw error;
}

/**
 * Mean of the four stage percentages, 0–100. Computed on read rather than stored
 * because a stored aggregate needs its own trigger and drifts from the rows it
 * summarises.
 */
export function readinessFromStages(
  stages: { completion_percentage: number | string }[],
): number {
  if (stages.length === 0) return 0;
  const total = stages.reduce((sum, s) => sum + Number(s.completion_percentage), 0);
  return Math.round(total / stages.length);
}

/** Readiness for many events in one query, keyed by event id. */
export async function getReadinessByEvent(eventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (eventIds.length === 0) return out;

  const { data, error } = await supabaseAdmin
    .from(PRODUCTION_STATUS)
    .select('event_id, completion_percentage')
    .in('event_id', eventIds);
  if (error) throw error;

  const grouped = new Map<string, { completion_percentage: number }[]>();
  for (const row of (data ?? []) as { event_id: string; completion_percentage: number }[]) {
    const list = grouped.get(row.event_id) ?? [];
    list.push({ completion_percentage: row.completion_percentage });
    grouped.set(row.event_id, list);
  }
  for (const [eventId, stages] of grouped) out.set(eventId, readinessFromStages(stages));
  return out;
}

/** Demand participation counts for many events in one pair of queries. */
export async function getDemandSummaryByEvent(
  eventIds: string[],
): Promise<Map<string, { submitted: number; draft: number; totalItems: number; totalQty: number }>> {
  const out = new Map<string, { submitted: number; draft: number; totalItems: number; totalQty: number }>();
  if (eventIds.length === 0) return out;

  const { data, error } = await supabaseAdmin
    .from(DEMANDS)
    .select('id, event_id, status')
    .in('event_id', eventIds);
  if (error) throw error;

  const demands = (data ?? []) as { id: string; event_id: string; status: string }[];

  // Line counts come from a second query keyed on the demand ids just found, so
  // an event with no demands costs nothing here.
  const itemsByDemand = new Map<string, { count: number; qty: number }>();
  if (demands.length > 0) {
    const { data: itemRows, error: itemErr } = await supabaseAdmin
      .from(DEMAND_ITEMS)
      .select('demand_id, qty, approved_qty')
      .in('demand_id', demands.map((d) => d.id));
    if (itemErr) throw itemErr;

    for (const item of (itemRows ?? []) as {
      demand_id: string;
      qty: string | number;
      approved_qty: string | number | null;
    }[]) {
      const acc = itemsByDemand.get(item.demand_id) ?? { count: 0, qty: 0 };
      acc.count += 1;
      acc.qty += Number(item.approved_qty ?? item.qty);
      itemsByDemand.set(item.demand_id, acc);
    }
  }

  for (const eventId of eventIds) {
    out.set(eventId, { submitted: 0, draft: 0, totalItems: 0, totalQty: 0 });
  }
  for (const demand of demands) {
    const acc = out.get(demand.event_id);
    if (!acc) continue;
    // 'draft' is started-but-not-sent; everything past submission counts as in.
    if (demand.status === 'draft') acc.draft += 1;
    else acc.submitted += 1;

    const items = itemsByDemand.get(demand.id);
    if (items) {
      acc.totalItems += items.count;
      acc.totalQty += items.qty;
    }
  }

  return out;
}

/**
 * Participant counts for many events, without an N+1.
 *
 * Most events apply to every branch, so the active-branch list is fetched once
 * and reused; only the selectively-scoped ones need the assignment table, and
 * those are read in a single `in` query rather than one per event.
 */
export async function getParticipantCountByEvent(
  events: { id: string; appliesToAllBranches: boolean }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (events.length === 0) return out;

  const allBranchEvents = events.filter((e) => e.appliesToAllBranches);
  const scopedEvents = events.filter((e) => !e.appliesToAllBranches);

  if (allBranchEvents.length > 0) {
    const activeCount = (await getActiveBranchIds()).length;
    for (const event of allBranchEvents) out.set(event.id, activeCount);
  }

  if (scopedEvents.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(EVENT_BRANCHES)
      .select('event_id')
      .in('event_id', scopedEvents.map((e) => e.id));
    if (error) throw error;

    for (const event of scopedEvents) out.set(event.id, 0);
    for (const row of (data ?? []) as { event_id: string }[]) {
      out.set(row.event_id, (out.get(row.event_id) ?? 0) + 1);
    }
  }

  return out;
}

/**
 * Recompute `estimated_date` (and the derived deadlines) for events whose date is
 * not confirmed.
 *
 * Must be run at least once after migration 41 — the seeded catalogue ships with
 * estimated_date NULL because the Hijri conversion lives in TypeScript, so until
 * this runs every seeded event has a null event_date and appears nowhere.
 *
 * Only touches rows with confirmed_date IS NULL: refreshing an estimate must
 * never overwrite an admin's confirmation.
 */
export async function refreshEventEstimates(opts?: { year?: number }): Promise<{
  updated: number;
  unresolved: number;
}> {
  let query = supabaseAdmin
    .from(EVENTS)
    // One string literal, not a concatenation: supabase-js infers the row type
    // from the select string at the type level, and a runtime-built string
    // degrades to `string` and hands back GenericStringError[].
    .select('id, event_year, calendar_system, hijri_month, hijri_day, gregorian_month, gregorian_day, nth_weekday, weekday, is_recurring, confirmed_date, estimated_date, demand_lead_days, demand_due_date, preparation_start_date')
    .is('confirmed_date', null)
    .eq('is_active', true);

  if (opts?.year) query = query.eq('event_year', opts.year);

  const { data, error } = await query;
  if (error) throw error;

  let updated = 0;
  let unresolved = 0;

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const row = rowToApi<{
      id: string;
      eventYear: number;
      calendarSystem: EventCalendarSystem;
      hijriMonth: number | null;
      hijriDay: number | null;
      gregorianMonth: number | null;
      gregorianDay: number | null;
      nthWeekday: number | null;
      weekday: number | null;
      isRecurring: boolean;
      confirmedDate: string | null;
      estimatedDate: string | null;
      demandLeadDays: number;
      demandDueDate: string | null;
      preparationStartDate: string | null;
    }>(raw);

    const resolved = resolveEventDates({
      calendarSystem: row.calendarSystem,
      eventYear: row.eventYear,
      hijriMonth: row.hijriMonth,
      hijriDay: row.hijriDay,
      gregorianMonth: row.gregorianMonth,
      gregorianDay: row.gregorianDay,
      nthWeekday: row.nthWeekday,
      weekday: row.weekday,
      isRecurring: row.isRecurring,
      confirmedDate: null,
      demandLeadDays: row.demandLeadDays,
      // Deliberately NOT passing the stored dates through: this recomputes them
      // from the new estimate. An admin-set deadline that must survive a refresh
      // belongs on a confirmed event.
    });

    if (!resolved.estimatedDate) {
      unresolved += 1;
      continue;
    }
    if (resolved.estimatedDate === row.estimatedDate) continue;

    const { error: updErr } = await supabaseAdmin
      .from(EVENTS)
      .update({
        estimated_date: resolved.estimatedDate,
        demand_due_date: resolved.demandDueDate,
        preparation_start_date: resolved.preparationStartDate,
      })
      .eq('id', row.id);
    if (updErr) throw updErr;

    updated += 1;
  }

  console.log(`[special-events] refreshEventEstimates: ${updated} updated, ${unresolved} unresolved.`);
  return { updated, unresolved };
}

/**
 * Make sure `year` is fully populated, then return what changed.
 *
 * This is the auto-detection the module runs on. The admin does not type event
 * dates and does not press a button to roll the calendar forward: opening any
 * year materialises it from the series anchors. Islamic events resolve through
 * the Umm al-Qura calendar, Gregorian ones from their fixed month/day, and
 * nth-weekday ones from their rule.
 *
 * Idempotent by construction, which is what makes it safe to call on every read:
 *  - a series that already has its occurrences for the year is left alone;
 *  - an occurrence that already has a date is left alone;
 *  - a CONFIRMED date is never touched — an admin's moon-sighting override
 *    outranks anything computed here.
 *
 * It CREATES rather than mutates, because one row per occurrence is what keeps
 * last year's confirmed date, demands and outcome intact (migration 41's header).
 *
 * The double-occurrence case is real and handled: a Hijri year is ~354 days, so
 * an anniversary can fall twice in one Gregorian year (15 Sha'ban falls on both
 * 2028-01-12 and 2028-12-31) or skip it entirely. `hijriAnniversariesIn` returns
 * every hit and each gets its own row, distinguished by occurrence_index
 * (migration 43).
 */
export async function ensureEventYear(year: number): Promise<{
  created: number;
  resolved: number;
  skipped: number;
}> {
  // The template for each series is its most recent occurrence in ANY year — it
  // carries the admin's latest edits to the name, lead days, priority and colour.
  // Deliberately not restricted to years before `year`, so opening a past year
  // back-fills it just as readily as a future one.
  const { data, error } = await supabaseAdmin
    .from(EVENTS)
    .select('*')
    .eq('is_recurring', true)
    .eq('is_active', true)
    .order('event_year', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as Record<string, unknown>[];

  const templateBySeries = new Map<string, Record<string, unknown>>();
  // occurrence_index values already present for this year, per series.
  const presentBySeries = new Map<string, Set<number>>();
  // Rows in this year that resolved to no date at all and can be filled in.
  const unresolvedThisYear: Record<string, unknown>[] = [];

  for (const row of rows) {
    const code = row['series_code'] as string;
    if (!templateBySeries.has(code)) templateBySeries.set(code, row);

    if (row['event_year'] === year) {
      const seen = presentBySeries.get(code) ?? new Set<number>();
      seen.add(Number(row['occurrence_index'] ?? 1));
      presentBySeries.set(code, seen);

      if (row['confirmed_date'] === null && row['estimated_date'] === null) {
        unresolvedThisYear.push(row);
      }
    }
  }

  let created = 0;
  let resolved = 0;
  let skipped = 0;
  const touched: string[] = [];

  // ── 1. Fill in rows that exist but never got a date ──────────────────────
  // This is what the seeded catalogue looks like before anything has run: the
  // Hijri conversion lives in TypeScript, so migration 41 could not write it.
  for (const row of unresolvedThisYear) {
    const dates = resolveOccurrenceDates(row, year);
    const index = Number(row['occurrence_index'] ?? 1);
    const target = dates[index - 1];

    if (!target) {
      skipped += 1;
      continue;
    }

    const { error: updErr } = await supabaseAdmin
      .from(EVENTS)
      .update({
        estimated_date: target.estimatedDate,
        demand_due_date: target.demandDueDate,
        preparation_start_date: target.preparationStartDate,
      })
      .eq('id', row['id'] as string)
      // Re-assert the guard at write time: a confirmation landing between the
      // read above and this update must win.
      .is('confirmed_date', null);
    if (updErr) throw updErr;

    resolved += 1;
    touched.push(row['id'] as string);
  }

  // ── 2. Create the occurrences this year is missing ───────────────────────
  for (const [seriesCode, template] of templateBySeries) {
    const present = presentBySeries.get(seriesCode) ?? new Set<number>();
    const dates = resolveOccurrenceDates(template, year);

    if (dates.length === 0) {
      // Legitimate: a Hijri anniversary can fall zero times in a Gregorian year.
      skipped += 1;
      continue;
    }

    for (let i = 0; i < dates.length; i += 1) {
      const occurrenceIndex = i + 1;
      if (present.has(occurrenceIndex)) continue;

      const target = dates[i]!;
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from(EVENTS)
        .insert({
          series_code: seriesCode,
          event_year: year,
          occurrence_index: occurrenceIndex,
          name: template['name'],
          description: template['description'],
          category: template['category'],
          event_type: template['event_type'],
          calendar_system: template['calendar_system'],
          hijri_month: template['hijri_month'],
          hijri_day: template['hijri_day'],
          gregorian_month: template['gregorian_month'],
          gregorian_day: template['gregorian_day'],
          nth_weekday: template['nth_weekday'],
          weekday: template['weekday'],
          // Both of these MUST be carried across. The resolved date already
          // accounts for the offset, but a row that stores 0 would resolve to the
          // wrong day the next time its estimate is refreshed; and a missing
          // reminder lead silently falls back to the column default, which turned
          // Cyber Monday's 10-day warning into 14 and Tashreeq's 7 into 14.
          anchor_offset_days: template['anchor_offset_days'] ?? 0,
          reminder_lead_days: template['reminder_lead_days'],
          is_recurring: true,
          estimated_date: target.estimatedDate,
          // confirmed_date is deliberately NOT copied — last year's announcement
          // says nothing about this year's moon sighting.
          confirmed_date: null,
          duration_days: template['duration_days'],
          demand_due_date: target.demandDueDate,
          demand_lead_days: template['demand_lead_days'],
          preparation_start_date: target.preparationStartDate,
          status: 'upcoming',
          priority: template['priority'],
          applies_to_all_branches: template['applies_to_all_branches'],
          color: template['color'],
          notes: template['notes'],
          created_by: null,
          created_by_name: 'System (auto-detected)',
        })
        .select('id')
        .single();

      if (insErr) {
        // 23505 means another request materialised this occurrence first. That is
        // the expected outcome of two concurrent reads racing, not an error —
        // the unique key is doing exactly its job.
        if ((insErr as { code?: string }).code === '23505') continue;
        throw insErr;
      }

      // Carry the branch assignment across; without it a selectively-scoped
      // event silently becomes an event nobody participates in.
      if (template['applies_to_all_branches'] === false) {
        const branchIds = await getEventBranchIds(template['id'] as string, false);
        if (branchIds && branchIds.length > 0) {
          await setEventBranches((inserted as { id: string }).id, branchIds);
        }
      }

      created += 1;
      touched.push((inserted as { id: string }).id);
    }
  }

  if (touched.length > 0) {
    console.log(
      `[special-events] ensureEventYear(${year}): ${created} created, ${resolved} resolved, ${skipped} skipped.`,
    );
  }

  return { created, resolved, skipped };
}

/**
 * Every date a template's anchor resolves to inside `year`, in chronological
 * order. Usually one; zero or two for a Hijri anchor.
 */
function resolveOccurrenceDates(
  template: Record<string, unknown>,
  year: number,
): ResolvedEventDates[] {
  const calendarSystem = template['calendar_system'] as EventCalendarSystem;
  const leadDays = Number(template['demand_lead_days'] ?? 10);

  const offset = Number(template['anchor_offset_days'] ?? 0);

  const base = {
    calendarSystem,
    eventYear: year,
    hijriMonth: template['hijri_month'] as number | null,
    hijriDay: template['hijri_day'] as number | null,
    gregorianMonth: template['gregorian_month'] as number | null,
    gregorianDay: template['gregorian_day'] as number | null,
    nthWeekday: template['nth_weekday'] as number | null,
    weekday: template['weekday'] as number | null,
    anchorOffsetDays: offset,
    isRecurring: true,
    confirmedDate: null,
    demandLeadDays: leadDays,
  };

  /** One resolved date → the trio of dates an occurrence needs. */
  const expand = (date: string): ResolvedEventDates => {
    const shifted = offset === 0 ? date : addDaysToDateStr(date, offset);
    return {
      estimatedDate: shifted,
      demandDueDate: addDaysToDateStr(shifted, -leadDays),
      preparationStartDate: addDaysToDateStr(shifted, -DEFAULT_PREPARATION_LEAD_DAYS),
    };
  };

  // Both Hijri anchors can legitimately hit a Gregorian year twice, or miss it —
  // see the double-occurrence note on ensureEventYear. The Gregorian anchors
  // always hit exactly once.
  if (calendarSystem === 'hijri' && base.hijriMonth && base.hijriDay) {
    return hijriAnniversariesIn(base.hijriMonth, base.hijriDay, year).map(expand);
  }

  if (calendarSystem === 'hijri_last_weekday' && base.hijriMonth && base.weekday !== null) {
    return lastWeekdayOfHijriMonthIn(base.hijriMonth, base.weekday!, year).map(expand);
  }

  const single = resolveEventDates(base);
  return single.estimatedDate ? [single] : [];
}

/**
 * Kept as a thin wrapper so the maintenance route and the nightly job keep their
 * meaning: "make sure next year exists". All the work is ensureEventYear's.
 */
export async function rollForwardRecurringEvents(opts?: { targetYear?: number }): Promise<{
  created: number;
  skipped: number;
}> {
  const targetYear = opts?.targetYear ?? Number(businessDateStr().slice(0, 4)) + 1;
  const result = await ensureEventYear(targetYear);
  return { created: result.created, skipped: result.skipped };
}

/**
 * Advance statuses that are purely a function of today's date: an event whose
 * window has started becomes 'active', one whose window has passed becomes
 * 'completed'. 'cancelled' is an admin decision and is never touched here.
 */
export async function refreshEventStatuses(): Promise<{ activated: number; completed: number }> {
  const today = businessDateStr();

  const { data: activated, error: actErr } = await supabaseAdmin
    .from(EVENTS)
    .update({ status: 'active' })
    .eq('status', 'upcoming')
    .eq('is_active', true)
    .lte('event_date', today)
    .gte('event_end_date', today)
    .select('id');
  if (actErr) throw actErr;

  const { data: completed, error: compErr } = await supabaseAdmin
    .from(EVENTS)
    .update({ status: 'completed' })
    .in('status', ['upcoming', 'active'])
    .eq('is_active', true)
    .lt('event_end_date', today)
    .select('id');
  if (compErr) throw compErr;

  return { activated: (activated ?? []).length, completed: (completed ?? []).length };
}

/** Stage rows for one event, in enum order. */
export async function getProductionStages(eventId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin
    .from(PRODUCTION_STATUS)
    .select('*')
    .eq('event_id', eventId);
  if (error) throw error;

  const order: EventProductionStage[] = [
    'raw_materials',
    'packing_materials',
    'finished_products',
    'staff_assigned',
  ];
  return (data ?? []).sort(
    (a, b) =>
      order.indexOf((a as { stage: EventProductionStage }).stage) -
      order.indexOf((b as { stage: EventProductionStage }).stage),
  ) as Record<string, unknown>[];
}
