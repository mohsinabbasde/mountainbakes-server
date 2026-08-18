import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

/**
 * Maintenance script: delete expired `idempotency_keys` rows (migration 84).
 *
 * The table grows by one row per offline-capable write and is only ever read by
 * a RETRY of that same write. A key older than the sync window can no longer be
 * replayed by anything — the business-date bound rejects the transaction before
 * the key is even looked up — so old rows are dead weight, not history.
 *
 * Safe by design, same shape as purge-price-history:
 *  - DRY RUN by default (counts, deletes nothing).
 *  - Deletes only when passed `--confirm`.
 *  - Only ever removes rows older than the retention window, so a key that could
 *    still protect a queued transaction is never touched — including one still
 *    `in_progress`, whose age is what makes it expired rather than in flight.
 *
 * Usage (from mountainbakes-server/):
 *   pnpm purge:idempotency-keys                       # dry run, 30-day default
 *   pnpm purge:idempotency-keys -- --days=14          # dry run, custom window
 *   pnpm purge:idempotency-keys -- --confirm          # delete them
 */

const DEFAULT_DAYS = 30;
const confirmed = process.argv.includes('--confirm');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : DEFAULT_DAYS;

async function main() {
  console.log('Mountain Bakes ERP — Purge Idempotency Keys');
  console.log('===========================================');

  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a positive whole number (got "${daysArg}")`);
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { count, error: countErr } = await supabaseAdmin
    .from('idempotency_keys')
    .select('*', { count: 'exact', head: true })
    .lt('created_at', cutoff);
  if (countErr) throw countErr;

  const total = count ?? 0;
  console.log(`Found ${total} keys older than ${days} days (before ${cutoff})`);

  if (total === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  if (!confirmed) {
    console.log('\nDRY RUN — nothing deleted.');
    console.log('Re-run with --confirm to delete them:');
    console.log(`  pnpm purge:idempotency-keys -- --days=${days} --confirm\n`);
    process.exit(0);
  }

  // Goes through the function rather than a PostgREST delete so the cutoff is
  // computed once, in the database, against the same clock the rows were
  // stamped with.
  const { data, error } = await supabaseAdmin.rpc('purge_idempotency_keys', {
    p_older_than_days: days,
  });
  if (error) throw error;

  console.log(`\n✔ Deleted ${Number(data ?? 0)} idempotency keys.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nPurge failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
