import dotenv from 'dotenv';

// Load local env (server/.env) for development. On hosts (Heroku/etc.) the real
// environment variables are already present and take precedence — dotenv only
// fills gaps. This MUST run before ./src/app is loaded, because modules read
// their configuration from env at import time; the dynamic import below
// guarantees that ordering.
dotenv.config();

/**
 * Fail fast, and legibly, on an unsupported Node version. package.json pins
 * 24.x; the generated Prisma client and `tsx` are only run on that line here.
 * The nvm default alias is not enough on its own: sourcing nvm.sh does not apply
 * it, so a stale PATH can still hand this process Node 20.
 */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(
    `[server] Node ${process.versions.node} is too old — this API needs Node 24.\n` +
      `         Run 'nvm use' in this terminal (server/.nvmrc pins 24), or open a new shell.`
  );
  process.exit(1);
}

/**
 * Refuse to start without what no request can be served without: a database
 * to read, and a key to sign people in with. A server missing either would
 * boot, pass its health check and then fail every screen — and a missing
 * signing key in particular looks, from outside, like everyone's password
 * being wrong.
 */
function assertConfigured() {
  const problems: string[] = [];
  if (!(process.env.DATABASE_URL || '').trim()) {
    problems.push('DATABASE_URL is not set — the Postgres connection the API serves from');
  }
  if ((process.env.JWT_SECRET || '').length < 32) {
    problems.push('JWT_SECRET is not set (or is shorter than 32 characters) — the key the API signs access tokens with');
  }
  // Photos and the logo. Several everyday screens sign photo URLs as they load
  // (production orders, special orders), so a live server without this fails
  // them outright; a developer's machine may well have no bucket, and is told.
  const files: string[] = [];
  if (!(process.env.FILES_S3_BUCKET || '').trim()) files.push('FILES_S3_BUCKET is not set — the S3 bucket uploaded photos and the logo are kept in');
  if (!/^https?:\/\/[^/]+\/?$/.test((process.env.PUBLIC_API_URL || '').trim())) {
    files.push("PUBLIC_API_URL is not set to this API's public origin — the logo is served from it");
  }
  if (process.env.NODE_ENV === 'production') problems.push(...files);
  else if (files.length > 0) console.warn(`[server] file storage is not configured; screens that show photos will fail:\n  - ${files.join('\n  - ')}`);

  if (problems.length > 0) {
    console.error(`[server] cannot start:\n  - ${problems.join('\n  - ')}\n         See .env.example.`);
    process.exit(1);
  }
}

async function main() {
  assertConfigured();
  const { app, allowedOrigins } = await import('./src/app');

  // ─── Schedulers: intentionally left OFF for now ─────────────────────────────
  // The two 2:00 AM Karachi jobs (daily closing + price activation) are ported
  // and ready, but kept disabled until their SQL functions are applied to the
  // database and the jobs are deliberately turned back on. Re-enable each import
  // together with its call below.
  //
  // Special Events reminders (09:00) + maintenance (02:30) are the same deal.
  // Until they are armed, event reminders are delivered by the admin pressing
  // "Send due reminders now" on the Special Events screen, which calls
  // POST /api/special-events/notifications/dispatch — a manual trigger, which
  // deliberately bypasses the eventNotificationsEnabled toggle.
  //
  // const { startDailyClosingScheduler } = await import('./src/scheduler/daily-closing.job');
  // const { startPriceActivationScheduler } = await import('./src/scheduler/price-activation.job');
  // const { startEventNotificationScheduler } = await import('./src/scheduler/event-notifications.job');
  // const { activateDuePrices } = await import('./src/services/price.service');

  // Hosts inject the port via PORT; fall back to API_PORT for local dev. Bind
  // 0.0.0.0 so the container/dyno is reachable externally.
  const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mountain Bakes API listening on port ${PORT}`);
    console.log('[cors] Allowed origins:', allowedOrigins.join(', ') || '(none configured)');
    console.warn('[scheduler] Daily closing, price activation and event reminders are OFF. The 2:00 AM close will not run until re-enabled.');
    // Arm the 2:00 AM Karachi end-of-day closing (idempotent; respects Auto Close).
    // startDailyClosingScheduler();
    // Arm 2:00 AM future-dated price activation + catch up any missed run on boot.
    // startPriceActivationScheduler();
    // Arm 09:00 event reminders + 02:30 estimate refresh / roll-forward.
    // startEventNotificationScheduler();
    // activateDuePrices({ trigger: 'startup' }).catch((err) => console.error('[price-activation] startup catch-up threw:', err));
    if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
      console.warn(
        '[cors] CORS_ORIGINS is not set — only localhost is allowed. Set it to your ' +
          'deployed web origin (e.g. https://mountain-bakes-web.herokuapp.com) or the browser will block requests.'
      );
    }
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
