// Special Events — advance planning for high-demand occasions (migration 41).
//
// Every union below mirrors a Postgres enum. The enum is the authority: a value
// missing there fails the insert with a raw 22P02, exactly as documented for
// notification_type.
//
// One row per OCCURRENCE, not per template. Occurrences of a recurring event
// share `seriesCode` and are unique on (seriesCode, eventYear) — which is what
// lets "the same event, last year" be a single indexed lookup instead of a
// destroyed history.

export type EventCategory =
  | 'islamic'
  | 'ahlul_bayt'
  | 'national'
  | 'international'
  | 'company';

/**
 * How the event's date is anchored.
 *   gregorian             → a fixed month/day ("14 August")
 *   hijri                 → a Hijri month/day, resolved per year ("1 Shawwal")
 *   gregorian_nth_weekday → "2nd Sunday of May"
 *   hijri_last_weekday    → "the last Friday of Ramadan"
 */
export type EventCalendarSystem =
  | 'gregorian'
  | 'hijri'
  | 'gregorian_nth_weekday'
  /** "The last Friday of Ramadan" — Jumuat-ul-Wida. Needs the month's real length. */
  | 'hijri_last_weekday';

export type EventStatus = 'upcoming' | 'active' | 'completed' | 'cancelled';

/** Expected demand level. `critical` is the spec's "Very High". */
export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export type EventDemandStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'fulfilled';

/**
 * The four manual preparation stages. Manual on purpose: there is no
 * raw_materials table and no BOM in this schema, so nothing can derive them.
 */
export type EventProductionStage =
  | 'raw_materials'
  | 'packing_materials'
  | 'finished_products'
  | 'staff_assigned';

export type EventNotificationAudience = 'branch' | 'production' | 'admin';

export type EventReminderKind = 'event_countdown' | 'demand_due' | 'preparation_start';

export type EventNotificationStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Display labels. Kept beside the unions so a new enum value is obvious here too. */
export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  islamic: 'Islamic',
  ahlul_bayt: 'Ahlul Bayt (A.S.)',
  national: 'National',
  international: 'International',
  company: 'Company',
};

export const EVENT_PRIORITY_LABELS: Record<EventPriority, string> = {
  low: 'Low',
  normal: 'Medium',
  high: 'High',
  critical: 'Very High',
};

export const EVENT_STAGE_LABELS: Record<EventProductionStage, string> = {
  raw_materials: 'Raw Materials',
  packing_materials: 'Packing Materials',
  finished_products: 'Finished Products',
  staff_assigned: 'Staff Assigned',
};

/** Stage display order — enum_range order, so the UI matches the seeded rows. */
export const EVENT_STAGES: readonly EventProductionStage[] = [
  'raw_materials',
  'packing_materials',
  'finished_products',
  'staff_assigned',
];

/**
 * The standard reminder nudges, in days before the event.
 *
 * These are no longer the whole schedule — each event carries its own
 * `reminderLeadDays` (Eid-ul-Adha needs 30 days of notice, Ashura needs 7), and
 * these are the follow-ups that fall inside it. See the two functions below,
 * which are what the server and the UI both use.
 */
export const BRANCH_REMINDER_OFFSETS = [14, 7, 3] as const;
export const PRODUCTION_REMINDER_OFFSETS = [21, 14, 7, 3] as const;
export const DEMAND_DUE_REMINDER_OFFSETS = [1] as const;

/**
 * Production gets this much head start over the branches: it commits to raw
 * materials, packaging and staffing before branch demand has even arrived.
 */
export const PRODUCTION_HEAD_START_DAYS = 7;

/**
 * Branch reminder offsets for one event, newest lead first.
 *
 * The event's own lead time opens the sequence, then the standard nudges that
 * still fall inside it. Eid-ul-Adha (30) → 30, 14, 7, 3. Ashura (7) → 7, 3.
 * Filtering rather than appending is what stops a 7-day event from scheduling a
 * "14 days before" reminder that would have to fire in the past.
 */
export function branchReminderOffsets(reminderLeadDays: number): number[] {
  const lead = Math.max(1, Math.round(reminderLeadDays));
  return [...new Set([lead, ...BRANCH_REMINDER_OFFSETS.filter((o) => o < lead)])].sort(
    (a, b) => b - a,
  );
}

/** As above, plus PRODUCTION_HEAD_START_DAYS on the opening reminder. */
export function productionReminderOffsets(reminderLeadDays: number): number[] {
  const lead = Math.max(1, Math.round(reminderLeadDays)) + PRODUCTION_HEAD_START_DAYS;
  return [...new Set([lead, ...PRODUCTION_REMINDER_OFFSETS.filter((o) => o < lead)])].sort(
    (a, b) => b - a,
  );
}

export interface SpecialEvent {
  id: string;
  eventNumber: string; // EVT-000001 …
  seriesCode: string;
  eventYear: number;
  /**
   * Which occurrence within `eventYear` this is — almost always 1.
   *
   * A Hijri year is ~354 days, so a Hijri anniversary can fall TWICE in one
   * Gregorian year (15 Sha'ban lands on both 2028-01-12 and 2028-12-31) or skip
   * it entirely. Both occurrences are real events the bakery has to bake for, so
   * each gets its own row (migration 43).
   */
  occurrenceIndex: number;
  name: string;
  description: string | null;
  category: EventCategory;
  eventType: string | null;
  calendarSystem: EventCalendarSystem;

  hijriMonth: number | null;
  hijriDay: number | null;
  gregorianMonth: number | null;
  gregorianDay: number | null;
  nthWeekday: number | null;
  weekday: number | null;
  /**
   * Days added to the resolved anchor. Black Friday is the 4th Thursday of
   * November + 1; Cyber Monday is + 4. Zero for everything else.
   */
  anchorOffsetDays: number;

  isRecurring: boolean;

  /** Machine-computed from the anchor. Refreshable; never overrides a confirmation. */
  estimatedDate: string | null; // 'YYYY-MM-DD'
  /** Admin override. Always wins. */
  confirmedDate: string | null;
  durationDays: number;
  /** Generated column: coalesce(confirmedDate, estimatedDate). Null until resolved. */
  eventDate: string | null;
  /** Generated column: eventDate + durationDays - 1. */
  eventEndDate: string | null;

  demandDueDate: string | null;
  demandLeadDays: number;
  /**
   * How far ahead this event needs warning — 30 for Eid-ul-Adha, 7 for Ashura.
   * Drives the first reminder for both branches and Production.
   */
  reminderLeadDays: number;
  preparationStartDate: string | null;

  status: EventStatus;
  priority: EventPriority;
  appliesToAllBranches: boolean;
  color: string | null;
  notes: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the API actually returns: the row plus fields derived on read.
 *
 * `dateIsEstimated` exists so the UI can mark a date as subject to moon sighting
 * without re-deriving the rule (`confirmedDate === null`) in five components.
 */
export interface SpecialEventView extends SpecialEvent {
  dateIsEstimated: boolean;
  /** Days until eventDate; negative once past, null when the date is unresolved. */
  daysRemaining: number | null;
  /** Hijri label for eventDate, e.g. "1 Shawwal 1447 AH". Null when unresolved. */
  hijriLabel: string | null;
  /** Branch ids when appliesToAllBranches is false; empty otherwise. */
  branchIds?: string[];
  /** Mean of the four stage percentages, 0–100. */
  readinessPercentage?: number;
  demandSummary?: EventDemandSummary;
}

/** Branch participation roll-up for one event. */
export interface EventDemandSummary {
  totalBranches: number;
  submittedBranches: number;
  pendingBranches: number;
  draftBranches: number;
  totalItems: number;
  totalQty: number;
}

export interface EventBranchDemandItem {
  id: string;
  demandId: string;
  productId: string | null;
  productName: string;
  qty: number;
  /** Null until reviewed — same convention as production_order_items. */
  approvedQty: number | null;
  preparedQty: number;
  unitPrice: number | null;
  remarks: string | null;
  lineNo: number;
}

export interface EventBranchDemand {
  id: string;
  eventId: string;
  branchId: string;
  branchName: string | null;
  status: EventDemandStatus;
  expectedCustomers: number | null;
  notes: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  submittedByName: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  items: EventBranchDemandItem[];
}

/** One line of the consolidated, product-wise view Production plans against. */
export interface ConsolidatedDemandRow {
  productId: string | null;
  productName: string;
  requestedQty: number;
  approvedQty: number;
  /** Number of branches that asked for this product. */
  branchCount: number;
  estimatedValue: number;
}

export interface EventProductionStatusRow {
  id: string;
  eventId: string;
  stage: EventProductionStage;
  completionPercentage: number;
  remarks: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventNotificationRow {
  id: string;
  eventId: string;
  audience: EventNotificationAudience;
  branchId: string | null;
  reminderKind: EventReminderKind;
  offsetDays: number;
  scheduledFor: string; // 'YYYY-MM-DD'
  title: string;
  message: string;
  status: EventNotificationStatus;
  inAppNotificationId: string | null;
  attempts: number;
  claimedAt: string | null;
  sentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `generateEventNotificationSchedule` reports back. */
export interface EventScheduleResult {
  created: number;
  updated: number;
  removed: number;
  skippedPast: number;
}

/** What a dispatch run reports back. Never throws; failures are counted here. */
export interface EventDispatchResult {
  onDate: string;
  dispatched: number;
  sent: number;
  failed: number;
  messagesSent: number;
  messagesFailed: number;
  skipped?: string;
}

/** Role-shaped counts behind the dashboard cards. */
export interface EventDashboardSummary {
  upcomingEvents: number;
  activeEvents: number;
  branchesSubmitted: number;
  branchesPending: number;
  notificationsSent: number;
  notificationsPending: number;
  /** The soonest unresolved-or-future event, for the "days remaining" card. */
  nextEvent: {
    id: string;
    name: string;
    eventDate: string | null;
    daysRemaining: number | null;
    readinessPercentage: number;
  } | null;
}
