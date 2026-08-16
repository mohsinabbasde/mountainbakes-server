import { z } from 'zod';

/** 24-hour 'HH:mm' (00:00–23:59). */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm (24-hour)');

export const UpdateSettingsSchema = z.object({
  companyName: z.string().min(2).optional(),
  currency: z.string().min(2).optional(),
  currencySymbol: z.string().min(1).optional(),
  gstRate: z.number().min(0).max(100).optional(),
  gstEnabled: z.boolean().optional(),
  receiptFooter: z.string().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  businessStartTime: HHMM.optional(),
  businessClosingTime: HHMM.optional(),
  orderStartTime: HHMM.optional(),
  orderEndTime: HHMM.optional(),
  autoCloseBusiness: z.boolean().optional(),
  autoStockClosing: z.boolean().optional(),
  closingNotificationsEnabled: z.boolean().optional(),
  orderConfirmationsEnabled: z.boolean().optional(),
  eventNotificationsEnabled: z.boolean().optional(),
  geofencingEnabled: z.boolean().optional(),
  // Same 500 km ceiling as a per-branch radius (geofence.schemas.ts) — a default
  // that large is a typo, not a policy.
  geofenceDefaultRadiusKm: z.number().positive().max(500).optional(),
  // A minute is the floor: anything tighter drains a phone battery for no gain,
  // since a cashier standing at a till does not move between checks.
  geofenceVerifyIntervalMin: z.number().int().min(1).max(120).optional(),
  geofenceRequireHighAccuracy: z.boolean().optional(),
  geofenceGpsTimeoutSec: z.number().int().min(5).max(120).optional(),
  // Must comfortably exceed the verify interval, or the server starts rejecting
  // fixes the client has not had a chance to refresh yet.
  geofenceMaxPositionAgeSec: z.number().int().min(30).max(3600).optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
