/**
 * Hide most of an email address while leaving it recognisable.
 *
 * WHY THE SECURITY SCREENS NEED THIS. The login history is read by people
 * looking for a device, a location or a time — not for an address. Printing
 * every staff email in a table that is open on a shop-floor tablet spreads the
 * one piece of the credential pair that is otherwise never displayed, to an
 * audience that has no use for it. The staff code (`MBU-000125`) identifies the
 * account for every purpose that list serves, so the address is masked by
 * default and shown in full only where an admin has deliberately opened a detail
 * view.
 *
 * IT IS NOT ENCRYPTION AND NOT A SECRET-KEEPER. Someone who already knows the
 * address recognises it masked — that is the point, so an admin can confirm
 * "yes, that is the account I mean". It removes the address from casual view and
 * from a screenshot; it does not remove it from someone determined to work it
 * out, and it must never be relied on as if it did. The real protection is the
 * route deciding who may call the detail endpoint at all.
 */

/**
 * `arif.hussain@example.com` → `a***@example.com`.
 *
 * The domain is left intact deliberately. It is shared by every account in the
 * company, so it identifies nobody, and keeping it is what lets an admin spot
 * the genuinely interesting case: a session on an address that is not one of
 * ours at all.
 *
 * A local part of one or two characters is masked to a fixed `***` rather than
 * revealing its only letter — otherwise the shortest addresses, which are the
 * easiest to guess, would be the ones given away.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';

  const at = email.lastIndexOf('@');
  // No '@' means this is not an address — a legacy row, or a Finance User ID
  // that never resolved. Mask the whole thing rather than returning it intact:
  // an unrecognised value is exactly the one whose sensitivity is unknown.
  if (at <= 0) return '***';

  const local = email.slice(0, at);
  const domain = email.slice(at);

  if (local.length <= 2) return `***${domain}`;
  return `${local[0]}***${domain}`;
}
