import { dbFor, disconnectPrisma } from '../db';
import { setPassword, signOutEverywhere } from '../services/auth/auth.service';
import { mirroring } from '../services/auth/gotrue-mirror';
import { ownAuthConfigured } from '../services/auth/tokens';
import { generateTempPassword } from '../utils/password';

/**
 * Break-glass: give one account a temporary password from the server.
 *
 *   pnpm auth:set-password someone@example.com
 *
 * For the case nothing in the app can fix — the only administrator has
 * forgotten their password and email is not set up, so there is nobody to
 * reset it and no link to send. Whoever can run commands on the server can
 * run this.
 *
 * It sets a random temporary password, prints it ONCE, marks the account as
 * having to choose a new one at next sign-in, and signs it out everywhere. It
 * does not reactivate a deactivated account, and it refuses one that does not
 * exist rather than creating it.
 */
async function main() {
  const email = (process.argv[2] || '').trim();
  if (!email || !email.includes('@')) throw new Error('Usage: pnpm auth:set-password <email>');
  if (!ownAuthConfigured() && !mirroring()) {
    throw new Error('Neither sign-in is configured here (no JWT_SECRET, and AUTH_GOTRUE_MIRROR=false): there is nowhere to set a password.');
  }

  const { data: user, error } = await dbFor('scripts')
    .from('users')
    .select('id, email, role, status')
    .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
    .maybeSingle();
  if (error) throw error;
  if (!user) throw new Error(`No account has the email ${email}`);

  const password = generateTempPassword();
  await setPassword(user.id, password, { mustChange: true });
  await signOutEverywhere(user.id);

  console.log(`Account:            ${user.email} (${user.role}, ${user.status})`);
  console.log(`Temporary password: ${password}`);
  console.log('It must be changed at the next sign-in. It is not stored anywhere readable and will not be shown again.');
  if (user.status !== 'active') console.log('NOTE: this account is not active and still cannot sign in.');
  if (!ownAuthConfigured()) console.log('NOTE: JWT_SECRET is not set, so this was set in Supabase Auth only.');
}

main()
  .catch((err) => {
    console.error('[auth:set-password]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
