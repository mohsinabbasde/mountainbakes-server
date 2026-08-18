import { z } from 'zod';

/**
 * The business date a client captured when the transaction actually happened.
 *
 * OPTIONAL everywhere, and that is load-bearing in both directions:
 *
 * - The web app never sends it. A browser at the counter is online by
 *   definition, so the server stamping the day on receipt is already right for
 *   it, and a static-export PWA running a previous bundle must keep working
 *   unchanged.
 * - The mobile app does send it, because it writes offline. A sale rung up at
 *   9pm with no signal and delivered at 7am belongs to the evening it was made,
 *   not the morning it arrived.
 *
 * The server bounds it (no future dates, nothing older than the sync window) and
 * puts it through the same day-closure check as any other write —
 * `resolveClientBusinessDate`. The shape is checked here; the authority is there.
 */
export const optionalBusinessDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a business date as YYYY-MM-DD')
  .refine((s) => {
    // '2026-02-31' parses and rolls over to March rather than failing, so the
    // round trip back to a string is what catches a date that does not exist.
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist')
  .optional();
