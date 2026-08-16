export interface AppSettings {
  companyName: string;
  logoUrl: string;
  logoPath: string;
  currency: string;
  currencySymbol: string;
  gstRate: number;
  gstEnabled: boolean;
  receiptFooter: string;
  theme: 'light' | 'dark';
  // Business Hours (Super Admin) — the day-rollover boundary itself is a fixed
  // 2:00 AM constant in the shared timezone util; these drive order-window
  // enforcement and the automatic closing job. All times are 'HH:mm' (Karachi).
  businessStartTime: string;
  businessClosingTime: string;
  orderStartTime: string;
  orderEndTime: string;
  autoCloseBusiness: boolean;
  autoStockClosing: boolean;
  /** Master switch for the 2 AM WhatsApp/SMS closing summaries. */
  closingNotificationsEnabled: boolean;
  /**
   * Master switch for the per-order confirmation SMS to the customer. Off by
   * default — turning it on starts billing real messages to real numbers.
   */
  orderConfirmationsEnabled: boolean;
  /**
   * Master switch for scheduled Special Event reminders (WhatsApp/SMS legs). Off
   * by default for the same reason as the two above. The cron dispatcher respects
   * it; a manual "send due reminders now" from the admin screen does not.
   */
  eventNotificationsEnabled: boolean;
  /**
   * Master switch for branch geofencing. Off by default, and deliberately so:
   * switching it on is what starts refusing sales, and that must be an explicit
   * act by an admin who has already configured branch locations.
   */
  geofencingEnabled: boolean;
  /** Radius applied to a branch that has not been given one of its own, in km. */
  geofenceDefaultRadiusKm: number;
  /** How often an active client re-checks its position, in minutes. */
  geofenceVerifyIntervalMin: number;
  /**
   * Refuse a fix whose accuracy circle straddles the branch boundary rather than
   * falling back to the raw centre distance. See evaluateGeofence — it only bites
   * on genuinely ambiguous readings, never on a clear-cut one.
   */
  geofenceRequireHighAccuracy: boolean;
  /** How long to wait for the device to produce a fix, in seconds. */
  geofenceGpsTimeoutSec: number;
  /**
   * Oldest position the API will accept, in seconds. This is what stops a captured
   * `X-Geo-Position` header being replayed from somewhere else all day; it is not a
   * client-side concern, since the client refreshes on its own ticker.
   */
  geofenceMaxPositionAgeSec: number;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Defaults for the geofencing block.
 *
 * `geofencingEnabled: false` is the important one — see the field comment. The
 * radius matches DEFAULT_GEOFENCE_RADIUS_KM in `utils/geo`; they are separate
 * constants because one is a settings default and the other is the fallback used
 * when a branch row carries no radius at all.
 */
export const DEFAULT_GEOFENCE_SETTINGS = {
  geofencingEnabled: false,
  geofenceDefaultRadiusKm: 50,
  geofenceVerifyIntervalMin: 5,
  geofenceRequireHighAccuracy: true,
  geofenceGpsTimeoutSec: 20,
  geofenceMaxPositionAgeSec: 300,
} as const;

/** Defaults for the Business Hours block — the bakery's real 8:00 AM → 2:00 AM day. */
export const DEFAULT_BUSINESS_HOURS = {
  businessStartTime: '08:00',
  businessClosingTime: '02:00',
  orderStartTime: '08:00',
  orderEndTime: '02:00',
  autoCloseBusiness: true,
  autoStockClosing: true,
} as const;

export interface UpdateSettingsPayload {
  companyName?: string;
  currency?: string;
  currencySymbol?: string;
  gstRate?: number;
  gstEnabled?: boolean;
  receiptFooter?: string;
  theme?: 'light' | 'dark';
  businessStartTime?: string;
  businessClosingTime?: string;
  orderStartTime?: string;
  orderEndTime?: string;
  autoCloseBusiness?: boolean;
  autoStockClosing?: boolean;
  closingNotificationsEnabled?: boolean;
  orderConfirmationsEnabled?: boolean;
  eventNotificationsEnabled?: boolean;
  geofencingEnabled?: boolean;
  geofenceDefaultRadiusKm?: number;
  geofenceVerifyIntervalMin?: number;
  geofenceRequireHighAccuracy?: boolean;
  geofenceGpsTimeoutSec?: number;
  geofenceMaxPositionAgeSec?: number;
}
