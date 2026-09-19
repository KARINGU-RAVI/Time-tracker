import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ApiError } from './errors';

export interface AuthUser {
  id: string;
  email: string;
}

/**
 * Authentication seam. Everything below only depends on this function, so
 * swapping the mechanism (Google sign-in, passkeys, ...) touches one place.
 * Return null when the request is not authenticated.
 */
export type Authenticator = (req: Request) => Promise<AuthUser | null>;

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * DEVELOPMENT AND TESTS ONLY: treats every request as the given owner.
 * createApp refuses to use this when NODE_ENV is 'production'.
 */
export function devAuthenticator(prisma: PrismaClient, email: string): Authenticator {
  return async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    return user ? { id: user.id, email: user.email } : null;
  };
}

export function requireAuth(authenticate: Authenticator) {
  return (req: Request, _res: Response, next: NextFunction) => {
    authenticate(req)
      .then((user) => {
        if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
        req.user = user;
        next();
      })
      .catch(next);
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
  return req.user;
}
