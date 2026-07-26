import { supabaseAdmin } from '../config/supabase';
import { getAppSettings } from './settings.service';
import { getMessageProvider, getRetryPolicy, sendWithRetry, type OutboundChannel } from './messaging';
import { money } from './closing-report.service';
import { toE164 } from '../utils/phone';

const LOGS = 'notification_logs';

/**
 * Confirmations always go over SMS, never WhatsApp.
 *
 * Meta only permits PRE-APPROVED TEMPLATE messages outside a 24-hour
 * customer-service window, and a confirmation to a customer who has never
 * messaged the business is exactly that case — Twilio would reject it with error
 * 63016. Adding WhatsApp here means registering and approving a template first;
 * until then SMS is the only channel that actually delivers. The `channel` column
 * on notification_logs already carries this, so widening it later is additive.
 */
const CONFIRMATION_CHANNEL: OutboundChannel = 'sms';

/** Postgres unique_violation — the (order_id, channel) sent-once index fired. */
const PG_UNIQUE_VIOLATION = '23505';

export interface OrderConfirmationInput {
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** As captured on the order — any local format; normalised here. */
  customerPhone: string | null | undefined;
  branchName: string;
  grandTotal: number;
  /**
   * 'order' — placed and queued for production, the customer is waiting on it.
   * 'sale'  — completed at the counter (POS); the message is a receipt, not a promise.
   */
  kind: 'order' | 'sale';
}

export interface OrderConfirmationResult {
  sent: boolean;
  /** Present when nothing was sent; explains why, for the caller's log line. */
  skipped?: string;
  error?: string;
}

/**
 * Text the customer their order confirmation. Best-effort and NEVER throws — a
 * messaging failure must not roll back or 500 an order that is already committed
 * to the database.
 *
 * Every outcome that involved a real send attempt lands in notification_logs
 * (status 'sent' or 'failed', keyed by order_id), so the admin log view shows
 * order confirmations alongside the nightly closing summaries.
 */
export async function sendOrderConfirmation(input: OrderConfirmationInput): Promise<OrderConfirmationResult> {
  try {
    const settings = await getAppSettings();
    if (!settings.orderConfirmationsEnabled) {
      return { sent: false, skipped: 'orderConfirmationsEnabled is off' };
    }

    // No phone at all is the normal case for a walk-in who did not give one —
    // silently nothing to do, and nothing worth logging.
    const raw = (input.customerPhone || '').trim();
    if (!raw) return { sent: false, skipped: 'no customer phone on the order' };

    // A phone that IS present but cannot be parsed is a data problem the admin
    // should see, so it gets a failed log row rather than a silent skip.
    const to = toE164(raw);
    if (!to) {
      await writeLog(input.orderId, 'failed', 'none', null, `Unusable phone number "${raw}" — not E.164-normalisable`, 0);
      return { sent: false, error: `unusable phone number "${raw}"` };
    }

    // Sent-once guard. The unique index on (order_id, channel) where status='sent'
    // enforces this at the database, but that only fires on the INSERT — i.e.
    // after the message has been sent and billed. Checking first is what actually
    // prevents the duplicate SMS; the index is the backstop for a race.
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from(LOGS)
      .select('id')
      .eq('order_id', input.orderId)
      .eq('channel', CONFIRMATION_CHANNEL)
      .eq('status', 'sent')
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (prior) return { sent: false, skipped: 'confirmation already sent for this order' };

    const provider = getMessageProvider();
    const policy = getRetryPolicy();
    const body = formatOrderConfirmation(input, settings.companyName || 'Mountain Bakes', settings.currencySymbol || 'Rs.');

    const result = await sendWithRetry(
      () => provider.send({ to, body, channel: CONFIRMATION_CHANNEL }),
      policy.maxAttempts,
      policy.baseDelayMs,
    );

    await writeLog(
      input.orderId,
      result.ok ? 'sent' : 'failed',
      provider.name,
      result.messageId ?? null,
      result.error ?? null,
      result.attempts - 1,
    );

    if (!result.ok) {
      console.warn(`[order-notify] ${input.orderNumber} → ${to}: ${result.error} (provider=${provider.name}, attempts=${result.attempts})`);
      return { sent: false, error: result.error ?? 'send failed' };
    }

    console.log(`[order-notify] ${input.orderNumber} → ${to}: sent (provider=${provider.name}).`);
    return { sent: true };
  } catch (err) {
    // Last resort. The order itself is already saved and the response already
    // sent; this can only be reported, never propagated.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[order-notify] ${input.orderNumber}: confirmation threw — ${detail}`);
    return { sent: false, error: detail };
  }
}

/**
 * The message body.
 *
 * Deliberately short. SMS bills per 160-character GSM-7 segment, and every
 * character here is plain ASCII (the "Rs." symbol included) so a confirmation
 * stays one segment; a single non-GSM character — a curly quote, an emoji, an
 * en-dash — would silently switch the whole message to UCS-2 and cut the limit to
 * 70, doubling the cost of every send. Keep it ASCII.
 */
export function formatOrderConfirmation(
  input: Pick<OrderConfirmationInput, 'orderNumber' | 'customerName' | 'branchName' | 'grandTotal' | 'kind'>,
  companyName = 'Mountain Bakes',
  symbol = 'Rs.',
): string {
  const name = (input.customerName || '').trim();
  // 'Walking Customer' is the POS placeholder for an anonymous walk-in, not a
  // person — addressing someone by it would read as a bug on their phone.
  const greeting = name && name.toLowerCase() !== 'walking customer' ? `${name}, ` : '';

  // Branch names are free text and some carry trailing whitespace ('Committee
  // Chowk '), which would render as 'Committee Chowk .' mid-sentence.
  const branch = (input.branchName || '').trim();

  const sentence = input.kind === 'sale'
    ? `thank you for your purchase at ${branch}.`
    : `your order is confirmed at ${branch}.`;
  // With no greeting the sentence starts the line, so it has to carry the capital.
  const lead = greeting
    ? greeting + sentence
    : sentence.charAt(0).toUpperCase() + sentence.slice(1);

  const tail = input.kind === 'sale'
    ? 'Thank you.'
    : 'We will notify you when it is ready.';

  return [
    companyName.trim(),
    lead,
    `Order: ${input.orderNumber.trim()}`,
    // money() inserts its own space after the symbol, and the stored symbol is
    // often 'Rs. ' with a trailing one — which lands as 'Rs.  1,600'. Trimming
    // here rather than in money() keeps the nightly closing summaries byte-identical.
    `Total: ${money(input.grandTotal, symbol.trim())}`,
    tail,
  ].join('\n');
}

/**
 * Record one delivery attempt. Best-effort: a log write must not be able to turn
 * a successfully delivered SMS into a thrown error upstream.
 */
async function writeLog(
  orderId: string,
  status: 'sent' | 'failed',
  provider: string,
  providerMessageId: string | null,
  errorMessage: string | null,
  retryCount: number,
): Promise<void> {
  const { error } = await supabaseAdmin.from(LOGS).insert({
    order_id: orderId,
    // Null on purpose: these two point at the daily-closing tables, which an
    // order confirmation has nothing to do with (see migration 32).
    report_id: null,
    recipient_id: null,
    business_date: null,
    channel: CONFIRMATION_CHANNEL,
    status,
    provider,
    provider_message_id: providerMessageId,
    error_message: errorMessage,
    retry_count: retryCount,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
  });

  if (error) {
    // The sent-once index rejecting a second 'sent' row is the guard doing its
    // job under a race, not a fault — the customer got exactly one message.
    if (error.code === PG_UNIQUE_VIOLATION) return;
    console.error('[order-notify] failed to write notification log:', error.message);
  }
}
