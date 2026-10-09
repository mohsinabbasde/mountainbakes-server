import bcrypt from 'bcryptjs';

/**
 * Password hashing: bcrypt, cost 10.
 *
 * The format and the cost are the ones Supabase Auth used (`$2a$10$…`), which
 * is what lets every existing hash be carried over and checked here unchanged.
 * bcryptjs is the pure-JavaScript implementation: nothing to compile on the
 * server, and its async calls yield to the event loop between rounds so a
 * sign-in does not stall the requests around it.
 */
const COST = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // A stored value that is not a bcrypt hash matches nothing.
    return false;
  }
}

/**
 * Spend the time a real check would, against a hash nobody's password matches.
 * Run when the account does not exist or has no password, so that "no such
 * user" and "wrong password" take the same time to answer and cannot be told
 * apart by a clock.
 */
let nobody: Promise<string> | null = null;

export async function burnPasswordCheck(password: string): Promise<void> {
  nobody ??= hashPassword('no account has this password');
  await verifyPassword(password, await nobody);
}
