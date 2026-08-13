import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  AssignEventBranchesSchema,
  ConfirmEventDateSchema,
  CreateSpecialEventSchema,
  DispatchEventNotificationsSchema,
  RefreshEventEstimatesSchema,
  ReviewEventDemandSchema,
  RollForwardEventsSchema,
  SaveEventDemandSchema,
  UpdateEventStageSchema,
  UpdateEventStatusSchema,
  UpdateSpecialEventSchema,
  businessDateStr,
  daysBetweenDateStr,
  EVENT_STAGES,
  type ConsolidatedDemandRow,
  type EventDashboardSummary,
  type EventProductionStage,
  type SpecialEventView,
  BRANCH_ROLES,
  isBranchRole,
} from '../shared';
import { notify } from '../services/push.service';
import { rowToApi } from '../utils/case';
import { getCached, invalidate, setCached } from '../utils/cache';
import {
  assertBranchMayAccessEvent,
  deriveSeriesCode,
  ensureEventYear,
  getDemandSummaryByEvent,
  getEventBranchIds,
  getParticipantCountByEvent,
  getParticipatingBranchIds,
  getProductionStages,
  getReadinessByEvent,
  readinessFromStages,
  refreshEventEstimates,
  refreshEventStatuses,
  resolveEventDates,
  rollForwardRecurringEvents,
  setEventBranches,
  toEventView,
} from '../services/special-events.service';
import {
  cancelEventNotifications,
  dispatchDueEventNotifications,
  generateEventNotificationSchedule,
} from '../services/event-notifications.service';

export const router = Router();

const EVENTS = 'special_events';
const EVENT_BRANCHES = 'event_branches';
const DEMANDS = 'event_branch_demands';
const DEMAND_ITEMS = 'event_branch_demand_items';
const PRODUCTION_STATUS = 'event_production_status';
const SCHEDULE = 'event_notifications';

/**
 * Demand lines are ordered by line_no explicitly — PostgREST gives no ordering
 * guarantee for an embedded resource on its own (the same note ORDER_SELECT
 * carries in production-orders.routes.ts).
 */
const DEMAND_SELECT = `
  *,
  items:event_branch_demand_items(
    id, demand_id, product_id, product_name, qty, approved_qty, prepared_qty,
    unit_price, remarks, line_no
  )
`;
const DEMAND_ITEMS_ORDER = { referencedTable: 'event_branch_demand_items', ascending: true } as const;

router.use(authenticate);

/**
 * Materialise a year's events before reading it, at most once per minute per
 * year per process.
 *
 * The events catalogue is AUTO-DETECTED, not typed in: Islamic events resolve
 * through the Umm al-Qura calendar and shift ~11 days earlier each Gregorian
 * year, so an admin maintaining them by hand would be re-entering the whole
 * calendar annually and getting it wrong. Opening a year is what creates it.
 *
 * The TTL cache is a hot-path guard, not correctness — ensureEventYear is
 * idempotent, so the worst a cache miss costs is a redundant no-op pass. Only
 * a genuinely-changed year does any writing.
 */
async function ensureYearMaterialised(year: number): Promise<void> {
  if (!Number.isFinite(year) || year < 2000 || year > 2200) return;

  const cacheKey = `specialEvents:year:${year}`;
  if (getCached<boolean>(cacheKey)) return;

  try {
    await ensureEventYear(year);
    setCached(cacheKey, true);
  } catch (err) {
    // A read must never 500 because auto-detection had a bad day — the caller
    // still gets whatever is already in the table.
    console.error('[special-events] ensureEventYear failed:', err instanceof Error ? err.message : err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Every literal sub-path is declared BEFORE '/:id'. Express matches in
// declaration order, so '/notifications' registered after '/:id' would be
// swallowed as an event id — the hazard '/balances' documents in
// production-orders.routes.ts.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Branch managers only ever see events their branch participates in. Returns the
 * event-id filter to apply, or null when no filter is needed.
 *
 * The API bypasses RLS, so this IS the access control.
 */
async function branchVisibleEventIds(branchId: string | null): Promise<string[] | null> {
  if (!branchId) return [];

  const { data, error } = await supabaseAdmin
    .from(EVENT_BRANCHES)
    .select('event_id')
    .eq('branch_id', branchId);
  if (error) throw error;

  return (data ?? []).map((r) => (r as { event_id: string }).event_id);
}

/** Apply the caller's role scoping to a list query over special_events. */
async function scopedEventRows(
  req: AuthRequest,
  build: (q: ReturnType<typeof supabaseAdmin.from>) => unknown,
): Promise<Record<string, unknown>[]> {
  // Typed loosely because the PostgREST builder is chained per call site; the
  // rows themselves are converted through rowToApi immediately after.
  const query = build(supabaseAdmin.from(EVENTS)) as {
    or: (f: string) => unknown;
    then: unknown;
  };

  if (!isBranchRole(req.user!.role)) {
    const { data, error } = (await query) as unknown as {
      data: Record<string, unknown>[] | null;
      error: unknown;
    };
    if (error) throw error;
    return data ?? [];
  }

  const assigned = await branchVisibleEventIds(req.user!.branchId);
  // An event either applies to everyone, or names this branch explicitly.
  const filter =
    assigned && assigned.length > 0
      ? `applies_to_all_branches.eq.true,id.in.(${assigned.join(',')})`
      : 'applies_to_all_branches.eq.true';

  const { data, error } = (await query.or(filter)) as unknown as {
    data: Record<string, unknown>[] | null;
    error: unknown;
  };
  if (error) throw error;
  return data ?? [];
}

/** Attach readiness + demand participation to a list of event views. */
async function decorateEvents(events: SpecialEventView[]): Promise<SpecialEventView[]> {
  if (events.length === 0) return events;

  const ids = events.map((e) => e.id);
  const readiness = await getReadinessByEvent(ids);

  // Participant counts drive "pending branches": a branch with no demand row at
  // all is pending, which is the normal state before anyone has started.
  // Batched deliberately — one lookup per event here was an N+1 on the main list.
  const participantCounts = await getParticipantCountByEvent(events);
  const demand = await getDemandSummaryByEvent(ids);

  return events.map((event) => {
    const counts = demand.get(event.id) ?? { submitted: 0, draft: 0, totalItems: 0, totalQty: 0 };
    const totalBranches = participantCounts.get(event.id) ?? 0;
    return {
      ...event,
      readinessPercentage: readiness.get(event.id) ?? 0,
      demandSummary: {
        totalBranches,
        submittedBranches: counts.submitted,
        draftBranches: counts.draft,
        pendingBranches: Math.max(0, totalBranches - counts.submitted),
        totalItems: counts.totalItems,
        totalQty: counts.totalQty,
      },
    };
  });
}

// GET /api/special-events — list, filtered by year / category / status.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const year = req.query['year'] ? Number(req.query['year']) : null;
    const category = (req.query['category'] as string) || null;
    const status = (req.query['status'] as string) || null;
    // Only a super admin may see soft-deleted events.
    const includeInactive = req.query['includeInactive'] === 'true' && req.user!.role === 'super_admin';

    // Auto-detect the requested year before reading it.
    if (year) await ensureYearMaterialised(year);

    const rows = await scopedEventRows(req, (table) => {
      let q = table.select('*').order('event_date', { ascending: true, nullsFirst: false });
      if (!includeInactive) q = q.eq('is_active', true);
      if (year) q = q.eq('event_year', year);
      if (category) q = q.eq('category', category);
      if (status) q = q.eq('status', status);
      return q;
    });

    const events = await decorateEvents(rows.map(toEventView));
    res.json({ events, total: events.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/special-events/calendar?year=&month= — one month's events.
// Range-filtered on event_date/event_end_date so a multi-day event that starts in
// the previous month still appears on the days it spans.
router.get('/calendar', async (req: AuthRequest, res, next) => {
  try {
    const now = businessDateStr();
    const year = req.query['year'] ? Number(req.query['year']) : Number(now.slice(0, 4));
    const month = req.query['month'] ? Number(req.query['month']) : Number(now.slice(5, 7));

    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'year and month must be valid numbers (month 1-12)' });
      return;
    }

    await ensureYearMaterialised(year);

    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const rows = await scopedEventRows(req, (table) =>
      table
        .select('*')
        .eq('is_active', true)
        .not('event_date', 'is', null)
        .lte('event_date', last)
        .gte('event_end_date', first)
        .order('event_date', { ascending: true }),
    );

    res.json({ events: rows.map(toEventView), year, month });
  } catch (err) {
    next(err);
  }
});

// GET /api/special-events/summary — the dashboard cards, shaped by role.
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const today = businessDateStr();

    // The dashboard is often the first screen touched, and "days to next event"
    // is wrong if next year has not been materialised yet — in December the next
    // event is usually in January.
    const currentYear = Number(today.slice(0, 4));
    await ensureYearMaterialised(currentYear);
    await ensureYearMaterialised(currentYear + 1);

    const rows = await scopedEventRows(req, (table) =>
      table.select('*').eq('is_active', true).neq('status', 'cancelled'),
    );

    const events = rows.map(toEventView);
    const upcoming = events.filter((e) => e.eventDate && e.eventDate >= today);
    const active = events.filter((e) => e.status === 'active');

    // The "days remaining" card tracks the soonest future event.
    const next = [...upcoming].sort((a, b) => (a.eventDate ?? '').localeCompare(b.eventDate ?? ''))[0] ?? null;

    let branchesSubmitted = 0;
    let branchesPending = 0;
    let nextReadiness = 0;

    if (next) {
      const participants = await getParticipatingBranchIds(next.id, next.appliesToAllBranches);
      const { data: demandRows, error: demandErr } = await supabaseAdmin
        .from(DEMANDS)
        .select('branch_id, status')
        .eq('event_id', next.id)
        .neq('status', 'draft');
      if (demandErr) throw demandErr;

      branchesSubmitted = (demandRows ?? []).length;
      branchesPending = Math.max(0, participants.length - branchesSubmitted);

      const stages = await getProductionStages(next.id);
      nextReadiness = readinessFromStages(stages as { completion_percentage: number }[]);
    }

    // Reminder counts are admin-only information; the other roles get zeros
    // rather than a leak of how many messages went to other branches.
    let notificationsSent = 0;
    let notificationsPending = 0;
    if (req.user!.role === 'super_admin' && events.length > 0) {
      const ids = events.map((e) => e.id);
      const { data: scheduleRows, error: schedErr } = await supabaseAdmin
        .from(SCHEDULE)
        .select('status')
        .in('event_id', ids);
      if (schedErr) throw schedErr;

      for (const row of (scheduleRows ?? []) as { status: string }[]) {
        if (row.status === 'sent') notificationsSent += 1;
        else if (row.status === 'pending') notificationsPending += 1;
      }
    }

    const summary: EventDashboardSummary = {
      upcomingEvents: upcoming.length,
      activeEvents: active.length,
      branchesSubmitted,
      branchesPending,
      notificationsSent,
      notificationsPending,
      nextEvent: next
        ? {
            id: next.id,
            name: next.name,
            eventDate: next.eventDate,
            daysRemaining: next.daysRemaining,
            readinessPercentage: nextReadiness,
          }
        : null,
    };

    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

// GET /api/special-events/notifications — the reminder schedule (admin screen).
router.get('/notifications', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from(SCHEDULE)
      .select('*')
      .order('scheduled_for', { ascending: true })
      .limit(500);

    if (req.query['eventId']) query = query.eq('event_id', req.query['eventId'] as string);
    if (req.query['status']) query = query.eq('status', req.query['status'] as string);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ notifications: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/special-events/notifications/dispatch — send every reminder due on or
 * before onDate.
 *
 * This is the delivery mechanism today, not a convenience: the cron schedulers
 * are commented out in server.ts, so without this button no reminder ever leaves.
 * A manual trigger deliberately bypasses eventNotificationsEnabled, exactly like
 * POST /api/closing-notifications/dispatch.
 */
router.post(
  '/notifications/dispatch',
  requireRole('super_admin'),
  validate(DispatchEventNotificationsSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { onDate, dryRun } = req.body as { onDate?: string; dryRun?: boolean };
      const result = await dispatchDueEventNotifications({
        trigger: 'manual',
        ...(onDate ? { onDate } : {}),
        ...(dryRun ? { dryRun } : {}),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/special-events/maintenance/refresh-estimates
// MUST be run once after migration 41 — the seeded catalogue ships with
// estimated_date NULL, so until this runs every seeded event has a null
// event_date and appears on no screen.
router.post(
  '/maintenance/refresh-estimates',
  requireRole('super_admin'),
  validate(RefreshEventEstimatesSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { year } = req.body as { year?: number };
      const result = await refreshEventEstimates(year ? { year } : undefined);

      // Dates moving means the reminder schedule is stale. Reconcile every event
      // that still has pending reminders rather than only the ones just updated —
      // a schedule generated before the first refresh has no dates at all.
      const { data: events, error } = await supabaseAdmin
        .from(EVENTS)
        .select('id')
        .eq('is_active', true)
        .not('event_date', 'is', null);
      if (error) throw error;

      for (const row of (events ?? []) as { id: string }[]) {
        await generateEventNotificationSchedule(row.id);
      }

      res.json({ ...result, schedulesRegenerated: (events ?? []).length });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/special-events/maintenance/roll-forward — create next year's occurrences.
router.post(
  '/maintenance/roll-forward',
  requireRole('super_admin'),
  validate(RollForwardEventsSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { targetYear } = req.body as { targetYear?: number };
      const result = await rollForwardRecurringEvents(targetYear ? { targetYear } : undefined);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/special-events/maintenance/refresh-statuses — advance upcoming → active → completed.
router.post('/maintenance/refresh-statuses', requireRole('super_admin'), async (_req, res, next) => {
  try {
    res.json(await refreshEventStatuses());
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/special-events/demands/:demandId/review — Production or Admin approves
 * or rejects a submitted demand.
 *
 * Declared before '/:id' because 'demands' would otherwise be read as an event id.
 */
router.put(
  '/demands/:demandId/review',
  requireRole('super_admin', 'production_user'),
  validate(ReviewEventDemandSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const demandId = req.params['demandId']!;
      const { status, approvedItems, remarks } = req.body as {
        status: 'approved' | 'rejected';
        approvedItems?: { productId: string; approvedQty: number }[];
        remarks?: string;
      };

      // Check-and-set on 'submitted': two reviewers hitting Approve at the same
      // moment must not both write approved quantities.
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from(DEMANDS)
        .update({
          status,
          reviewed_at: new Date().toISOString(),
          reviewed_by: req.user!.uid,
          reviewed_by_name: req.user!.email,
          review_remarks: remarks ?? null,
        })
        .eq('id', demandId)
        .eq('status', 'submitted')
        .select('id, event_id, branch_id, branch_name')
        .maybeSingle();
      if (claimErr) throw claimErr;

      if (!claimed) {
        // Either it does not exist or it is not awaiting review — tell those apart
        // so the UI can say something useful.
        const { data: existing } = await supabaseAdmin
          .from(DEMANDS)
          .select('id, status')
          .eq('id', demandId)
          .maybeSingle();
        if (!existing) {
          res.status(404).json({ error: 'Demand not found' });
        } else {
          res.status(409).json({ error: `Demand is ${(existing as { status: string }).status}, not awaiting review` });
        }
        return;
      }

      const demand = claimed as { id: string; event_id: string; branch_id: string; branch_name: string | null };

      // Approved quantities: an override where given, the requested quantity
      // otherwise. On rejection nothing is approved.
      const { data: itemRows, error: itemErr } = await supabaseAdmin
        .from(DEMAND_ITEMS)
        .select('id, product_id, qty')
        .eq('demand_id', demandId);
      if (itemErr) throw itemErr;

      const overrides = new Map((approvedItems ?? []).map((i) => [i.productId, i.approvedQty]));
      for (const item of (itemRows ?? []) as { id: string; product_id: string | null; qty: string }[]) {
        const approvedQty =
          status === 'rejected'
            ? 0
            : (item.product_id ? overrides.get(item.product_id) : undefined) ?? Number(item.qty);

        const { error } = await supabaseAdmin
          .from(DEMAND_ITEMS)
          .update({ approved_qty: approvedQty })
          .eq('id', item.id);
        if (error) throw error;
      }

      const { data: event } = await supabaseAdmin
        .from(EVENTS)
        .select('name')
        .eq('id', demand.event_id)
        .maybeSingle();
      const eventName = (event as { name: string } | null)?.name ?? 'the event';

      await notify({
        type: 'event_demand_reviewed',
        title: status === 'approved' ? 'Event Demand Approved' : 'Event Demand Rejected',
        message:
          status === 'approved'
            ? `Your advance demand for ${eventName} was approved.`
            : `Your advance demand for ${eventName} was rejected.${remarks ? ` Reason: ${remarks}` : ''}`,
        targetRole: 'branch_manager',
        branchId: demand.branch_id,
        relatedId: demand.event_id,
      });

      res.json({ success: true, status });
    } catch (err) {
      next(err);
    }
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Event CRUD
// ───────────────────────────────────────────────────────────────────────────

// POST /api/special-events
router.post('/', requireRole('super_admin'), validate(CreateSpecialEventSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown> & {
      name: string;
      category: string;
      eventYear: number;
      seriesCode?: string;
      branchIds: string[];
      appliesToAllBranches: boolean;
    };

    const resolved = resolveEventDates({
      calendarSystem: body['calendarSystem'] as never,
      eventYear: body.eventYear,
      hijriMonth: body['hijriMonth'] as number | null,
      hijriDay: body['hijriDay'] as number | null,
      gregorianMonth: body['gregorianMonth'] as number | null,
      gregorianDay: body['gregorianDay'] as number | null,
      nthWeekday: body['nthWeekday'] as number | null,
      weekday: body['weekday'] as number | null,
      anchorOffsetDays: body['anchorOffsetDays'] as number,
      isRecurring: body['isRecurring'] as boolean,
      confirmedDate: (body['confirmedDate'] as string | null) ?? null,
      demandLeadDays: body['demandLeadDays'] as number,
      demandDueDate: (body['demandDueDate'] as string | null) ?? null,
      preparationStartDate: (body['preparationStartDate'] as string | null) ?? null,
    });

    const seriesCode = body.seriesCode ?? deriveSeriesCode(body.name, body.category);

    const { data: created, error } = await supabaseAdmin
      .from(EVENTS)
      .insert({
        series_code: seriesCode,
        event_year: body.eventYear,
        name: body.name,
        description: (body['description'] as string) ?? null,
        category: body.category,
        event_type: (body['eventType'] as string) ?? null,
        calendar_system: body['calendarSystem'],
        hijri_month: body['hijriMonth'] ?? null,
        hijri_day: body['hijriDay'] ?? null,
        gregorian_month: body['gregorianMonth'] ?? null,
        gregorian_day: body['gregorianDay'] ?? null,
        nth_weekday: body['nthWeekday'] ?? null,
        weekday: body['weekday'] ?? null,
        anchor_offset_days: body['anchorOffsetDays'] ?? 0,
        is_recurring: body['isRecurring'],
        estimated_date: resolved.estimatedDate,
        confirmed_date: (body['confirmedDate'] as string | null) ?? null,
        duration_days: body['durationDays'],
        demand_due_date: resolved.demandDueDate,
        demand_lead_days: body['demandLeadDays'],
        reminder_lead_days: body['reminderLeadDays'],
        preparation_start_date: resolved.preparationStartDate,
        priority: body['priority'],
        applies_to_all_branches: body.appliesToAllBranches,
        color: (body['color'] as string | null) ?? null,
        notes: (body['notes'] as string) ?? null,
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('*')
      .single();
    if (error) {
      // 23505 on the series/year key is the one failure an admin can act on.
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: `An event already exists for ${seriesCode} in ${body.eventYear}` });
        return;
      }
      throw error;
    }

    const eventId = (created as { id: string }).id;

    if (!body.appliesToAllBranches && body.branchIds.length > 0) {
      await setEventBranches(eventId, body.branchIds);
    }

    // Generate the reminder schedule immediately, so the admin can see what will
    // be sent before anything has been.
    await generateEventNotificationSchedule(eventId);

    // A new recurring series has to be auto-detected into the other years too;
    // without this the year cache would hide it for up to a minute.
    if (body['isRecurring']) invalidate('specialEvents:year');

    // Announce the event so branches know to expect the reminders. branchId is
    // null: this is a broadcast to every branch manager, and the notifications
    // RLS would narrow a role broadcast carrying a branch_id to that one branch.
    await notify({
      type: 'event_created',
      title: `New Event: ${body.name}`,
      message: resolved.estimatedDate
        ? `${body.name} is scheduled. Advance demand is due by ${resolved.demandDueDate ?? 'a date to be announced'}.`
        : `${body.name} has been added to the events calendar.`,
      targetRole: 'branch_manager',
      branchId: null,
      relatedId: eventId,
    });

    res.status(201).json({ event: toEventView(created as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

/** Fields whose change invalidates the reminder schedule. */
const SCHEDULE_AFFECTING = new Set([
  'calendarSystem',
  'eventYear',
  'hijriMonth',
  'hijriDay',
  'gregorianMonth',
  'gregorianDay',
  'nthWeekday',
  'weekday',
  'anchorOffsetDays',
  'confirmedDate',
  'durationDays',
  'demandLeadDays',
  'reminderLeadDays',
  'demandDueDate',
  'name',
  'appliesToAllBranches',
  'branchIds',
]);

// PUT /api/special-events/:id
router.put('/:id', requireRole('super_admin'), validate(UpdateSpecialEventSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const body = req.body as Record<string, unknown>;

    const { data: current, error: curErr } = await supabaseAdmin
      .from(EVENTS)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const existing = rowToApi<Record<string, unknown>>(current);
    const merged = { ...existing, ...body };

    const resolved = resolveEventDates({
      calendarSystem: merged['calendarSystem'] as never,
      eventYear: merged['eventYear'] as number,
      hijriMonth: merged['hijriMonth'] as number | null,
      hijriDay: merged['hijriDay'] as number | null,
      gregorianMonth: merged['gregorianMonth'] as number | null,
      gregorianDay: merged['gregorianDay'] as number | null,
      nthWeekday: merged['nthWeekday'] as number | null,
      weekday: merged['weekday'] as number | null,
      anchorOffsetDays: merged['anchorOffsetDays'] as number,
      isRecurring: merged['isRecurring'] as boolean,
      confirmedDate: (merged['confirmedDate'] as string | null) ?? null,
      demandLeadDays: merged['demandLeadDays'] as number,
      // An explicit deadline in THIS payload is honoured; otherwise it is
      // recomputed, so moving the event moves the deadline with it.
      demandDueDate: (body['demandDueDate'] as string | null) ?? null,
      preparationStartDate: (body['preparationStartDate'] as string | null) ?? null,
    });

    const update: Record<string, unknown> = {
      name: merged['name'],
      description: merged['description'] ?? null,
      category: merged['category'],
      event_type: merged['eventType'] ?? null,
      calendar_system: merged['calendarSystem'],
      hijri_month: merged['hijriMonth'] ?? null,
      hijri_day: merged['hijriDay'] ?? null,
      gregorian_month: merged['gregorianMonth'] ?? null,
      gregorian_day: merged['gregorianDay'] ?? null,
      nth_weekday: merged['nthWeekday'] ?? null,
      weekday: merged['weekday'] ?? null,
      anchor_offset_days: merged['anchorOffsetDays'] ?? 0,
      is_recurring: merged['isRecurring'],
      estimated_date: resolved.estimatedDate,
      confirmed_date: merged['confirmedDate'] ?? null,
      duration_days: merged['durationDays'],
      demand_due_date: resolved.demandDueDate,
      demand_lead_days: merged['demandLeadDays'],
      reminder_lead_days: merged['reminderLeadDays'],
      preparation_start_date: resolved.preparationStartDate,
      priority: merged['priority'],
      applies_to_all_branches: merged['appliesToAllBranches'],
      color: merged['color'] ?? null,
      notes: merged['notes'] ?? null,
      event_year: merged['eventYear'],
    };

    const { data: updated, error } = await supabaseAdmin
      .from(EVENTS)
      .update(update)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;

    if (Array.isArray(body['branchIds'])) {
      await setEventBranches(id, body['branchIds'] as string[]);
    }

    // Reconcile only when something the schedule depends on actually moved —
    // editing `notes` should not touch reminders.
    if (Object.keys(body).some((k) => SCHEDULE_AFFECTING.has(k))) {
      await generateEventNotificationSchedule(id);
    }

    res.json({ event: toEventView(updated as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/special-events/:id/confirm-date — the moon-sighting override.
 *
 * Passing null clears the confirmation and hands the date back to the estimate.
 * Either way the schedule is reconciled: pending reminders move, already-sent
 * ones are untouched, and any whose new date is now past become 'skipped' rather
 * than firing in a burst.
 */
router.patch(
  '/:id/confirm-date',
  requireRole('super_admin'),
  validate(ConfirmEventDateSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = req.params['id']!;
      const { confirmedDate } = req.body as { confirmedDate: string | null };

      const { data: current, error: curErr } = await supabaseAdmin
        .from(EVENTS)
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (curErr) throw curErr;
      if (!current) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }

      const existing = rowToApi<Record<string, unknown>>(current);
      const resolved = resolveEventDates({
        calendarSystem: existing['calendarSystem'] as never,
        eventYear: existing['eventYear'] as number,
        hijriMonth: existing['hijriMonth'] as number | null,
        hijriDay: existing['hijriDay'] as number | null,
        gregorianMonth: existing['gregorianMonth'] as number | null,
        gregorianDay: existing['gregorianDay'] as number | null,
        nthWeekday: existing['nthWeekday'] as number | null,
        weekday: existing['weekday'] as number | null,
        anchorOffsetDays: existing['anchorOffsetDays'] as number,
        isRecurring: existing['isRecurring'] as boolean,
        confirmedDate,
        demandLeadDays: existing['demandLeadDays'] as number,
      });

      const { data: updated, error } = await supabaseAdmin
        .from(EVENTS)
        .update({
          confirmed_date: confirmedDate,
          estimated_date: resolved.estimatedDate,
          demand_due_date: resolved.demandDueDate,
          preparation_start_date: resolved.preparationStartDate,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;

      await generateEventNotificationSchedule(id);

      res.json({ event: toEventView(updated as Record<string, unknown>) });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/special-events/:id/status
router.patch(
  '/:id/status',
  requireRole('super_admin'),
  validate(UpdateEventStatusSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = req.params['id']!;
      const { status } = req.body as { status: string };

      const { data, error } = await supabaseAdmin
        .from(EVENTS)
        .update({ status })
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }

      // Cancelling must stop the reminders — otherwise branches keep being asked
      // to submit demand for something that is not happening.
      if (status === 'cancelled') await cancelEventNotifications(id);

      res.json({ event: toEventView(data as Record<string, unknown>) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/special-events/:id — SOFT delete.
 *
 * Never a hard delete: demands and the reminder history hang off this row, and a
 * past event is the comparison baseline for next year's occurrence.
 */
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;

    const { data, error } = await supabaseAdmin
      .from(EVENTS)
      .update({ is_active: false })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const cancelled = await cancelEventNotifications(id);
    res.json({ success: true, remindersCancelled: cancelled });
  } catch (err) {
    next(err);
  }
});

// PUT /api/special-events/:id/branches — replace the participation list.
router.put(
  '/:id/branches',
  requireRole('super_admin'),
  validate(AssignEventBranchesSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = req.params['id']!;
      const { appliesToAllBranches, branchIds } = req.body as {
        appliesToAllBranches: boolean;
        branchIds: string[];
      };

      const { data, error } = await supabaseAdmin
        .from(EVENTS)
        .update({ applies_to_all_branches: appliesToAllBranches })
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }

      await setEventBranches(id, appliesToAllBranches ? [] : branchIds);
      // Adding or removing a branch adds or cancels that branch's reminders.
      const schedule = await generateEventNotificationSchedule(id);

      res.json({ success: true, schedule });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/special-events/:id/notifications/regenerate
router.post(
  '/:id/notifications/regenerate',
  requireRole('super_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      res.json(await generateEventNotificationSchedule(req.params['id']!));
    } catch (err) {
      next(err);
    }
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Demands
// ───────────────────────────────────────────────────────────────────────────

// GET /api/special-events/:id/demands — every branch's demand for one event.
router.get('/:id/demands', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from(DEMANDS)
      .select(DEMAND_SELECT)
      .eq('event_id', req.params['id']!)
      .order('branch_name', { ascending: true })
      .order('line_no', DEMAND_ITEMS_ORDER);
    if (error) throw error;

    res.json({ demands: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/special-events/:id/demands/consolidated — product-wise roll-up across
 * every branch. This is what Production plans against.
 *
 * Aggregated in TypeScript after one indexed read rather than in a Postgres
 * function: the repo's bar for an RPC is cross-statement atomicity, and this is a
 * read-only aggregation.
 */
router.get(
  '/:id/demands/consolidated',
  requireRole('super_admin', 'production_user'),
  async (req: AuthRequest, res, next) => {
    try {
      const eventId = req.params['id']!;

      const { data: demandRows, error: demandErr } = await supabaseAdmin
        .from(DEMANDS)
        .select('id, branch_id, status')
        .eq('event_id', eventId)
        .neq('status', 'draft');
      if (demandErr) throw demandErr;

      const demands = (demandRows ?? []) as { id: string; branch_id: string; status: string }[];
      if (demands.length === 0) {
        res.json({ rows: [], branchesIncluded: 0 });
        return;
      }

      const { data: itemRows, error: itemErr } = await supabaseAdmin
        .from(DEMAND_ITEMS)
        .select('demand_id, product_id, product_name, qty, approved_qty, unit_price')
        .in('demand_id', demands.map((d) => d.id));
      if (itemErr) throw itemErr;

      const branchByDemand = new Map(demands.map((d) => [d.id, d.branch_id]));
      const byProduct = new Map<string, ConsolidatedDemandRow & { branches: Set<string> }>();

      for (const item of (itemRows ?? []) as {
        demand_id: string;
        product_id: string | null;
        product_name: string;
        qty: string;
        approved_qty: string | null;
        unit_price: string | null;
      }[]) {
        // Group by product_id, falling back to the snapshot name for lines whose
        // product was deleted (product_id is ON DELETE SET NULL).
        const key = item.product_id ?? `name:${item.product_name}`;
        const entry =
          byProduct.get(key) ??
          ({
            productId: item.product_id,
            productName: item.product_name,
            requestedQty: 0,
            approvedQty: 0,
            branchCount: 0,
            estimatedValue: 0,
            branches: new Set<string>(),
          } as ConsolidatedDemandRow & { branches: Set<string> });

        const qty = Number(item.qty);
        const approved = item.approved_qty === null ? 0 : Number(item.approved_qty);
        entry.requestedQty += qty;
        entry.approvedQty += approved;
        entry.estimatedValue += (approved || qty) * Number(item.unit_price ?? 0);

        const branchId = branchByDemand.get(item.demand_id);
        if (branchId) entry.branches.add(branchId);

        byProduct.set(key, entry);
      }

      const rows: ConsolidatedDemandRow[] = [...byProduct.values()]
        .map(({ branches, ...rest }) => ({ ...rest, branchCount: branches.size }))
        .sort((a, b) => b.requestedQty - a.requestedQty);

      res.json({ rows, branchesIncluded: new Set(demands.map((d) => d.branch_id)).size });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/special-events/:id/my-demand — the caller's own branch demand.
router.get('/:id/my-demand', requireRole(...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const eventId = req.params['id']!;
    const branchId = req.user!.branchId;
    await assertBranchMayAccessEvent(eventId, branchId);

    const { data, error } = await supabaseAdmin
      .from(DEMANDS)
      .select(DEMAND_SELECT)
      .eq('event_id', eventId)
      // From the JWT, never the query string.
      .eq('branch_id', branchId!)
      .order('line_no', DEMAND_ITEMS_ORDER)
      .maybeSingle();
    if (error) throw error;

    res.json({ demand: data ? rowToApi(data) : null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/special-events/:id/demands — save (create or replace) the caller's
 * own branch demand as a draft.
 *
 * branchId comes from req.user, never the body — the load-bearing rule for every
 * branch-scoped write, since the service-role client bypasses RLS.
 */
router.post(
  '/:id/demands',
  requireRole(...BRANCH_ROLES),
  validate(SaveEventDemandSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const eventId = req.params['id']!;
      const branchId = req.user!.branchId;
      await assertBranchMayAccessEvent(eventId, branchId);

      const { items, expectedCustomers, notes } = req.body as {
        items: { productId: string; qty: number; remarks?: string }[];
        expectedCustomers?: number | null;
        notes?: string;
      };

      const { data: event, error: eventErr } = await supabaseAdmin
        .from(EVENTS)
        .select('id, name, demand_due_date, status')
        .eq('id', eventId)
        .single();
      if (eventErr) throw eventErr;

      const eventRow = event as { name: string; demand_due_date: string | null; status: string };
      if (eventRow.status === 'cancelled') {
        res.status(409).json({ error: 'This event has been cancelled' });
        return;
      }
      if (eventRow.demand_due_date && businessDateStr() > eventRow.demand_due_date) {
        res.status(409).json({
          error: `The demand deadline for ${eventRow.name} passed on ${eventRow.demand_due_date}. Contact Admin to submit late.`,
        });
        return;
      }

      // Names and prices are resolved server-side. Branch users never send them —
      // they are Admin-controlled, and the price is snapshotted here so later
      // repricing does not rewrite this demand's value.
      const productIds = [...new Set(items.map((i) => i.productId))];
      const { data: products, error: prodErr } = await supabaseAdmin
        .from('products')
        .select('id, name, price')
        .eq('is_active', true)
        .in('id', productIds);
      if (prodErr) throw prodErr;

      const productById = new Map(
        (products ?? []).map((p) => [
          (p as { id: string }).id,
          p as { id: string; name: string; price: string | null },
        ]),
      );

      const resolvedItems = items.map((item) => {
        const product = productById.get(item.productId);
        if (!product) {
          throw Object.assign(
            new Error('One of the selected products is no longer available. Please refresh and try again.'),
            { status: 400 },
          );
        }
        return {
          productId: item.productId,
          productName: product.name,
          qty: item.qty,
          unitPrice: product.price === null ? null : Number(product.price),
          remarks: item.remarks ?? null,
        };
      });

      const { data: existing, error: exErr } = await supabaseAdmin
        .from(DEMANDS)
        .select('id, status')
        .eq('event_id', eventId)
        .eq('branch_id', branchId!)
        .maybeSingle();
      if (exErr) throw exErr;

      let demandId: string;

      if (existing) {
        const row = existing as { id: string; status: string };
        // Once submitted, the branch cannot silently rewrite what Production is
        // planning against.
        if (row.status !== 'draft') {
          res.status(409).json({ error: `This demand is already ${row.status} and can no longer be edited` });
          return;
        }
        demandId = row.id;

        const { error } = await supabaseAdmin
          .from(DEMANDS)
          .update({
            expected_customers: expectedCustomers ?? null,
            notes: notes ?? null,
          })
          .eq('id', demandId);
        if (error) throw error;

        // Replace the lines wholesale — the client sends the full basket.
        const { error: delErr } = await supabaseAdmin.from(DEMAND_ITEMS).delete().eq('demand_id', demandId);
        if (delErr) throw delErr;
      } else {
        const { data: created, error } = await supabaseAdmin
          .from(DEMANDS)
          .insert({
            event_id: eventId,
            branch_id: branchId,
            branch_name: req.user!.branchName || '',
            status: 'draft',
            expected_customers: expectedCustomers ?? null,
            notes: notes ?? null,
          })
          .select('id')
          .single();
        if (error) throw error;
        demandId = (created as { id: string }).id;
      }

      const { error: itemsErr } = await supabaseAdmin.from(DEMAND_ITEMS).insert(
        resolvedItems.map((item, idx) => ({
          demand_id: demandId,
          product_id: item.productId,
          product_name: item.productName,
          qty: item.qty,
          unit_price: item.unitPrice,
          remarks: item.remarks,
          line_no: idx + 1,
        })),
      );
      if (itemsErr) throw itemsErr;

      res.status(existing ? 200 : 201).json({ id: demandId, status: 'draft' });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/special-events/:id/demands/:demandId/submit
router.post('/:id/demands/:demandId/submit', requireRole(...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const eventId = req.params['id']!;
    const demandId = req.params['demandId']!;
    const branchId = req.user!.branchId;
    await assertBranchMayAccessEvent(eventId, branchId);

    // Check-and-set on 'draft', scoped to the caller's own branch. Both predicates
    // matter: the status stops a double-submit, the branch_id stops a branch
    // manager submitting another branch's demand by guessing an id.
    const { data, error } = await supabaseAdmin
      .from(DEMANDS)
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        submitted_by: req.user!.uid,
        submitted_by_name: req.user!.email,
      })
      .eq('id', demandId)
      .eq('event_id', eventId)
      .eq('branch_id', branchId!)
      .eq('status', 'draft')
      .select('id')
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      res.status(409).json({ error: 'This demand is not a draft, or does not belong to your branch' });
      return;
    }

    const { count } = await supabaseAdmin
      .from(DEMAND_ITEMS)
      .select('id', { count: 'exact', head: true })
      .eq('demand_id', demandId);

    const { data: event } = await supabaseAdmin.from(EVENTS).select('name').eq('id', eventId).maybeSingle();
    const eventName = (event as { name: string } | null)?.name ?? 'an event';

    // branchId null: production users are a central role with no branch claim, so
    // a branch-scoped broadcast would be filtered out for all of them.
    await notify({
      type: 'event_demand_submitted',
      title: 'Event Demand Submitted',
      message: `${req.user!.branchName || 'A branch'} submitted ${count ?? 0} item(s) of advance demand for ${eventName}.`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: eventId,
    });

    res.json({ success: true, status: 'submitted' });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Production readiness
// ───────────────────────────────────────────────────────────────────────────

// GET /api/special-events/:id/production-status
router.get('/:id/production-status', async (req: AuthRequest, res, next) => {
  try {
    const eventId = req.params['id']!;
    if (isBranchRole(req.user!.role)) {
      await assertBranchMayAccessEvent(eventId, req.user!.branchId);
    }

    const stages = await getProductionStages(eventId);
    res.json({
      stages: rowToApi(stages),
      readinessPercentage: readinessFromStages(stages as { completion_percentage: number }[]),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/special-events/:id/production-status/:stage
router.put(
  '/:id/production-status/:stage',
  requireRole('super_admin', 'production_user'),
  validate(UpdateEventStageSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const eventId = req.params['id']!;
      const stage = req.params['stage'] as EventProductionStage;
      const { completionPercentage, remarks } = req.body as {
        completionPercentage: number;
        remarks?: string;
      };

      if (!EVENT_STAGES.includes(stage)) {
        res.status(400).json({ error: `Unknown stage "${stage}"` });
        return;
      }

      const { data: current, error: curErr } = await supabaseAdmin
        .from(PRODUCTION_STATUS)
        .select('id, started_at, completed_at')
        .eq('event_id', eventId)
        .eq('stage', stage)
        .maybeSingle();
      if (curErr) throw curErr;
      if (!current) {
        res.status(404).json({ error: 'Event or stage not found' });
        return;
      }

      const row = current as { id: string; started_at: string | null; completed_at: string | null };
      const now = new Date().toISOString();

      const { error } = await supabaseAdmin
        .from(PRODUCTION_STATUS)
        .update({
          completion_percentage: completionPercentage,
          remarks: remarks ?? null,
          // Stamped once on the first movement off zero, and once on reaching
          // 100. Dropping back below 100 clears the completion stamp so the
          // timeline does not claim a stage finished that has since reopened.
          started_at: row.started_at ?? (completionPercentage > 0 ? now : null),
          completed_at: completionPercentage === 100 ? (row.completed_at ?? now) : null,
          updated_by: req.user!.uid,
          updated_by_name: req.user!.email,
        })
        .eq('id', row.id);
      if (error) throw error;

      const stages = await getProductionStages(eventId);
      const readiness = readinessFromStages(stages as { completion_percentage: number }[]);

      const { data: event } = await supabaseAdmin.from(EVENTS).select('name').eq('id', eventId).maybeSingle();

      await notify({
        type: 'event_production_updated',
        title: 'Event Preparation Updated',
        message: `${(event as { name: string } | null)?.name ?? 'An event'} is now ${readiness}% ready.`,
        targetRole: 'super_admin',
        branchId: null,
        relatedId: eventId,
      });

      res.json({ stages: rowToApi(stages), readinessPercentage: readiness });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/special-events/:id — must stay last; every literal path above would
// otherwise be captured by this route's parameter.
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;

    const { data, error } = await supabaseAdmin.from(EVENTS).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const row = data as Record<string, unknown>;
    if (isBranchRole(req.user!.role)) {
      await assertBranchMayAccessEvent(id, req.user!.branchId);
    }

    const view = toEventView(row);
    const branchIds = await getEventBranchIds(id, view.appliesToAllBranches);
    const stages = await getProductionStages(id);
    const [decorated] = await decorateEvents([view]);

    const today = businessDateStr();
    res.json({
      event: {
        ...(decorated ?? view),
        branchIds: branchIds ?? [],
        readinessPercentage: readinessFromStages(stages as { completion_percentage: number }[]),
        daysRemaining: view.eventDate ? daysBetweenDateStr(today, view.eventDate) : null,
      },
      stages: rowToApi(stages),
    });
  } catch (err) {
    next(err);
  }
});
