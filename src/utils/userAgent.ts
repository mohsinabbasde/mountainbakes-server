import type { LoginDeviceType } from '../shared';

/**
 * Read a browser, an operating system and a device class out of a user-agent
 * string.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. The npm options (`ua-parser-js`,
 * `bowser`) each ship a several-thousand-entry regex table to identify browsers
 * this app will never see, and both carry a maintenance burden — the table goes
 * stale, and a stale table is a silent wrong answer rather than a loud failure.
 * The whole audience here is staff on Chrome, Edge, Firefox, Safari and Samsung
 * Internet, on Windows, macOS, Android, iOS and Linux. That is a page of regexes,
 * and a page that gets a fringe agent wrong costs one mislabelled cell next to
 * the raw string it was read from.
 *
 * EVERY ANSWER IS A GUESS, AND SOME ARE LIES BY DESIGN. A user agent is a
 * self-declaration, and browsers have spent thirty years impersonating each
 * other to get past server sniffing: Chrome claims to be Safari and KHTML,
 * Edge claims to be Chrome and Safari, Opera and Samsung Internet claim to be
 * Chrome. Nothing here can see through a client that lies on purpose, and
 * nothing in the app is allowed to make a decision on these values — they are
 * shown to a person, beside the raw string, so a wrong reading stays visibly a
 * reading.
 *
 * ORDER IS THE ENTIRE ALGORITHM. Because the impersonation runs one way — the
 * newer browser claims to be the older one, never the reverse — testing the MOST
 * SPECIFIC claim first is what makes this correct. Reorder the branches and Edge
 * silently becomes Chrome.
 */

export interface ParsedUserAgent {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: LoginDeviceType | null;
}

const EMPTY: ParsedUserAgent = {
  browser: null,
  browserVersion: null,
  os: null,
  osVersion: null,
  deviceType: null,
};

/**
 * Browsers, most specific claim first.
 *
 * The token each one is identified by is its OWN token, not the one it borrows:
 * Edge is `Edg/`, Opera is `OPR/`, Samsung Internet is `SamsungBrowser/`. Chrome
 * has to come after all three because every one of them also carries `Chrome/`,
 * and Safari after Chrome because Chrome carries `Safari/` too.
 */
const BROWSERS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['Edge', /\bEdg(?:e|iOS|A)?\/([\d.]+)/],
  ['Opera', /\bOPR\/([\d.]+)/],
  ['Samsung Internet', /\bSamsungBrowser\/([\d.]+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/],
  // Chrome on iOS is `CriOS`, and is really Safari's engine wearing Chrome's
  // name. Reported as Chrome anyway: the person reading this screen recognises
  // the app on the phone, not the engine underneath it.
  ['Chrome', /\b(?:Chrome|CriOS|Chromium)\/([\d.]+)/],
  // Safari puts its marketing version in `Version/` and its engine build in
  // `Safari/`. The first is the number a human recognises.
  ['Safari', /\bVersion\/([\d.]+).*\bSafari\//],
];

/**
 * Operating systems, most specific first for the same reason.
 *
 * Android must be tested before Linux (every Android agent says `Linux`), and
 * iPadOS before macOS (an iPad has claimed to be a Mac since iPadOS 13, which is
 * why the tablet test below leans on touch support rather than the OS name).
 */
const OSES: ReadonlyArray<readonly [name: string, pattern: RegExp, version?: RegExp]> = [
  ['Android', /\bAndroid\b/, /\bAndroid\s+([\d.]+)/],
  ['iOS', /\b(?:iPhone|iPod)\b/, /\bOS\s+([\d_]+)/],
  ['iPadOS', /\biPad\b/, /\bOS\s+([\d_]+)/],
  ['Windows', /\bWindows\b/, /\bWindows NT\s+([\d.]+)/],
  ['macOS', /\bMac OS X\b|\bMacintosh\b/, /\bMac OS X\s+([\d_]+)/],
  ['ChromeOS', /\bCrOS\b/, /\bCrOS\s+\S+\s+([\d.]+)/],
  ['Linux', /\bLinux\b|\bX11\b/],
];

/**
 * `Windows NT 10.0` is not a version anybody recognises.
 *
 * The NT numbers are translated to the names on the box because "Windows 10" is
 * what a person reading a security screen can act on. 10.0 covers both Windows
 * 10 and 11 — Microsoft never bumped it, and the user agent genuinely cannot
 * tell them apart, so it is reported as the pair rather than guessed at.
 */
const WINDOWS_NAMES: Record<string, string> = {
  '10.0': '10 / 11',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
};

/**
 * Automated clients.
 *
 * Worth its own class rather than 'unknown': a bot user agent on a login session
 * is not a device somebody is sitting at, and an admin scanning the list should
 * see that immediately. In practice these arrive from uptime monitors and
 * security scanners rather than from staff.
 */
const BOT = /\b(bot|crawler|spider|crawling|headless|phantomjs|puppeteer|playwright|curl|wget|python-requests|axios|okhttp)\b/i;

/** Underscored Apple versions ('17_4_1') read as dotted ones. */
function dot(version: string | undefined): string | null {
  return version ? version.replace(/_/g, '.') : null;
}

/**
 * Desktop, mobile, tablet or bot.
 *
 * The tablet test is the awkward one and cannot be done from the OS name. An
 * iPad has identified itself as a Mac since iPadOS 13, so the only signal left
 * is that it is a Mac claiming touch support — which no real Mac does. Android
 * tablets are the inverse: an Android agent WITHOUT `Mobile` is a tablet, since
 * Android puts `Mobile` on phones only.
 */
function classify(ua: string): LoginDeviceType {
  if (BOT.test(ua)) return 'bot';

  if (/\biPad\b/.test(ua)) return 'tablet';
  if (/\bMacintosh\b/.test(ua) && /\bTouch\b/i.test(ua)) return 'tablet';
  if (/\bTablet\b/i.test(ua)) return 'tablet';
  if (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua)) return 'tablet';

  if (/\b(Mobi|Mobile|iPhone|iPod|Windows Phone)\b/.test(ua)) return 'mobile';
  if (/\b(Windows|Macintosh|Mac OS X|CrOS|X11|Linux)\b/.test(ua)) return 'desktop';

  return 'unknown';
}

/**
 * Parse one user agent. Never throws; an absent or unrecognised string yields
 * nulls, which the UI renders as em dashes.
 *
 * The length guard is not paranoia about parsing cost — these regexes are linear
 * — but about what gets stored. A user agent is an unvalidated header, and
 * without a cap a client could push an arbitrarily long string through into
 * five text columns on every login.
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua || typeof ua !== 'string') return EMPTY;
  const s = ua.slice(0, 1024);

  let browser: string | null = null;
  let browserVersion: string | null = null;
  for (const [name, pattern] of BROWSERS) {
    const m = pattern.exec(s);
    if (m) {
      browser = name;
      // Major version only. '140' is the number anyone quotes, compares or
      // remembers; '140.0.7339.186' is a build id that makes the column
      // unreadable at a glance and never gets read to the end.
      browserVersion = m[1]?.split('.')[0] ?? null;
      break;
    }
  }

  let os: string | null = null;
  let osVersion: string | null = null;
  for (const [name, pattern, versionPattern] of OSES) {
    if (!pattern.test(s)) continue;
    os = name;
    const raw = versionPattern ? dot(versionPattern.exec(s)?.[1]) : null;
    osVersion = name === 'Windows' && raw ? (WINDOWS_NAMES[raw] ?? raw) : raw;
    break;
  }

  return { browser, browserVersion, os, osVersion, deviceType: classify(s) };
}

/**
 * 'Chrome 140 on Windows 10 / 11' — the one-line spelling for a table cell.
 *
 * Built from the PARSED columns rather than re-reading the raw agent, so the
 * summary and the individual fields can never disagree. Degrades a piece at a
 * time: a known browser on an unknown OS still reads usefully.
 */
export function describeDevice(parsed: ParsedUserAgent): string {
  const browser = [parsed.browser, parsed.browserVersion].filter(Boolean).join(' ');
  const os = [parsed.os, parsed.osVersion].filter(Boolean).join(' ');
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}
