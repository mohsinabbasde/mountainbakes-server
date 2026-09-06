import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  LoginAttemptsQuerySchema,
  RecordLoginAttemptSchema,
  type LoginAttemptFilters,
} from '../shared';
import { clientIp } from '../services/geofence.service';
import { listAttempts, recordAttempt } from '../services/login-attempts.service';

export const router = Router();

/**
 * Failed sign-ins.
 *
 * THE ONE ROUTER IN THIS API WITH AN UNAUTHENTICATED WRITE, and the reason is
 * structural rather than a shortcut. The app is a static export that
 * authenticates against Supabase directly, so the API is never in the request
 * path of a login — and a login that FAILED produces no token, so there is
 * nothing for the browser to authenticate the report with. Either the failures
 * go unrecorded, or they are reported by an anonymous call. They are worth
 * recording: a burst of refusals nobody can explain is the single most useful
 * signal a security screen carries, and it was the one thing the Login History
 * could not show.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Anybody who can reach this API can write rows
 * describing attempts that never happened, against any address they choose. The
 * mitigations are deliberately modest and are not pretending to be more:
 *
 *   * Two rate limits — one per origin and one global ceiling that no header can
 *     move — both well below anything a person mistyping a password reaches and
 *     well below the volume needed to bury a real burst in noise.
 *   * A body with exactly two fields, one of them a closed enum. Everything else
 *     on the stored row — IP, user agent, resolved city, business date — comes
 *     from the request headers or the server.
 *   * Nothing in the app reads these rows to make a decision. No lockout, no
 *     flag on an account, no input to authorisation. They are shown to an admin,
 *     who is told in the UI that they are client-reported.
 *
 * The third is the important one. A forgeable table wired to a lockout would be
 * a denial-of-service tool with an admin screen attached; a forgeable table that
 * only a person reads is a noticeboard somebody could scribble on, which is a
 * far smaller problem than having no noticeboard.
 *
 * READING is the opposite posture: authenticated, and super admin only. The list
 * is every address that has been typed into the login form, which includes
 * mistyped personal addresses and the addresses of people who no longer work
 * here — not something to hand to every signed-in account.
 */

/**
 * TWO LIMITS, because one of them can be walked around.
 *
 * PER ORIGIN. Twenty in ten minutes. A person who has genuinely forgotten their
 * password tries three or four times and then uses the reset link, so twenty is
 * generous enough that no honest user meets it and low enough that the table
 * cannot be filled from one place.
 *
 * The key is `clientIp()` — the same function that decides what gets STORED on
 * the row — and not `req.ip`. The API sits behind a platform proxy and
 * `trust proxy` is deliberately not set on this app, so `req.ip` is the proxy's
 * address and every request in the world would share a single bucket: the limit
 * would fire for everybody the moment one person mistyped a password twenty
 * times. Reading the forwarded chain is what makes "per origin" mean anything
 * here.
 *
 * That chain is a HEADER, so a caller who sets it themselves can present a fresh
 * origin per request and defeat this limit entirely. That is not a hole this
 * endpoint can close — it is the same header the stored `ip_address` comes from,
 * and an unauthenticated endpoint has nothing better to key on — which is
 * exactly why there is a second limit below it.
 *
 * GLOBALLY. Three hundred in ten minutes across every caller, keyed on a
 * constant so no header can move it. Far above anything a company of this size
 * produces honestly, and a hard ceiling on how fast this table can grow however
 * the first limit is dodged. It is the one that holds when the other does not.
 *
 * `skipSuccessfulRequests` is deliberately NOT set on either: every accepted
 * report counts, because the accepted ones are what write rows and the rows are
 * what these limits exist to bound.
 *
 * `validate.xForwardedForHeader` is off because express-rate-limit's check
 * exists to catch precisely the misconfiguration reasoned about above — a
 * forwarded header read without `trust proxy`. That is deliberate here, and the
 * warning would otherwise be printed on every boot.
 */
const LIMIT_WINDOW_MS = 10 * 60 * 1000;

const perOriginLimiter = rateLimit({
  windowMs: LIMIT_WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    clientIp(req.headers as unknown as Record<string, unknown>, req.ip) ?? 'unknown',
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many attempts recorded from this address' },
});

const globalLimiter = rateLimit({
  windowMs: LIMIT_WINDOW_MS,
  max: 300,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => 'global',
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many attempts recorded' },
});

/**
 * POST /api/login-attempts — record a sign-in that was refused.
 *
 * ANSWERS 204 WHATEVER HAPPENS, including on a database failure. The caller is a
 * login page that has just shown somebody an authentication error; a second
 * error about the bookkeeping is noise about a problem they cannot act on, and a
 * client that retried on it would double the write it just failed to make. The
 * failure is logged server-side, which is where somebody can do something about
 * it.
 *
 * NO TOKEN, and none is read even if one is sent — see the router note.
 */
router.post('/', globalLimiter, perOriginLimiter, validate(RecordLoginAttemptSchema), async (req, res) => {
  const { email, reason } = req.body as { email: string; reason: Parameters<typeof recordAttempt>[0]['reason'] };
  const headers = req.headers as unknown as Record<string, unknown>;

  try {
    await recordAttempt({
      email,
      reason,
      ipAddress: clientIp(headers, req.ip),
      userAgent: typeof headers['user-agent'] === 'string' ? (headers['user-agent'] as string) : null,
    });
  } catch (err) {
    console.error('[login-attempts] record failed', err);
  }
  res.status(204).end();
});

/**
 * GET /api/login-attempts — the failed-sign-in log, filtered and paged.
 *
 * Super admin only. Unlike the login history — which is scoped to the caller's
 * own sessions for everybody else and is safe to put on a personal dashboard —
 * there is no useful per-user view of this: a non-admin's own failed attempts
 * tell them what they already know, and everybody else's are none of their
 * business. So the endpoint is not scoped, it is refused.
 */
router.get(
  '/',
  authenticate,
  requireRole('super_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = LoginAttemptsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation error',
          details: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      const q = parsed.data;

      const filters: LoginAttemptFilters = {
        search: q.search ?? null,
        reason: q.reason ?? null,
        country: q.country ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      };

      res.json(await listAttempts({ filters, page: q.page, pageSize: q.pageSize }));
    } catch (err) {
      next(err);
    }
  },
);
