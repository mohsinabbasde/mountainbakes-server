import { formatHijri, hijriAnniversariesIn, nthWeekdayOf, toHijri } from '../shared';

/**
 * Print the computed Gregorian dates for every seeded Islamic event across a
 * range of years, so they can be eyeballed against a published Umm al-Qura
 * calendar.
 *
 * This exists because the Hijri conversion is the only algorithmically risky code
 * in the Special Events module and there is no test runner in this repo. It reads
 * nothing and writes nothing — no database, no env, no side effects.
 *
 * A missing date is NOT necessarily a bug: a Hijri year is ~354 days, so an
 * anniversary legitimately falls zero or two times inside one Gregorian year.
 * Two dates on one line is the signal to check that the calendar UI and the
 * roll-forward both cope.
 *
 * Usage (from mountainbakes-server/):
 *   npx tsx src/scripts/verify-hijri.ts
 *   npx tsx src/scripts/verify-hijri.ts 2026 2035
 */

const SEEDED_ISLAMIC_EVENTS: { name: string; month: number; day: number }[] = [
  { name: 'Ramadan Begins', month: 9, day: 1 },
  { name: 'Shab-e-Qadr', month: 9, day: 27 },
  { name: 'Eid-ul-Fitr', month: 10, day: 1 },
  { name: 'Eid-ul-Adha', month: 12, day: 10 },
  { name: 'Islamic New Year', month: 1, day: 1 },
  { name: 'Ashura', month: 1, day: 10 },
  { name: '12 Rabi-ul-Awwal', month: 3, day: 12 },
  { name: 'Shab-e-Barat', month: 8, day: 15 },
];

function main(): void {
  const fromYear = Number(process.argv[2] ?? 2026);
  const toYear = Number(process.argv[3] ?? 2032);

  console.log('Mountain Bakes ERP — Hijri estimate verification');
  console.log('===============================================');
  console.log(`Calendar in use: ${new Intl.DateTimeFormat('en-u-ca-islamic-umalqura').resolvedOptions().calendar}`);
  console.log('These are Umm al-Qura CALCULATED dates. Pakistan announces on moon');
  console.log('sighting and may differ by a day or two — that is what confirmed_date is for.');
  console.log('');

  const width = Math.max(...SEEDED_ISLAMIC_EVENTS.map((e) => e.name.length)) + 2;

  for (let year = fromYear; year <= toYear; year += 1) {
    console.log(`── ${year} ──────────────────────────────────────────────`);
    for (const event of SEEDED_ISLAMIC_EVENTS) {
      const dates = hijriAnniversariesIn(event.month, event.day, year);
      const rendered =
        dates.length === 0
          ? '(does not fall in this Gregorian year)'
          : dates.map((d) => `${d}  (${formatHijri(toHijri(d))})`).join('   +   ');
      console.log(`  ${event.name.padEnd(width)}${rendered}`);
    }
    console.log('');
  }

  console.log('── nth-weekday anchors ─────────────────────────────────');
  for (let year = fromYear; year <= toYear; year += 1) {
    const mothers = nthWeekdayOf(year, 5, 2, 0);
    const fathers = nthWeekdayOf(year, 6, 3, 0);
    console.log(`  ${year}   Mother's Day ${mothers}   Father's Day ${fathers}`);
  }
}

main();
