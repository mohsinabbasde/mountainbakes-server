import { z } from 'zod';

/**
 * Login History inputs.
 *
 * Note what is NOT here: email, role, branch, IP and user agent. Every one of
 * them is taken from the verified JWT or from the request headers server-side.
 * Accepting any of them from the body would let an account write a login history
 * describing somebody else.
 */

/**
 * Open a session — or carry on with the one this browser already has.
 *
 * `resumeSessionId` is what stops a page reload counting as a fresh login. The
 * client keeps the id it was given and offers it back; the server honours it
 * only if the session really belongs to the caller and is still live, and mints
 * a new one otherwise. So a stale id left in storage overnight is harmless.
 */
export const StartLoginSessionSchema = z.object({
  resumeSessionId: z.string().uuid().optional(),
});

/** Keep a session alive, or close it. Both carry only the id. */
export const LoginSessionIdSchema = z.object({
  sessionId: z.string().uuid(),
});

export type StartLoginSessionInput = z.infer<typeof StartLoginSessionSchema>;
export type LoginSessionIdInput = z.infer<typeof LoginSessionIdSchema>;
