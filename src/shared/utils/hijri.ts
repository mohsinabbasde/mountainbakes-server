// Hijri (Umm al-Qura) ↔ Gregorian conversion for the Special Events module.
//
// No dependency. The conversion is done with the ICU calendar that ships inside
// `Intl` — `new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', …)` — which is the
// same Umm al-Qura table Saudi Arabia publishes and every major platform ships.
//
// ─── READ THIS BEFORE MOVING ANY OF THIS TO THE CLIENT ───────────────────────
// The AUTHORITATIVE estimate for an event is the one the SERVER computed and
// stored in special_events.estimated_date. On the web side these functions are
// DISPLAY ONLY — they render "1 Shawwal 1447" beside a date the server already
// decided. That is not a style preference: the web app is a PWA, and an old
// Android WebView with a trimmed ICU can silently fall back to `islamic-civil`,
// which drifts a day or two from Umm al-Qura. Computing a schedule on the client
// would mean two devices disagreeing about when Eid is. Do not "optimise" the
// server round-trip away.
//
// ─── AND THESE ARE ESTIMATES ─────────────────────────────────────────────────
// Umm al-Qura is *calculated*. Pakistan's Ruet-e-Hilal committee announces on
// moon sighting and can differ by a day or two in either direction. That is
// exactly why special_events carries a separate `confirmed_date` that overrides
// whatever this file returns. Never present a value from here as final.

export interface HijriDate {
  year: number;
  month: number; // 1–12, 1 = Muharram
  day: number; // 1–30
}

/** Umm al-Qura month names, index 0 = Muharram. */
export const HIJRI_MONTHS: readonly string[] = [
  'Muharram',
  'Safar',
  "Rabi' al-Awwal",
  "Rabi' al-Thani",
  'Jumada al-Awwal',
  'Jumada al-Thani',
  'Rajab',
  "Sha'ban",
  'Ramadan',
  'Shawwal',
  'Dhu al-Qadah',
  'Dhu al-Hijjah',
];

/**
 * One formatter for the module. Constructing an Intl.DateTimeFormat is
 * measurably expensive and `fromHijri` calls `toHijri` up to 11 times per
 * lookup, so this is memoised rather than built per call.
 *
 * The calendar is selected with the `-u-ca-` LOCALE EXTENSION rather than the
 * `{ calendar }` option — the extension is the form that resolves reliably
 * across runtimes.
 */
const FMT = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const MS_PER_DAY = 86_400_000;

/**
 * 1 Muharram 1 AH in the proleptic Gregorian calendar, anchored at noon UTC.
 * Only used to seed the search in `fromHijri` — it is a starting guess, never an
 * answer, so a day of imprecision in the epoch costs nothing.
 */
const HIJRI_EPOCH_UTC = Date.UTC(622, 6, 19, 12, 0, 0);

/** Mean lengths, for the same seeding purpose. */
const MEAN_HIJRI_YEAR = 354.36707;
const MEAN_HIJRI_MONTH = 29.530589;

/**
 * How far either side of the seed `fromHijri` will search. Measured drift is
 * consistently 1 day across 1400–1500 AH; 5 is a wide margin that still bounds
 * the loop at 11 formatter calls.
 */
const SEARCH_RADIUS_DAYS = 5;

/**
 * Anchor a date at noon UTC. Every conversion here goes through this so no
 * residual timezone offset can push a result onto the neighbouring day — the
 * classic off-by-one in calendar code.
 */
function atNoonUTC(date: Date | string): Date {
  if (typeof date === 'string') {
    // 'YYYY-MM-DD' (the shape every date column in this schema uses) or a full ISO string.
    const dateOnly = date.length === 10 ? date : date.slice(0, 10);
    return new Date(`${dateOnly}T12:00:00.000Z`);
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
}

/** 'YYYY-MM-DD' for a Date, read in UTC. */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Gregorian → Umm al-Qura. This is the only direction `Intl` provides directly,
 * which is why everything else in this file is built on top of it.
 */
export function toHijri(date: Date | string): HijriDate {
  const parts = FMT.formatToParts(atNoonUTC(date));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    // The 'era' part ("AH") and the literals are not needed.
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    else if (part.type === 'month') month = Number.parseInt(part.value, 10);
    else if (part.type === 'day') day = Number.parseInt(part.value, 10);
  }
  return { year, month, day };
}

/**
 * Umm al-Qura → Gregorian 'YYYY-MM-DD'.
 *
 * `Intl` has no inverse, so this is a seeded bounded search: approximate the day
 * count from the Hijri epoch, then walk outward from that guess calling
 * `toHijri` until the parts match exactly. That makes the result exact by
 * construction — `Intl` stays the authority and the arithmetic only decides
 * where to start looking.
 *
 * Returns null when the date does not exist (day 30 of a 29-day month is the
 * common case) or falls outside the ICU Umm al-Qura table (roughly
 * 1300–1600 AH / 1882–2174 CE). Callers must handle null rather than assume a
 * Hijri month/day pair is always resolvable.
 */
export function fromHijri(h: HijriDate): string | null {
  if (!Number.isFinite(h.year) || h.month < 1 || h.month > 12 || h.day < 1 || h.day > 30) {
    return null;
  }

  const seedDays = Math.round(
    (h.year - 1) * MEAN_HIJRI_YEAR + (h.month - 1) * MEAN_HIJRI_MONTH + (h.day - 1),
  );
  const seed = HIJRI_EPOCH_UTC + seedDays * MS_PER_DAY;

  for (let radius = 0; radius <= SEARCH_RADIUS_DAYS; radius += 1) {
    // radius 0 is the seed itself; after that check both sides before widening.
    const offsets = radius === 0 ? [0] : [radius, -radius];
    for (const offset of offsets) {
      const candidate = new Date(seed + offset * MS_PER_DAY);
      const parts = toHijri(candidate);
      if (parts.year === h.year && parts.month === h.month && parts.day === h.day) {
        return toDateStr(candidate);
      }
    }
  }

  return null;
}

/**
 * Every Gregorian date in `gregorianYear` on which the (month, day) Hijri
 * anniversary falls.
 *
 * A Hijri year is ~354 days, so an anniversary legitimately occurs 0, 1 or 2
 * times inside one Gregorian year — Ramadan lands twice in 2030, and there are
 * Gregorian years an early-Muharram date skips entirely. Callers must not assume
 * exactly one result; that assumption is what makes naive "add a year" roll-forward
 * logic drift.
 */
export function hijriAnniversariesIn(
  hijriMonth: number,
  hijriDay: number,
  gregorianYear: number,
): string[] {
  const firstHijriYear = toHijri(`${gregorianYear}-01-01`).year;
  const lastHijriYear = toHijri(`${gregorianYear}-12-31`).year;

  const out: string[] = [];
  for (let year = firstHijriYear; year <= lastHijriYear; year += 1) {
    const resolved = fromHijri({ year, month: hijriMonth, day: hijriDay });
    if (resolved && Number(resolved.slice(0, 4)) === gregorianYear) out.push(resolved);
  }
  return out;
}

/**
 * The first Hijri anniversary in `gregorianYear`, or null if it does not fall in
 * that year at all. The convenience wrapper the event date resolver uses; reach
 * for `hijriAnniversariesIn` when the second occurrence matters.
 */
export function estimateGregorianForHijri(
  hijriMonth: number,
  hijriDay: number,
  gregorianYear: number,
): string | null {
  return hijriAnniversariesIn(hijriMonth, hijriDay, gregorianYear)[0] ?? null;
}

/**
 * 'YYYY-MM-DD' for the nth <weekday> of a Gregorian month — "2nd Sunday of May"
 * (Mother's Day), "3rd Sunday of June" (Father's Day). `weekday` is 0 = Sunday.
 *
 * Returns null when the month has no nth occurrence (a 5th Sunday most months),
 * rather than silently rolling into the following month.
 */
export function nthWeekdayOf(
  year: number,
  month: number,
  nth: number,
  weekday: number,
): string | null {
  if (month < 1 || month > 12 || nth < 1 || nth > 5 || weekday < 0 || weekday > 6) return null;

  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const shiftToFirstMatch = (weekday - first.getUTCDay() + 7) % 7;
  const dayOfMonth = 1 + shiftToFirstMatch + (nth - 1) * 7;

  const daysInMonth = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  if (dayOfMonth > daysInMonth) return null;

  return toDateStr(new Date(Date.UTC(year, month - 1, dayOfMonth, 12)));
}

/**
 * Days in a Hijri month — 29 or 30, and genuinely variable: Ramadan is 30 days
 * in 1447 but 29 in 1448, 1449 and 1450.
 *
 * Returns null when the month is outside the ICU Umm al-Qura table.
 */
export function hijriMonthLength(hijriYear: number, hijriMonth: number): number | null {
  // If day 30 resolves, the month has 30 days; otherwise it has 29. Cheaper and
  // more reliable than computing the next month's start and subtracting.
  if (fromHijri({ year: hijriYear, month: hijriMonth, day: 30 })) return 30;
  return fromHijri({ year: hijriYear, month: hijriMonth, day: 29 }) ? 29 : null;
}

/**
 * The last `weekday` falling inside a given Hijri month, as Gregorian
 * 'YYYY-MM-DD'. `weekday` is 0 = Sunday, so Friday is 5.
 *
 * This is what "Jumuat-ul-Wida — the last Friday of Ramadan" needs. Walking back
 * from the month's final day is the only correct way to do it: the month is 29 or
 * 30 days depending on the year, so no fixed day number gives the right answer.
 */
export function lastWeekdayOfHijriMonth(
  hijriYear: number,
  hijriMonth: number,
  weekday: number,
): string | null {
  const length = hijriMonthLength(hijriYear, hijriMonth);
  if (length === null || weekday < 0 || weekday > 6) return null;

  const lastDay = fromHijri({ year: hijriYear, month: hijriMonth, day: length });
  if (!lastDay) return null;

  const cursor = new Date(`${lastDay}T12:00:00.000Z`);
  // At most 6 steps back — one of the last seven days is always the weekday we
  // want, and every one of them is still inside the month.
  const stepBack = (cursor.getUTCDay() - weekday + 7) % 7;
  cursor.setUTCDate(cursor.getUTCDate() - stepBack);
  return toDateStr(cursor);
}

/**
 * Every Gregorian date in `gregorianYear` that is the last `weekday` of the given
 * Hijri month. Like `hijriAnniversariesIn`, this can legitimately return 0, 1 or
 * 2 dates.
 */
export function lastWeekdayOfHijriMonthIn(
  hijriMonth: number,
  weekday: number,
  gregorianYear: number,
): string[] {
  const firstHijriYear = toHijri(`${gregorianYear}-01-01`).year;
  const lastHijriYear = toHijri(`${gregorianYear}-12-31`).year;

  const out: string[] = [];
  for (let year = firstHijriYear; year <= lastHijriYear; year += 1) {
    const resolved = lastWeekdayOfHijriMonth(year, hijriMonth, weekday);
    if (resolved && Number(resolved.slice(0, 4)) === gregorianYear) out.push(resolved);
  }
  return out;
}

/** "10 Dhu al-Hijjah 1447 AH" — the label shown beside a Gregorian date. */
export function formatHijri(h: HijriDate): string {
  const name = HIJRI_MONTHS[h.month - 1] ?? String(h.month);
  return `${h.day} ${name} ${h.year} AH`;
}

/** Convenience for the UI: the Hijri label for a Gregorian 'YYYY-MM-DD'. */
export function formatHijriFor(date: Date | string): string {
  return formatHijri(toHijri(date));
}

/** Add `n` days to a 'YYYY-MM-DD' string. Calendar-safe, UTC-based. */
export function addDaysToDateStr(dateStr: string, n: number): string {
  const base = new Date(`${dateStr}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + n);
  return toDateStr(base);
}

/**
 * Whole days from `fromDateStr` to `toDateStr` — positive when `to` is later.
 * Both anchored at noon UTC, so this is never off by one across a DST-like edge.
 */
export function daysBetweenDateStr(fromDateStr: string, toDateStr_: string): number {
  const from = new Date(`${fromDateStr}T12:00:00.000Z`).getTime();
  const to = new Date(`${toDateStr_}T12:00:00.000Z`).getTime();
  return Math.round((to - from) / MS_PER_DAY);
}
