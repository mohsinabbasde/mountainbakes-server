import { supabaseAdmin } from '../config/supabase';
import { logAudit } from './audit.service';
import { countRecentFailures } from './login-attempts.service';
import { notify } from './push.service';
import { describeDevice, type ParsedUserAgent } from '../utils/userAgent';

/**
 * Suspicious-login detection, and the admin alert that follows it.
 *
 * WHAT THIS IS ALLOWED TO DO. Set a flag and write a notification. Nothing more.
 * It never blocks a sign-in, never revokes a session, never locks an account and
 * is never consulted by an authorisation check — a caller looking for a decision
 * will not find one here. That restraint is the design, not an unfinished half
 * of it, and the reason is in the next paragraph.
 *
 * WHY IT MUST NOT ACT. Every signal available to it is weak:
 *
 *   * IP geolocation is a commercial database that is regularly wrong by a whole
 *     country, and is wrong most often for exactly the mobile and satellite
 *     networks a bakery's staff actually use.
 *   * A VPN, a corporate proxy or a carrier-grade NAT relocates a user to
 *     wherever the exit node is, and that node moves without the user knowing.
 *   * A browser update rewrites the user agent. A phone replaced under warranty
 *     is a new device. A staff member borrowing a colleague's tablet for one
 *     shift is a new device, a new browser and possibly a new city at once.
 *
 * Any one of those trips a rule here while nothing is wrong. A system that
 * locked an account on this evidence would lock out the shop on the day the
 * carrier re-homed its NAT, during service, with the owner unreachable — and the
 * failure would look exactly like a real compromise, so nobody could safely
 * override it. Flagging costs a notification somebody dismisses; blocking costs
 * a day's trade. The asymmetry is not close.
 *
 * So `suspicious_reason` is written as prose for a person, not as a code to
 * branch on, and it means "worth a look" — never "this account is compromised".
 * A future caller tempted to `if (session.isSuspicious)` should read this
 * paragraph first.
 */

/**
 * How long a session's history is worth comparing against.
 *
 * Ninety days matches the window the history screen defaults to, so what the
 * detector considers "familiar" is the same set of rows an admin can see when
 * they go looking for why something was flagged. A longer window would flag less
 * — every country would eventually be familiar — and would also mean the
 * explanation sat outside the list the admin is reading.
 */
const HISTORY_DAYS = 90;

/**
 * How many prior sessions an account needs before anything can be unusual.
 *
 * With no history there is no baseline, and every field is "new". A brand-new
 * account's first sign-in would otherwise fire three alerts at once, on its
 * country, its browser and its device — noise on the one login that is expected
 * and already known about, since an admin created the account minutes earlier.
 */
const MIN_HISTORY = 3;

/**
 * Two logins from different countries closer together than this are called
 * impossible travel.
 *
 * Six hours, not the couple of hours a great-circle-distance calculation would
 * suggest, and deliberately generous. Karachi to Dubai is a two-hour flight, so
 * a tighter bound flags a genuine business trip; and because this rule fires on
 * the one pattern most often produced by a VPN toggling on and off, a tight
 * bound would fire it constantly. Six hours keeps it to the shape that is
 * actually hard to explain: the same account live on two continents inside a
 * working day.
 */
const IMPOSSIBLE_TRAVEL_MS = 6 * 60 * 60 * 1000;

/**
 * How many refused attempts on the same address, in the hours before a
 * successful one, are worth mentioning.
 *
 * Five in six hours. A person who has forgotten their password tries three or
 * four times and then uses the reset link, so five is above ordinary human
 * fumbling; and because the rule fires on a SUCCESSFUL sign-in that followed
 * them, what it describes is "somebody eventually got in after a run of
 * failures" — which is the shape of both a guessed password and a genuinely
 * forgetful morning, and is therefore reported rather than acted on.
 *
 * REMEMBER WHERE THOSE ROWS COME FROM. `login_attempts` is client-reported and
 * forgeable (see its own module note), so this count can be inflated by anybody
 * who can reach the API. That is survivable precisely because the consequence is
 * a sentence on an admin's screen; it would not be survivable if it locked
 * anything.
 */
const FAILED_ATTEMPT_THRESHOLD = 5;
const FAILED_ATTEMPT_WINDOW_HOURS = 6;

/** The prior-session facts the rules run over. One query feeds all of them. */
interface HistoryRow {
  country: string | null;
  browser: string | null;
  os: string | null;
  login_at: string;
}

export interface SuspicionVerdict {
  isSuspicious: boolean;
  /** Prose for a human, or null. Several reasons are joined into one sentence. */
  reason: string | null;
}

const NOT_SUSPICIOUS: SuspicionVerdict = { isSuspicious: false, reason: null };

/**
 * Judge one sign-in against the account's own recent history.
 *
 * NEVER THROWS. It runs inside the request that opens a login session, and a
 * detector that could fail that request would trade a recorded login — a fact —
 * for an opinion about it. Every error path returns "not suspicious", so a
 * database hiccup means the login is recorded unflagged rather than not recorded
 * at all.
 *
 * Reads the history ONCE and runs every rule over the same rows, rather than a
 * query per rule: three round-trips inside a login is latency the user watches,
 * and rules reading different snapshots could contradict each other.
 */
export async function detectSuspicion(params: {
  userId: string;
  /** The address that authenticated. Used ONLY to count refused attempts against it. */
  email: string | null;
  country: string | null;
  device: ParsedUserAgent;
}): Promise<SuspicionVerdict> {
  try {
    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('login_sessions')
      .select('country, browser, os, login_at')
      .eq('user_id', params.userId)
      .gte('login_at', since)
      .order('login_at', { ascending: false })
      // Enough to establish what is normal without reading a year of rows into
      // memory on every sign-in. A user with more than 200 sessions in 90 days
      // has been signing in several times a day, and their recent 200 describe
      // their habits at least as well as all of them would.
      .limit(200);

    if (error || !data || data.length < MIN_HISTORY) return NOT_SUSPICIOUS;
    const history = data as HistoryRow[];

    const reasons: string[] = [];

    // ── Rule 1: a country this account has never signed in from ──
    // Only when the new login HAS a country. A null means the lookup failed or
    // the address was private, and "we could not tell" must never read as "a
    // place we have never seen" — that would flag every login from the office
    // LAN on the day the geo provider rate-limited us.
    if (params.country) {
      const seen = new Set(history.map((r) => r.country).filter(Boolean));
      if (seen.size > 0 && !seen.has(params.country)) {
        reasons.push(`first sign-in from ${params.country}`);
      }
    }

    // ── Rule 2: a browser / OS pairing this account has never used ──
    // The PAIR, not either alone. Chrome on Windows and Chrome on Android are
    // genuinely different devices, and a rule on the browser alone would miss
    // the second while a rule on the OS alone would miss a colleague's laptop.
    if (params.device.browser && params.device.os) {
      const combo = `${params.device.browser}|${params.device.os}`;
      const known = new Set(
        history.filter((r) => r.browser && r.os).map((r) => `${r.browser}|${r.os}`),
      );
      if (known.size > 0 && !known.has(combo)) {
        reasons.push(`new device — ${describeDevice(params.device)}`);
      }
    }

    // ── Rule 3: impossible travel ──
    // Against the most recent login that HAS a country, not simply the most
    // recent: a run of un-resolved logins in between would otherwise hide a
    // genuine hop, and comparing against a null tells us nothing either way.
    if (params.country) {
      const lastKnown = history.find((r) => r.country);
      if (lastKnown && lastKnown.country !== params.country) {
        const gap = Date.now() - Date.parse(lastKnown.login_at);
        if (Number.isFinite(gap) && gap >= 0 && gap < IMPOSSIBLE_TRAVEL_MS) {
          const hours = Math.max(1, Math.round(gap / (60 * 60 * 1000)));
          reasons.push(
            `signed in from ${lastKnown.country} ${hours}h earlier — an unlikely journey`,
          );
        }
      }
    }

    // ── Rule 4: this sign-in worked, but several before it did not ──
    // The one rule that reads outside `login_sessions`, because a failed attempt
    // never produces a session row — which is exactly why it is worth checking:
    // nothing else in this detector can see the difference between a first
    // attempt and a fifth.
    //
    // Its own try/catch inside the outer one. The failed-attempt table is newer
    // than this detector and less load-bearing than any other read here, so a
    // problem with it must cost this rule and not the three that already have
    // their answers.
    if (params.email) {
      try {
        const failures = await countRecentFailures(params.email, FAILED_ATTEMPT_WINDOW_HOURS);
        if (failures >= FAILED_ATTEMPT_THRESHOLD) {
          reasons.push(
            `${failures} failed sign-in attempts on this address in the previous ${FAILED_ATTEMPT_WINDOW_HOURS} hours`,
          );
        }
      } catch (err) {
        console.error('[login-security] failed-attempt count failed', err);
      }
    }

    if (!reasons.length) return NOT_SUSPICIOUS;

    // Joined into one sentence rather than kept as a list, because the column is
    // rendered straight into a cell and a caller that split it would be treating
    // prose as structure — the thing the module comment asks nobody to do.
    return { isSuspicious: true, reason: reasons.join('; ') };
  } catch (err) {
    console.error('[login-security] suspicion check failed', err);
    return NOT_SUSPICIOUS;
  }
}

/**
 * Tell the admins about a flagged sign-in.
 *
 * FIRE-AND-FORGET at the call site, and swallowing its own errors on top of
 * that: this runs after the session row is already written, and a failed
 * notification must not undo a recorded login. The flag is on the row either
 * way, so the Security screen shows it even when this never reached anybody.
 *
 * Targeted by ROLE, not by user id — `super_admin` is the audience, and there
 * may be several. Sending per-admin would mean reading the admin list on every
 * flagged login and would deliver nothing that `target_role` does not.
 *
 * The message names the staff code, never the email address. It is delivered to
 * an in-app feed that is read on a phone on a shop floor, and the account is
 * identifiable from `MBU-000125` for every purpose the alert serves.
 */
export async function alertSuspiciousLogin(input: {
  sessionId: string;
  userId: string;
  userCode: string | null;
  userName: string;
  userRole: string | null;
  country: string | null;
  city: string | null;
  device: ParsedUserAgent;
  reason: string;
}): Promise<void> {
  const who = input.userCode ?? input.userName;
  const where = [input.city, input.country].filter(Boolean).join(', ') || 'an unresolved location';

  try {
    await notify({
      type: 'security_alert',
      title: `Unusual sign-in · ${who}`,
      message: `${input.userName} signed in from ${where} on ${describeDevice(input.device)} — ${input.reason}.`,
      targetRole: 'super_admin',
      // The session row, so the notification can deep-link to the one login it
      // is about rather than to the list.
      relatedId: input.sessionId,
    });
  } catch (err) {
    console.error('[login-security] alert failed', err);
  }

  // Audited as well as notified. A notification is read and dismissed; the audit
  // row is what is still there in three months when somebody asks whether this
  // was ever noticed at the time.
  await logAudit({
    action: 'suspicious_login',
    // No admin performed this. See the note on AuditInput.adminId.
    adminId: null,
    adminName: 'Security detector',
    targetUserId: input.userId,
    targetUserName: input.userName,
    targetUserRole: input.userRole,
    details: `${who} · ${where} · ${describeDevice(input.device)} · ${input.reason}`,
  });
}
