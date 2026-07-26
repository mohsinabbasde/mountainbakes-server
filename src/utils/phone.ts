/**
 * Phone-number normalisation to E.164, for outbound SMS/WhatsApp.
 *
 * Twilio rejects anything that is not E.164 (`+` followed by country code and
 * subscriber number, 8–15 digits total) with error 21211. Numbers in this system
 * are typed by branch staff into a free-text field, so they arrive in every local
 * Pakistani shape there is — `0300-1234567`, `0300 1234567`, `92 300 1234567`,
 * `00923001234567`. This converts all of them to `+923001234567`.
 *
 * The default country code is `SMS_DEFAULT_COUNTRY_CODE` (digits only, no `+`),
 * falling back to 92 (Pakistan) to match the bakery's Asia/Karachi operation.
 *
 * Returns null when the input cannot be normalised confidently. Callers must
 * treat null as "do not send" rather than guessing — a wrong number is a message
 * delivered to a stranger, billed to the account.
 */

/** E.164 allows at most 15 digits after the `+`; the ITU minimum in practice is 8. */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

function defaultCountryCode(): string {
  const raw = (process.env['SMS_DEFAULT_COUNTRY_CODE'] || '92').replace(/\D/g, '');
  return raw || '92';
}

/**
 * Normalise a locally-formatted number to E.164, or return null.
 *
 * @param raw     the number as stored (any spacing/punctuation)
 * @param country default country code, digits only — defaults to SMS_DEFAULT_COUNTRY_CODE
 */
export function toE164(raw: string | null | undefined, country = defaultCountryCode()): string | null {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Keep whether the caller already declared an international number before
  // stripping punctuation — `+92 300…` and `92300…` are not the same claim.
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    // Already international; take it as given.
  } else if (digits.startsWith('00')) {
    // IDD prefix — `00` plays the role of `+`.
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    // National format: drop the trunk `0`, prepend the country code.
    digits = country + digits.replace(/^0+/, '');
  } else if (digits.startsWith(country)) {
    // Country code typed without a `+` or trunk zero.
  } else {
    // A bare subscriber number with no trunk zero and no country code (e.g.
    // `3001234567`). Assume the default country — the only reading that makes
    // sense for a locally-entered number.
    digits = country + digits;
  }

  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;

  return `+${digits}`;
}

/** True when `raw` can be normalised to a sendable E.164 number. */
export function isSendableNumber(raw: string | null | undefined): boolean {
  return toE164(raw) !== null;
}
