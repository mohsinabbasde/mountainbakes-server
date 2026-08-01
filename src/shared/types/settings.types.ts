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
  updatedAt: string;
  updatedBy: string;
}

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
}
