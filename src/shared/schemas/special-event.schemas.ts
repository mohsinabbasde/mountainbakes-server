import { z } from 'zod';

// Validation for the Special Events module (migration 41).
//
// The anchor rule is enforced here as well as by special_events_anchor_ck, for
// the same reason notify() pre-checks notifications_target_present: a check
// constraint surfaces as a raw 23514 with no field to attach it to, and the admin
// filling in the form deserves "Hijri month is required" on the right input.

const DATE_STR = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format');

export const EVENT_CATEGORY_VALUES = [
  'islamic',
  'ahlul_bayt',
  'national',
  'international',
  'company',
] as const;
export const EVENT_CALENDAR_SYSTEM_VALUES = [
  'gregorian',
  'hijri',
  'gregorian_nth_weekday',
  'hijri_last_weekday',
] as const;
export const EVENT_STATUS_VALUES = ['upcoming', 'active', 'completed', 'cancelled'] as const;
export const EVENT_PRIORITY_VALUES = ['low', 'normal', 'high', 'critical'] as const;
export const EVENT_STAGE_VALUES = [
  'raw_materials',
  'packing_materials',
  'finished_products',
  'staff_assigned',
] as const;

const eventBase = {
  name: z.string().min(2, 'Event name is required').max(120),
  description: z.string().max(1000).optional(),
  category: z.enum(EVENT_CATEGORY_VALUES),
  eventType: z.string().max(60).optional(),
  calendarSystem: z.enum(EVENT_CALENDAR_SYSTEM_VALUES),

  hijriMonth: z.number().int().min(1).max(12).nullable().optional(),
  hijriDay: z.number().int().min(1).max(30).nullable().optional(),
  gregorianMonth: z.number().int().min(1).max(12).nullable().optional(),
  gregorianDay: z.number().int().min(1).max(31).nullable().optional(),
  nthWeekday: z.number().int().min(1).max(5).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),

  /** Black Friday = 4th Thursday of November + 1. Zero for everything else. */
  anchorOffsetDays: z.number().int().min(-30).max(30).default(0),

  isRecurring: z.boolean().default(true),
  /** Admin override. Setting this makes the computed estimate irrelevant. */
  confirmedDate: DATE_STR.nullable().optional(),
  durationDays: z.number().int().min(1).max(60).default(1),
  demandLeadDays: z.number().int().min(0).max(120).default(10),
  /** How far ahead this event needs warning. Drives the first reminder. */
  reminderLeadDays: z.number().int().min(1).max(120).default(14),
  /** Explicit override; otherwise derived as eventDate - demandLeadDays. */
  demandDueDate: DATE_STR.nullable().optional(),
  preparationStartDate: DATE_STR.nullable().optional(),

  priority: z.enum(EVENT_PRIORITY_VALUES).default('normal'),
  appliesToAllBranches: z.boolean().default(true),
  branchIds: z.array(z.string().uuid()).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like #F97316')
    .nullable()
    .optional(),
  notes: z.string().max(1000).optional(),
};

/**
 * Mirrors special_events_anchor_ck. A one-off event (isRecurring false) needs no
 * anchor as long as the admin gave a concrete date; everything else needs the
 * anchor fields its calendar system resolves from.
 */
function checkAnchor(
  val: {
    calendarSystem?: string;
    isRecurring?: boolean;
    confirmedDate?: string | null;
    hijriMonth?: number | null;
    hijriDay?: number | null;
    gregorianMonth?: number | null;
    gregorianDay?: number | null;
    nthWeekday?: number | null;
    weekday?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (val.isRecurring === false && val.confirmedDate) return;

  const require = (field: string, value: unknown, message: string) => {
    if (value === null || value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  };

  if (val.calendarSystem === 'hijri') {
    require('hijriMonth', val.hijriMonth, 'Hijri month is required for a Hijri event');
    require('hijriDay', val.hijriDay, 'Hijri day is required for a Hijri event');
  } else if (val.calendarSystem === 'gregorian') {
    require('gregorianMonth', val.gregorianMonth, 'Month is required');
    require('gregorianDay', val.gregorianDay, 'Day is required');
  } else if (val.calendarSystem === 'gregorian_nth_weekday') {
    require('gregorianMonth', val.gregorianMonth, 'Month is required');
    require('nthWeekday', val.nthWeekday, 'Which occurrence (1st–5th) is required');
    require('weekday', val.weekday, 'Weekday is required');
  } else if (val.calendarSystem === 'hijri_last_weekday') {
    // "The last Friday of Ramadan" — a Hijri month and a weekday, no day number.
    require('hijriMonth', val.hijriMonth, 'Hijri month is required');
    require('weekday', val.weekday, 'Weekday is required');
  }
}

export const CreateSpecialEventSchema = z
  .object({
    ...eventBase,
    /** Gregorian year this occurrence lands in. Unique with seriesCode. */
    eventYear: z.number().int().min(2000).max(2200),
    /**
     * Optional on create — the server derives one from the name when absent.
     * Supplied explicitly only when adding a new year to an existing series.
     */
    seriesCode: z.string().min(2).max(60).optional(),
  })
  .superRefine(checkAnchor);

export const UpdateSpecialEventSchema = z
  .object({
    name: eventBase.name.optional(),
    description: eventBase.description,
    category: eventBase.category.optional(),
    eventType: eventBase.eventType,
    calendarSystem: eventBase.calendarSystem.optional(),
    hijriMonth: eventBase.hijriMonth,
    hijriDay: eventBase.hijriDay,
    gregorianMonth: eventBase.gregorianMonth,
    gregorianDay: eventBase.gregorianDay,
    nthWeekday: eventBase.nthWeekday,
    weekday: eventBase.weekday,
    anchorOffsetDays: z.number().int().min(-30).max(30).optional(),
    isRecurring: z.boolean().optional(),
    confirmedDate: eventBase.confirmedDate,
    durationDays: z.number().int().min(1).max(60).optional(),
    demandLeadDays: z.number().int().min(0).max(120).optional(),
    reminderLeadDays: z.number().int().min(1).max(120).optional(),
    demandDueDate: eventBase.demandDueDate,
    preparationStartDate: eventBase.preparationStartDate,
    priority: z.enum(EVENT_PRIORITY_VALUES).optional(),
    appliesToAllBranches: z.boolean().optional(),
    branchIds: z.array(z.string().uuid()).optional(),
    color: eventBase.color,
    notes: eventBase.notes,
    eventYear: z.number().int().min(2000).max(2200).optional(),
  })
  // Only validated when the calendar system is part of the payload — a partial
  // update that touches nothing but `notes` must not demand the anchor fields.
  .superRefine((val, ctx) => {
    if (val.calendarSystem) checkAnchor(val, ctx);
  });

/** null clears the confirmation and hands the date back to the estimate. */
export const ConfirmEventDateSchema = z.object({
  confirmedDate: DATE_STR.nullable(),
});

export const UpdateEventStatusSchema = z.object({
  status: z.enum(EVENT_STATUS_VALUES),
});

export const AssignEventBranchesSchema = z.object({
  appliesToAllBranches: z.boolean(),
  branchIds: z.array(z.string().uuid()).default([]),
});

export const EventDemandItemSchema = z.object({
  productId: z.string().uuid('Product is required'),
  qty: z.number().positive('Quantity must be greater than zero'),
  remarks: z.string().max(500).optional(),
});

/**
 * branchId is deliberately absent: it comes from the caller's JWT, never the
 * body. Same rule as CreateProductionOrderSchema.
 */
export const SaveEventDemandSchema = z
  .object({
    items: z.array(EventDemandItemSchema).min(1, 'Add at least one product'),
    expectedCustomers: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    // One product, one line. A duplicate is a row the branch forgot to remove and
    // would silently double the consolidated total.
    const seen = new Set<string>();
    val.items.forEach((item, i) => {
      if (seen.has(item.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'productId'],
          message: 'This product is already on the demand',
        });
      }
      seen.add(item.productId);
    });
  });

export const ReviewEventDemandSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  /** Per-line overrides. Omitted lines keep their requested quantity. */
  approvedItems: z
    .array(
      z.object({
        productId: z.string().uuid(),
        approvedQty: z.number().nonnegative('Approved quantity cannot be negative'),
      }),
    )
    .optional(),
  remarks: z.string().max(1000).optional(),
});

export const UpdateEventStageSchema = z.object({
  completionPercentage: z.number().int().min(0).max(100),
  remarks: z.string().max(500).optional(),
});

export const DispatchEventNotificationsSchema = z.object({
  /** Defaults to today's business date. Set it to replay a specific day. */
  onDate: DATE_STR.optional(),
  dryRun: z.boolean().default(false),
});

export const RefreshEventEstimatesSchema = z.object({
  year: z.number().int().min(2000).max(2200).optional(),
});

export const RollForwardEventsSchema = z.object({
  targetYear: z.number().int().min(2000).max(2200).optional(),
});

export type CreateSpecialEventInput = z.infer<typeof CreateSpecialEventSchema>;
export type UpdateSpecialEventInput = z.infer<typeof UpdateSpecialEventSchema>;
export type ConfirmEventDateInput = z.infer<typeof ConfirmEventDateSchema>;
export type UpdateEventStatusInput = z.infer<typeof UpdateEventStatusSchema>;
export type AssignEventBranchesInput = z.infer<typeof AssignEventBranchesSchema>;
export type SaveEventDemandInput = z.infer<typeof SaveEventDemandSchema>;
export type ReviewEventDemandInput = z.infer<typeof ReviewEventDemandSchema>;
export type UpdateEventStageInput = z.infer<typeof UpdateEventStageSchema>;
export type DispatchEventNotificationsInput = z.infer<typeof DispatchEventNotificationsSchema>;
