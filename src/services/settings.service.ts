import { supabaseAdmin } from '../config/supabase';
import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_GEOFENCE_SETTINGS,
  hhmmToMinutes,
  ORDER_WINDOW_OPEN_MINUTES,
  ORDER_WINDOW_CLOSE_MINUTES,
  type AppSettings,
} from '../shared';
import { getCached, setCached } from '../utils/cache';

/** Full defaults — used when the settings/app doc is missing or partially populated. */
const FULL_DEFAULTS: AppSettings = {
  companyName: 'Mountain Bakes',
  logoUrl: '',
  logoPath: '',
  currency: 'PKR',
  currencySymbol: 'Rs.',
  gstRate: 0,
  gstEnabled: false,
  receiptFooter: 'Thank you for choosing Mountain Bakes!',
  theme: 'light',
  ...DEFAULT_BUSINESS_HOURS,
  closingNotificationsEnabled: false,
  orderConfirmationsEnabled: false,
  eventNotificationsEnabled: false,
  ...DEFAULT_GEOFENCE_SETTINGS,
  updatedAt: '',
  updatedBy: '',
};

/** snake_case `settings` row → camelCase AppSettings field. */
const COLUMN_TO_FIELD: Record<string, keyof AppSettings> = {
  company_name: 'companyName',
  logo_url: 'logoUrl',
  logo_path: 'logoPath',
  currency: 'currency',
  currency_symbol: 'currencySymbol',
  gst_rate: 'gstRate',
  gst_enabled: 'gstEnabled',
  receipt_footer: 'receiptFooter',
  theme: 'theme',
  business_start_time: 'businessStartTime',
  business_closing_time: 'businessClosingTime',
  order_start_time: 'orderStartTime',
  order_end_time: 'orderEndTime',
  auto_close_business: 'autoCloseBusiness',
  auto_stock_closing: 'autoStockClosing',
  closing_notifications_enabled: 'closingNotificationsEnabled',
  order_confirmations_enabled: 'orderConfirmationsEnabled',
  event_notifications_enabled: 'eventNotificationsEnabled',
  geofencing_enabled: 'geofencingEnabled',
  geofence_default_radius_km: 'geofenceDefaultRadiusKm',
  geofence_verify_interval_min: 'geofenceVerifyIntervalMin',
  geofence_require_high_accuracy: 'geofenceRequireHighAccuracy',
  geofence_gps_timeout_sec: 'geofenceGpsTimeoutSec',
  geofence_max_position_age_sec: 'geofenceMaxPositionAgeSec',
  updated_at: 'updatedAt',
  updated_by: 'updatedBy',
};

/**
 * camelCase AppSettings field → snake_case `settings` column, derived from
 * COLUMN_TO_FIELD so the two can never drift. Used by the settings route to
 * translate an incoming PUT body into a row.
 */
export const FIELD_TO_COLUMN = Object.fromEntries(
  Object.entries(COLUMN_TO_FIELD).map(([column, field]) => [field, column]),
) as Record<keyof AppSettings, string>;

/**
 * Resolve app settings with every field guaranteed present (defaults filled in),
 * using the shared 60s in-process cache. The single source both the settings
 * route and the business-logic (order window, daily closing) read from.
 *
 * NULL columns are skipped rather than spread over FULL_DEFAULTS. Postgres
 * returns unset fields as null, which would otherwise clobber a default with
 * null and hand callers a settings object that fails its own type; skipping them
 * lets the defaults fill in instead.
 *
 * `numeric` columns are coerced back to numbers on the way through — see
 * coerceToDefaultType. Every numeric setting arrives as a STRING otherwise.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const hit = getCached<AppSettings>('settings');
  if (hit) return hit;

  const { data, error } = await supabaseAdmin.from('settings').select('*').maybeSingle();
  if (error) throw new Error(`Failed to load app settings: ${error.message}`);

  const settings: AppSettings = { ...FULL_DEFAULTS };
  for (const [column, value] of Object.entries(data ?? {})) {
    const field = COLUMN_TO_FIELD[column];
    if (field && value !== null && value !== undefined) {
      (settings as unknown as Record<string, unknown>)[field] = coerceToDefaultType(field, value);
    }
  }

  setCached('settings', settings);
  return settings;
}

/**
 * Restore a value's declared type, using FULL_DEFAULTS as the schema.
 *
 * supabase-js hands back every `numeric` column as a STRING — Postgres numerics
 * have no lossless JavaScript representation, so PostgREST serialises them as text
 * rather than risk a silent rounding. `gst_rate` and `geofence_default_radius_km`
 * are both numeric, so without this an AppSettings claiming `gstRate: number`
 * actually carries `"0.000"`.
 *
 * That is worse than a cosmetic type lie. Loose comparison hides it in some places
 * ("50" > 0 is true) and not in others: the geofence rule tests `typeof === 'number'`
 * before trusting a radius, so a string one is discarded and the branch silently
 * falls back to the built-in 50 km — an admin's configured 25 km would simply not
 * apply, with nothing logged to say so.
 *
 * Driven off the default's runtime type rather than a hand-kept list of numeric
 * fields, so a numeric setting added later is covered without anyone remembering.
 */
function coerceToDefaultType(field: keyof AppSettings, value: unknown): unknown {
  if (typeof FULL_DEFAULTS[field] === 'number' && typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : FULL_DEFAULTS[field];
  }
  return value;
}

/** Order-window bounds in Karachi minutes-of-day, from settings (with safe fallbacks). */
export function orderWindowMinutes(
  settings: Pick<AppSettings, 'orderStartTime' | 'orderEndTime'>,
): { openMin: number; closeMin: number } {
  return {
    openMin: hhmmToMinutes(settings.orderStartTime) ?? ORDER_WINDOW_OPEN_MINUTES,
    closeMin: hhmmToMinutes(settings.orderEndTime) ?? ORDER_WINDOW_CLOSE_MINUTES,
  };
}
