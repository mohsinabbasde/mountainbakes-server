import type { MessageProvider, SendResult } from './provider';
import { LogProvider } from './log.provider';
import { TwilioProvider } from './twilio.provider';

export type { MessageProvider, OutboundMessage, OutboundChannel, SendResult } from './provider';
export { LogProvider } from './log.provider';
export { TwilioProvider } from './twilio.provider';

/** Retry policy for a failed send, from env with sane defaults. */
export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Base delay; attempt N waits baseDelayMs * N (linear backoff). */
  baseDelayMs: number;
}

export function getRetryPolicy(): RetryPolicy {
  const maxAttempts = Number(process.env.NOTIFICATION_RETRY_MAX || 3);
  const baseDelayMs = Number(process.env.NOTIFICATION_RETRY_DELAY_MS || 2000);
  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 3,
    baseDelayMs: Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? Math.floor(baseDelayMs) : 2000,
  };
}

/** The outcome of `sendWithRetry`: a SendResult plus how many tries it took. */
export interface RetriedSendResult extends SendResult {
  /** Attempts actually made, including the first. `attempts - 1` is the retry count. */
  attempts: number;
}

/**
 * Run a send under the given retry policy. Never throws — a provider that throws
 * is folded into { ok:false } exactly like one that returns it, so a caller in a
 * delivery loop (nightly closing fan-out, order confirmation) can log the failure
 * and carry on rather than aborting the run.
 *
 * Backoff is linear: attempt N waits baseDelayMs * N.
 */
export async function sendWithRetry(
  op: () => Promise<SendResult>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<RetriedSendResult> {
  let last: SendResult = { ok: false, error: 'not attempted' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await op();
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (last.ok) return { ...last, attempts: attempt };
    if (attempt < maxAttempts && baseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  return { ...last, attempts: maxAttempts };
}

let cached: MessageProvider | null = null;

/**
 * Resolve the configured provider.
 *
 * NOTIFICATION_PROVIDER selects explicitly ('twilio' | 'log'); with it unset we
 * auto-detect — Twilio if its credentials are present, otherwise the log
 * provider. Falling back to `log` (rather than throwing) is deliberate: a missing
 * credential must never take down the nightly closing job, and every attempt is
 * still recorded in notification_logs so the gap is visible.
 */
export function getMessageProvider(): MessageProvider {
  if (cached) return cached;

  const configured = (process.env.NOTIFICATION_PROVIDER || '').trim().toLowerCase();

  if (configured === 'log') {
    cached = new LogProvider();
    return cached;
  }

  if (configured === 'twilio' || configured === '') {
    const twilio = TwilioProvider.fromEnv();
    if (twilio) {
      cached = twilio;
      return cached;
    }
    if (configured === 'twilio') {
      console.warn('[messaging] NOTIFICATION_PROVIDER=twilio but TWILIO_* env is incomplete — falling back to the log provider.');
    }
  } else {
    console.warn(`[messaging] Unknown NOTIFICATION_PROVIDER "${configured}" — falling back to the log provider.`);
  }

  cached = new LogProvider();
  return cached;
}

/** Test seam: drop the memoised provider so env changes take effect. */
export function resetMessageProvider(): void {
  cached = null;
}
