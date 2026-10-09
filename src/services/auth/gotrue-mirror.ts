import { createClient } from '@supabase/supabase-js';

/**
 * Supabase Auth, kept in step while both sign-in paths are live.
 *
 * During the move, an account can be signed in to in two ways: an app that has
 * been updated signs in to this API; one that has not still signs in to
 * Supabase Auth and shows the API that token. For both to keep working, the
 * things an administrator changes — a password, a role, a branch, whether the
 * account is active at all — have to land in both places. The API's own tables
 * are the record; this file is the copy sent to Supabase.
 *
 *   AUTH_GOTRUE_MIRROR=true    (the default) mirror every change
 *   AUTH_GOTRUE_MIRROR=false   Supabase Auth is gone; every function here is a
 *                              no-op and config/supabase.ts is never loaded
 *
 * Everything Supabase-shaped about accounts is in this one file, so that
 * removing it at the end is deleting a file and its call sites.
 */

export function mirroring(): boolean {
  return (process.env.AUTH_GOTRUE_MIRROR ?? 'true').trim().toLowerCase() !== 'false';
}

function admin() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supabaseAdmin } = require('../../config/supabase') as typeof import('../../config/supabase');
  return supabaseAdmin.auth.admin;
}

export interface MirroredClaims {
  role?: string;
  branchId?: string | null;
  branchName?: string | null;
  mustChangePassword?: boolean;
}

/**
 * Create the Supabase Auth user and return its id — which becomes the id of the
 * `users` row, because `users.id` is still a foreign key to it. Returns null
 * when not mirroring: the caller then chooses the id itself.
 */
export async function mirrorCreateUser(input: {
  email: string;
  password: string;
  displayName: string;
  claims: MirroredClaims;
}): Promise<string | null> {
  if (!mirroring()) return null;
  const { data, error } = await admin().createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { displayName: input.displayName },
    app_metadata: input.claims,
  });
  if (error || !data.user) throw error ?? new Error('Failed to create user');
  return data.user.id;
}

export async function mirrorDeleteUser(userId: string): Promise<void> {
  if (!mirroring()) return;
  const { error } = await admin().deleteUser(userId);
  if (error) throw error;
}

/** Merge a patch onto the user's existing app_metadata; the other claims are kept. */
export async function mirrorClaims(userId: string, patch: MirroredClaims): Promise<void> {
  if (!mirroring()) return;
  const { data, error } = await admin().getUserById(userId);
  if (error || !data.user) throw error ?? new Error('User not found');
  const { error: updErr } = await admin().updateUserById(userId, {
    app_metadata: { ...(data.user.app_metadata ?? {}), ...patch },
  });
  if (updErr) throw updErr;
}

export async function mirrorPassword(userId: string, password: string): Promise<void> {
  if (!mirroring()) return;
  const { error } = await admin().updateUserById(userId, { password });
  if (error) throw error;
}

export async function mirrorDisplayName(userId: string, displayName: string): Promise<void> {
  if (!mirroring()) return;
  const { error } = await admin().updateUserById(userId, { user_metadata: { displayName } });
  if (error) throw error;
}

/** Supabase Auth has no "inactive": an account is kept out by banning it for a century. */
export async function mirrorActive(userId: string, active: boolean): Promise<void> {
  if (!mirroring()) return;
  const { error } = await admin().updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
  if (error) throw error;
}

/**
 * Whether Supabase Auth accepts this password — asked only when the API's own
 * copy of the hash does not match, to catch a password that was changed through
 * an app that has not been updated yet (it tells Supabase, not us).
 *
 * A throwaway client, so the session this creates never touches the shared
 * service-role client; it is signed straight back out.
 */
export async function mirrorAcceptsPassword(email: string, password: string): Promise<boolean> {
  if (!mirroring()) return false;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return false;
    await client.auth.signOut().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
