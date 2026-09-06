/**
 * Exercise the Login History identity and resume rules against the cases the
 * feature was specified with, and report what they actually did.
 *
 * Exists because there is no test runner in this repo and these two rules are
 * the security-relevant part of Login History: which address a row may claim
 * the person signed in with, and whether a reload continues a row or a
 * re-authentication opens a new one. Both are pure functions — no database,
 * no environment — so this runs anywhere, in under a second.
 *
 * Usage (from mountainbakes-server/):
 *   pnpm verify:login-identity
 */
import { providerOf, resolveLoginIdentity, resumeVerdict } from '../services/login-identity.service';
import { parseUserAgent } from '../utils/userAgent';

const results: string[] = [];
let failures = 0;

function check(label: string, ok: boolean, got?: unknown): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got: ${JSON.stringify(got)}`}`);
  if (!ok) failures += 1;
}

const UID = '00000000-0000-4000-8000-000000000002';
const STALE = 10 * 60 * 1000;

// ── TEST 1: Google OAuth ────────────────────────────────────────────────────
{
  const id = resolveLoginIdentity(
    { uid: UID, email: 'ahmed@mountainbakes.com', authMethods: ['oauth'], googleEmail: 'arifsiksavi@gmail.com' },
    'MBU-000002',
  );
  check('T1 Google sign-in → provider google', id.provider === 'google', id);
  check('T1 Google sign-in → browser_email is the Google address', id.browserEmail === 'arifsiksavi@gmail.com', id);
  check('T1 Google sign-in → mountain_bakes_id carried', id.mountainBakesId === 'MBU-000002', id);
  check('T1 Google sign-in → provider_email is the Google address', id.providerEmail === 'arifsiksavi@gmail.com', id);
}

// ── TEST 2: password login, no Google identity ──────────────────────────────
{
  const id = resolveLoginIdentity(
    { uid: UID, email: 'ahmed@mountainbakes.com', authMethods: ['password'], googleEmail: null },
    'MBU-000002',
  );
  check('T2 password login → provider password', id.provider === 'password', id);
  check('T2 password login → browser_email null ("Not recorded")', id.browserEmail === null, id);
  check('T2 password login → never the Mountain Bakes address', id.browserEmail !== 'ahmed@mountainbakes.com', id);
}

// ── TEST 2b: password login on an account that HAS Google linked ────────────
{
  const id = resolveLoginIdentity(
    { uid: UID, email: 'ahmed@mountainbakes.com', authMethods: ['password'], googleEmail: 'arifsiksavi@gmail.com' },
    'MBU-000002',
  );
  check('T2b password login with Google linked → browser_email still null', id.browserEmail === null, id);
}

// ── TEST 2c: refreshed token keeps the original method ──────────────────────
{
  check('T2c refreshed OAuth token still reads as google',
    providerOf({ authMethods: ['oauth', 'oauth'], googleEmail: 'arifsiksavi@gmail.com' }) === 'google');
  check('T2c OAuth session with no Google identity is unknown, not guessed',
    providerOf({ authMethods: ['oauth'], googleEmail: null }) === 'unknown');
  check('T2c token without amr is unknown',
    providerOf({ authMethods: [], googleEmail: 'arifsiksavi@gmail.com' }) === 'unknown');
}

// ── RESUME: the rule that caused "Not recorded" ─────────────────────────────
{
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const old = new Date(now - STALE - 1).toISOString();

  check('R1 reload with the same GoTrue session → resume',
    resumeVerdict({ user_id: UID, ended_at: null, last_seen_at: fresh, auth_session_id: 'gotrue-A' },
      { userId: UID, authSessionId: 'gotrue-A' }, STALE, now) === 'resume');

  check('R2 back from "Connect Google account" (new GoTrue session) → reauthenticated, NOT resumed',
    resumeVerdict({ user_id: UID, ended_at: null, last_seen_at: fresh, auth_session_id: 'gotrue-A' },
      { userId: UID, authSessionId: 'gotrue-B' }, STALE, now) === 'reauthenticated');

  check('R3 somebody else\'s row → not resumable',
    resumeVerdict({ user_id: 'other', ended_at: null, last_seen_at: fresh, auth_session_id: 'gotrue-A' },
      { userId: UID, authSessionId: 'gotrue-A' }, STALE, now) === 'not_resumable');

  check('R4 ended row → not resumable',
    resumeVerdict({ user_id: UID, ended_at: fresh, last_seen_at: fresh, auth_session_id: 'gotrue-A' },
      { userId: UID, authSessionId: 'gotrue-A' }, STALE, now) === 'not_resumable');

  check('R5 stale row → not resumable',
    resumeVerdict({ user_id: UID, ended_at: null, last_seen_at: old, auth_session_id: 'gotrue-A' },
      { userId: UID, authSessionId: 'gotrue-A' }, STALE, now) === 'not_resumable');

  check('R6 pre-98 row and token without session_id → resume (two nulls match)',
    resumeVerdict({ user_id: UID, ended_at: null, last_seen_at: fresh, auth_session_id: null },
      { userId: UID, authSessionId: null }, STALE, now) === 'resume');

  check('R7 pre-98 row but token now carries a session → reauthenticated',
    resumeVerdict({ user_id: UID, ended_at: null, last_seen_at: fresh, auth_session_id: null },
      { userId: UID, authSessionId: 'gotrue-B' }, STALE, now) === 'reauthenticated');

  check('R8 no stored row → not resumable',
    resumeVerdict(null, { userId: UID, authSessionId: 'gotrue-A' }, STALE, now) === 'not_resumable');
}

// ── TEST 6: two devices, two rows — browser metadata is per request ─────────
{
  const desktop = parseUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
  check('T6 desktop UA → Chrome', desktop.browser === 'Chrome', desktop);
  check('T6 desktop UA → version 152', desktop.browserVersion === '152', desktop);
  check('T6 desktop UA → Linux', desktop.os === 'Linux', desktop);
  check('T6 desktop UA → desktop', desktop.deviceType === 'desktop', desktop);

  const android = parseUserAgent(
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  );
  check('T6 Android UA → Chrome 152', android.browser === 'Chrome' && android.browserVersion === '152', android);
  check('T6 Android UA → Android', android.os === 'Android', android);
  check('T6 Android UA → mobile', android.deviceType === 'mobile', android);
}

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
