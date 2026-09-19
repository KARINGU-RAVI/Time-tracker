import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Session handling: a signed JWT in an HttpOnly cookie.
 *  - HttpOnly: page scripts (and therefore XSS) can never read it.
 *  - SameSite=Lax + an Origin check on writes (see csrfGuard) protects against CSRF.
 *  - Secure in production so it only travels over HTTPS.
 * Changing SESSION_SECRET signs everyone out; bumping one user's sessionVersion signs out only that user.
 */

export const COOKIE_NAME = 'oht_session';
export const DEFAULT_SESSION_SECONDS = 30 * 24 * 60 * 60;

export interface SessionClaims {
  userId: string;
  email: string;
  /** Matches User.sessionVersion; a password reset bumps it and so signs out every other device. */
  version: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(
  claims: SessionClaims,
  secret: string,
  ttlSeconds = DEFAULT_SESSION_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email, v: claims.version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

/** Returns the claims, or null when the token is missing, tampered with or expired. */
export async function verifySession(token: string | undefined, secret: string): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    // Sessions issued before versions existed have no "v" and count as version 0.
    const version = typeof payload.v === 'number' ? payload.v : 0;
    return { userId: payload.sub, email: payload.email, version };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

export function setSessionCookie(res: Response, token: string, secure: boolean, maxAgeSeconds = DEFAULT_SESSION_SECONDS) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response, secure: boolean) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
