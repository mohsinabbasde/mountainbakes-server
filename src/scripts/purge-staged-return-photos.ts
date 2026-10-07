import 'dotenv/config';
import { purgeStagedAttachments } from '../services/attachments.service';

/**
 * Maintenance script: remove return photos that were uploaded for a return that
 * never happened (migration 148).
 *
 * A return photo is uploaded BEFORE its return is submitted, so a refused or
 * abandoned return leaves one behind. The web app deletes its own on the spot
 * (DELETE /api/attachments/:id); this is the backstop for the ones it could not
 * — a closed tab, a dropped connection, a phone that queued a return offline and
 * was then wiped.
 *
 * Safe by design, same shape as purge-idempotency-keys:
 *  - DRY RUN by default (counts, deletes nothing).
 *  - Deletes only when passed `--confirm`.
 *  - Only STAGED rows (`entity_id is null`) of entity `branch_return`. A photo a
 *    return cites is bound, and a bound attachment cannot be deleted by anything
 *    — the database refuses it.
 *  - Only rows older than the window. The default is deliberately long: a phone
 *    can hold an offline return, and its already-uploaded photo, for days.
 *
 * Usage (from backend/):
 *   pnpm purge:return-photos                       # dry run, 14-day default
 *   pnpm purge:return-photos -- --days=30          # dry run, custom window
 *   pnpm purge:return-photos -- --confirm          # delete them
 */

const DEFAULT_DAYS = 14;
const confirmed = process.argv.includes('--confirm');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : DEFAULT_DAYS;

async function main() {
  console.log('Mountain Bakes ERP — Purge Staged Return Photos');
  console.log('===============================================');

  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a positive whole number (got "${daysArg}")`);
    process.exit(1);
  }

  const total = await purgeStagedAttachments({ entity: 'branch_return', olderThanDays: days, dryRun: true });
  console.log(`Found ${total} unused return photos older than ${days} days`);

  if (total === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  if (!confirmed) {
    console.log('\nDRY RUN — nothing deleted.');
    console.log('Re-run with --confirm to delete them:');
    console.log(`  pnpm purge:return-photos -- --days=${days} --confirm\n`);
    process.exit(0);
  }

  const removed = await purgeStagedAttachments({ entity: 'branch_return', olderThanDays: days });
  console.log(`Deleted ${removed} unused return photos.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
