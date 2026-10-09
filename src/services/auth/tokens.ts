import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * The two tokens a signed-in client holds.
 *
 * THE ACCESS TOKEN is a JWT the API signs itself. It says who (`sub`) and which
 * signed-in device (`sid`), and nothing else — deliberately not the role or the
 * branch. Those are read from the database on every request, so changing
 * someone's role or deactivating them takes effect on their next click rather
 * than whenever their token happens to expire. It is short-lived because it
 * cannot be recalled: ending a session stops the NEXT token being issued.
 *
 * THE REFRESH TOKEN is 32 random bytes with no meaning of its own. It is what
 * the client exchanges for a new access token, and each one works once. Only
 * its SHA-256 is stored, so the database never holds anything a thief could
 * present.
 */

/** Marks a token as one of ours; Supabase's say `https://<project>.supabase.co/auth/v1`. */
const ISSUER = 'mb-api';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** A device unused for this long has to sign in again. */
export const SESSION_IDLE_DAYS = 60;

/**
 * How long after a refresh token is spent it may be presented once more without
 * that being treated as theft. Two tabs waking together, or a response lost on
 * a bad connection and the request retried, both send the same token twice
 * within moments of each other.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

function secret(): string {
  const value = process.env.JWT_SECRET || '';
  if (value.length < 32) {
    throw new Error('JWT_SECRET is not set (or is shorter than 32 characters) — the key the API signs access tokens with');
  }
  return value;
}

/** Whether the API can issue and check its own tokens at all. */
export function ownAuthConfigured(): boolean {
  return (process.env.JWT_SECRET || '').length >= 32;
}

export function signAccessToken(userId: string, sessionId: string): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  const token = jwt.sign({ sid: sessionId, exp: expiresAt }, secret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: userId,
  });
  return { token, expiresAt };
}

/** Who a token belongs to, or null if it is not a valid, unexpired token of ours. */
export function verifyAccessToken(token: string): { userId: string; sessionId: string } | null {
  try {
    // The algorithm is pinned: a token that names another one (or `none`) is
    // rejected rather than verified on its own terms.
    const claims = jwt.verify(token, secret(), { algorithms: ['HS256'], issuer: ISSUER });
    if (typeof claims === 'string' || typeof claims.sub !== 'string' || typeof claims['sid'] !== 'string') return null;
    return { userId: claims.sub, sessionId: claims['sid'] };
  } catch {
    return null;
  }
}

/**
 * Whether a token CLAIMS to be ours. Read without verifying, and used for one
 * thing only: deciding which of the two verifiers to hand it to while Supabase
 * tokens are still accepted. Nothing is trusted on the strength of it.
 */
export function looksLikeOwnToken(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown }).iss === ISSUER;
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new random token for the client, and the hash of it to store. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
