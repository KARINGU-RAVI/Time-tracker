import { Router, type NextFunction, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '../errors';
import { asyncHandler } from '../http';
import type { Authenticator } from '../auth';
import type { GoogleVerifier } from '../google';
import { clearSessionCookie, readSessionToken, setSessionCookie, signSession, verifySession } from '../session';

export interface AuthConfig {
  allowedEmail: string;
  verifyGoogle: GoogleVerifier;
  sessionSecret: string;
  /** Send the cookie only over HTTPS. True in production. */
  secureCookies: boolean;
  /** The site's origin, for example https://hours.example.com. Writes from other origins are refused. */
  appOrigin?: string;
}

/** Authenticates from the signed session cookie. */
export function sessionAuthenticator(prisma: PrismaClient, secret: string): Authenticator {
  return async (req) => {
    const claims = await verifySession(readSessionToken(req), secret);
    if (!claims) return null;
    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    return user ? { id: user.id, email: user.email } : null;
  };
}

/**
 * CSRF defence for cookie sessions: a state-changing request that carries an Origin header
 * must come from our own site. (Browsers always send Origin on cross-site POSTs.)
 */
export function csrfGuard(appOrigin: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!appOrigin || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== appOrigin) {
      return next(new ApiError(403, 'BAD_ORIGIN', 'This request came from an unexpected site.'));
    }
    next();
  };
}

export function authRoutes(prisma: PrismaClient, cfg: AuthConfig, authenticate: Authenticator): Router {
  const router = Router();

  router.post(
    '/auth/google',
    asyncHandler(async (req, res) => {
      const { credential } = z.object({ credential: z.string().min(10).max(5000) }).parse(req.body);

      let identity;
      try {
        identity = await cfg.verifyGoogle(credential);
      } catch {
        throw new ApiError(401, 'INVALID_CREDENTIAL', 'Google sign-in failed. Please try again.');
      }

      // Only the one configured account, and only with a verified email, may sign in.
      if (!identity.emailVerified || identity.email.toLowerCase() !== cfg.allowedEmail.toLowerCase()) {
        throw new ApiError(403, 'ACCOUNT_NOT_ALLOWED', 'This Google account is not allowed.');
      }

      const user = await prisma.user.findUnique({ where: { email: cfg.allowedEmail.toLowerCase() } });
      if (!user) {
        throw new ApiError(409, 'NOT_CONFIGURED', 'The account is not set up yet. Run the database seed first.');
      }
      // Bind the account to one Google identity. A different Google account that later
      // claims the same email address is refused.
      if (user.googleSub && user.googleSub !== identity.sub) {
        throw new ApiError(403, 'ACCOUNT_NOT_ALLOWED', 'This Google account is not allowed.');
      }
      if (!user.googleSub) {
        await prisma.user.update({ where: { id: user.id }, data: { googleSub: identity.sub } });
      }

      const token = await signSession({ userId: user.id, email: user.email }, cfg.sessionSecret);
      setSessionCookie(res, token, cfg.secureCookies);
      res.json({ user: { email: user.email } });
    }),
  );

  router.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res, cfg.secureCookies);
    res.status(204).end();
  });

  router.get(
    '/auth/me',
    asyncHandler(async (req, res) => {
      const user = await authenticate(req);
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
      res.json({ user: { email: user.email } });
    }),
  );

  return router;
}
