import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

/**
 * Exercise migration 84's replay protection against the LINKED database and
 * report what it actually did.
 *
 * This exists for the same reason as verify-hijri.ts: the logic is riskier than
 * average and there is no test runner in this repo. Idempotency is only worth
 * anything if it behaves exactly as claimed under a repeat, a race and a death
 * mid-flight — none of which a type-check can tell you about.
 *
 * SAFE TO RUN AGAINST PRODUCTION. It touches `idempotency_keys` only, under two
 * synthetic user ids that belong to no account, and deletes its own rows on the
 * way out (including after a failure). No business table is read or written, and
 * the purge check uses a 30-day window, so it can never remove a live key.
 *
 * Usage (from mountainbakes-server/):
 *   pnpm verify:idempotency
 */

const USER = '00000000-0000-4000-8000-0000000000ff';
const OTHER = '00000000-0000-4000-8000-0000000000fe';
const STALE_SECONDS = 300;

const results: string[] = [];
let failures = 0;

function check(label: string, ok: boolean, got?: unknown): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got: ${JSON.stringify(got)}`}`);
  if (!ok) failures += 1;
}

interface Claim {
  outcome: 'claimed' | 'replay' | 'in_progress' | 'mismatch';
  stale?: boolean;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
}

async function claim(
  key: string,
  fingerprint = 'fp-a',
  endpoint = 'verify.script',
  user = USER,
): Promise<Claim> {
  const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
    p_user_id: user,
    p_key: key,
    p_endpoint: endpoint,
    p_fingerprint: fingerprint,
    p_stale_seconds: STALE_SECONDS,
  });
  if (error) throw error;
  return data as Claim;
}

/** Compare by value: jsonb normalises key ORDER, and nothing reads JSON positionally. */
function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): string =>
    JSON.stringify(v, v && typeof v === 'object' ? Object.keys(v as object).sort() : undefined);
  return canon(a) === canon(b);
}

async function run(): Promise<void> {
  check('first claim is granted', (await claim('verify-first-01')).outcome === 'claimed');

  const repeat = await claim('verify-first-01');
  check(
    'a repeat while the first is in flight is reported, not granted',
    repeat.outcome === 'in_progress' && repeat.stale === false,
    repeat,
  );

  // The primary key IS the lock — one of three simultaneous claims may win.
  const race = await Promise.all([
    claim('verify-race-01'),
    claim('verify-race-01'),
    claim('verify-race-01'),
  ]);
  check(
    'exactly one of three concurrent claims wins',
    race.filter((r) => r.outcome === 'claimed').length === 1,
    race.map((r) => r.outcome),
  );

  const body = { id: 'order-1', orderNumber: 'ORD-000123', grandTotal: 1450.5 };
  const { error: completeErr } = await supabaseAdmin.rpc('complete_idempotency_key', {
    p_user_id: USER, p_key: 'verify-first-01', p_status: 201, p_body: body,
  });
  if (completeErr) throw completeErr;

  const replay = await claim('verify-first-01');
  check('a completed key replays its status', replay.outcome === 'replay' && replay.responseStatus === 201, replay);
  check('a completed key replays every field of its body', sameValue(replay.responseBody, body), replay.responseBody);
  check('replay keeps numeric precision', replay.responseBody?.['grandTotal'] === 1450.5, replay.responseBody);

  check('the same key with a different body is a mismatch',
    (await claim('verify-first-01', 'fp-DIFFERENT')).outcome === 'mismatch');
  check('the same key on a different endpoint is a mismatch',
    (await claim('verify-first-01', 'fp-a', 'other.endpoint')).outcome === 'mismatch');

  await claim('verify-release-01');
  await supabaseAdmin.rpc('release_idempotency_key', { p_user_id: USER, p_key: 'verify-release-01' });
  check('a released key can be claimed again', (await claim('verify-release-01')).outcome === 'claimed');

  await supabaseAdmin.rpc('release_idempotency_key', { p_user_id: USER, p_key: 'verify-first-01' });
  check('a COMPLETED key survives a release', (await claim('verify-first-01')).outcome === 'replay');

  // Backdate a claim past the window: a repeat must read as stale, which is what
  // sends it to a person instead of being re-run.
  await claim('verify-stale-01');
  const { error: ageErr } = await supabaseAdmin
    .from('idempotency_keys')
    .update({ created_at: new Date(Date.now() - (STALE_SECONDS + 300) * 1000).toISOString() })
    .eq('user_id', USER)
    .eq('key', 'verify-stale-01');
  if (ageErr) throw ageErr;
  const stale = await claim('verify-stale-01');
  check('a claim older than the window reads as stale',
    stale.outcome === 'in_progress' && stale.stale === true, stale);

  check('the same key under another user is its own claim',
    (await claim('verify-first-01', 'fp-a', 'verify.script', OTHER)).outcome === 'claimed');

  const { data: purged, error: purgeErr } = await supabaseAdmin.rpc('purge_idempotency_keys', {
    p_older_than_days: 30,
  });
  if (purgeErr) throw purgeErr;
  check('purging a 30-day window removes nothing recent', Number(purged) === 0, purged);
}

async function cleanup(): Promise<void> {
  for (const user of [USER, OTHER]) {
    const { error } = await supabaseAdmin.from('idempotency_keys').delete().eq('user_id', user);
    if (error) throw error;
  }
  const { count, error } = await supabaseAdmin
    .from('idempotency_keys')
    .select('*', { count: 'exact', head: true })
    .in('user_id', [USER, OTHER]);
  if (error) throw error;
  check('synthetic rows cleaned up', (count ?? -1) === 0, count);
}

async function main(): Promise<void> {
  console.log('Mountain Bakes API — verify idempotency (migration 84)');
  console.log('=====================================================');
  try {
    await run();
  } catch (err) {
    check('script completed', false, err instanceof Error ? err.message : err);
  } finally {
    // Runs whatever happened above: a failed run must not leave rows behind.
    await cleanup().catch((err) => check('cleanup', false, err instanceof Error ? err.message : err));
  }

  console.log(results.join('\n'));
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
