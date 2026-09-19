import { createHash } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '../errors';
import { asyncHandler } from '../http';
import { toAuthUser, type Authenticator } from '../auth';
import { alreadyRegisteredEmail, resetEmail, verificationEmail, type EmailSender } from '../email';
import type { GoogleVerifier } from '../google';
import { dummyHash, hashPassword, PASSWORD_MESSAGES, passwordProblems, verifyPassword } from '../password';
import { enforce, pruneRateLimits, type Limit } from '../ratelimit';
import { clearSessionCookie, readSessionToken, setSessionCookie, signSession, verifySession } from '../session';
import { consumeToken, issueToken } from '../tokens';
import type { TurnstileVerifier } from '../turnstile';

export interface AuthConfig {
  verifyGoogle: GoogleVerifier;
  sessionSecret: string;
  /** Send the cookie only over HTTPS. True in production. */
  secureCookies: boolean;
  /** The site's origin, for example https://hours.example.com. Writes from other origins are refused. */
  appOrigin?: string;
  email: EmailSender;
  verifyTurnstile: TurnstileVerifier;
  /** Sign-ups stop at this many accounts so the free database cannot be filled by a flood. */
  maxAccounts: number;
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const UNVERIFIED_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Authenticates from the signed session cookie. */
export function sessionAuthenticator(prisma: PrismaClient, secret: string): Authenticator {
  return async (req) => {
    const claims = await verifySession(readSessionToken(req), secret);
    if (!claims) return null;
    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    // A password reset bumps sessionVersion, which retires every older cookie.
    if (!user || user.sessionVersion !== claims.version) return null;
    return toAuthUser(user);
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

/** Netlify sets this header itself, overwriting anything the client sent. */
export function clientIp(req: Request): string {
  const nf = req.get('x-nf-client-connection-ip');
  return nf ?? req.socket.remoteAddress ?? 'unknown';
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((e) => e.toLowerCase());

const INVALID_LOGIN = () => new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect.');

export function authRoutes(prisma: PrismaClient, cfg: AuthConfig, authenticate: Authenticator, clock: () => number): Router {
  const router = Router();

  const startSession = async (res: Response, user: User) => {
    const token = await signSession({ userId: user.id, email: user.email, version: user.sessionVersion }, cfg.sessionSecret);
    setSessionCookie(res, token, cfg.secureCookies);
  };
  const publicUser = (u: User) => ({ email: u.email, name: u.name, setupComplete: u.setupCompletedAt !== null, isAdmin: u.isAdmin });

  /** Sends mail without letting a provider failure reveal (or break) anything for the caller. */
  const trySend = async (mail: { to: string; subject: string; text: string }) => {
    try {
      await cfg.email.send(mail);
      return true;
    } catch {
      return false;
    }
  };

  const housekeeping = async (now: number) => {
    await prisma.user.deleteMany({
      where: { emailVerifiedAt: null, googleSub: null, createdAt: { lt: new Date(now - UNVERIFIED_KEEP_MS) } },
    });
    if (Math.floor(now / MIN) % 30 === 0) await pruneRateLimits(prisma, now);
  };

  const assertRoom = async () => {
    const total = await prisma.user.count();
    if (total >= cfg.maxAccounts) {
      throw new ApiError(503, 'SIGNUPS_FULL', 'Sign-ups are full right now. Please try again later.');
    }
  };

  const assertHuman = async (req: Request, token: unknown) => {
    const ok = await cfg.verifyTurnstile(typeof token === 'string' ? token : undefined, clientIp(req));
    if (!ok) throw new ApiError(400, 'BOT_CHECK_FAILED', 'The human check did not pass. Please try again.');
  };

  const assertStrong = (password: string, email?: string) => {
    const problems = passwordProblems(password, email);
    if (problems.length) {
      throw new ApiError(400, 'WEAK_PASSWORD', PASSWORD_MESSAGES[problems[0]!], {
        problems: problems.map((code) => ({ code, message: PASSWORD_MESSAGES[code] })),
      });
    }
  };

  router.post(
    '/auth/register',
    asyncHandler(async (req, res) => {
      const body = z
        .object({ email: emailSchema, password: z.string().min(1).max(1000), turnstileToken: z.string().optional() })
        .parse(req.body);
      const now = clock();
      const limits: Limit[] = [
        { key: `register:ip:${clientIp(req)}`, max: 10, windowMs: HOUR },
        { key: `register:email:${sha(body.email)}`, max: 5, windowMs: HOUR },
      ];
      await enforce(prisma, limits, now);
      await assertHuman(req, body.turnstileToken);
      assertStrong(body.password, body.email);
      await housekeeping(now);

      // Same work and the same answer whether or not the address is already registered, so the
      // form cannot be used to find out who has an account.
      const passwordHash = await hashPassword(body.password);
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) {
        await trySend({ to: body.email, ...alreadyRegisteredEmail(cfg.appOrigin ?? '') });
        res.status(202).json({ status: 'verification_sent' });
        return;
      }
      await assertRoom();
      let user: User;
      try {
        user = await prisma.user.create({ data: { email: body.email, passwordHash } });
      } catch (e) {
        // Two sign-ups for one address at the same instant: the loser gets the same neutral answer.
        if ((e as { code?: string }).code === 'P2002') {
          res.status(202).json({ status: 'verification_sent' });
          return;
        }
        throw e;
      }
      const token = await issueToken(prisma, user.id, 'VERIFY_EMAIL', now);
      const sent = await trySend({ to: user.email, ...verificationEmail(cfg.appOrigin ?? '', token) });
      if (!sent) throw new ApiError(502, 'EMAIL_FAILED', 'We could not send the verification email. Please try again in a minute.');
      res.status(202).json({ status: 'verification_sent' });
    }),
  );

  router.post(
    '/auth/resend-verification',
    asyncHandler(async (req, res) => {
      const body = z.object({ email: emailSchema, turnstileToken: z.string().optional() }).parse(req.body);
      const now = clock();
      await enforce(
        prisma,
        [
          { key: `resend:ip:${clientIp(req)}`, max: 10, windowMs: HOUR },
          { key: `resend:email:${sha(body.email)}`, max: 3, windowMs: HOUR },
        ],
        now,
      );
      await assertHuman(req, body.turnstileToken);
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (user && user.passwordHash && !user.emailVerifiedAt) {
        const token = await issueToken(prisma, user.id, 'VERIFY_EMAIL', now);
        await trySend({ to: user.email, ...verificationEmail(cfg.appOrigin ?? '', token) });
      }
      res.status(202).json({ status: 'verification_sent' });
    }),
  );

  router.post(
    '/auth/verify-email',
    asyncHandler(async (req, res) => {
      const { token } = z.object({ token: z.string().min(1).max(200) }).parse(req.body);
      const now = clock();
      await enforce(prisma, [{ key: `verify:ip:${clientIp(req)}`, max: 30, windowMs: HOUR }], now);
      const userId = await consumeToken(prisma, token, 'VERIFY_EMAIL', now);
      if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This link has expired or was already used.');
      const user = await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(now) } });
      await startSession(res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = z.object({ email: emailSchema, password: z.string().min(1).max(1000) }).parse(req.body);
      const now = clock();
      await enforce(
        prisma,
        [
          { key: `login:ip:${clientIp(req)}`, max: 30, windowMs: 15 * MIN },
          { key: `login:email:${sha(body.email)}`, max: 20, windowMs: 15 * MIN },
        ],
        now,
      );
      const user = await prisma.user.findUnique({ where: { email: body.email } });

      if (user?.lockedUntil && user.lockedUntil.getTime() > now) {
        throw new ApiError(429, 'ACCOUNT_LOCKED', 'Too many wrong passwords. Try again in a few minutes, or reset your password.', {
          retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - now) / 1000),
        });
      }
      if (!user || !user.passwordHash) {
        await verifyPassword(body.password, await dummyHash()); // same cost as a real check
        throw INVALID_LOGIN();
      }
      if (!(await verifyPassword(body.password, user.passwordHash))) {
        const failures = user.failedLogins + 1;
        await prisma.user.update({
          where: { id: user.id },
          data:
            failures >= MAX_FAILED_LOGINS
              ? { failedLogins: 0, lockedUntil: new Date(now + LOCK_MS) }
              : { failedLogins: failures },
        });
        throw INVALID_LOGIN();
      }
      if (user.failedLogins !== 0 || user.lockedUntil) {
        await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
      }
      if (!user.emailVerifiedAt) {
        throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email first.');
      }
      await startSession(res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  router.post(
    '/auth/forgot-password',
    asyncHandler(async (req, res) => {
      const body = z.object({ email: emailSchema, turnstileToken: z.string().optional() }).parse(req.body);
      const now = clock();
      await enforce(
        prisma,
        [
          { key: `forgot:ip:${clientIp(req)}`, max: 10, windowMs: HOUR },
          { key: `forgot:email:${sha(body.email)}`, max: 3, windowMs: HOUR },
        ],
        now,
      );
      await assertHuman(req, body.turnstileToken);
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (user) {
        const token = await issueToken(prisma, user.id, 'RESET_PASSWORD', now);
        await trySend({ to: user.email, ...resetEmail(cfg.appOrigin ?? '', token) });
      }
      // Identical answer whether or not the account exists.
      res.status(202).json({ status: 'reset_link_sent_if_account_exists' });
    }),
  );

  router.post(
    '/auth/reset-password',
    asyncHandler(async (req, res) => {
      const body = z.object({ token: z.string().min(1).max(200), password: z.string().min(1).max(1000) }).parse(req.body);
      const now = clock();
      await enforce(prisma, [{ key: `reset:ip:${clientIp(req)}`, max: 20, windowMs: HOUR }], now);
      // Check strength before spending the single-use token, so a typo does not burn the link.
      assertStrong(body.password);
      const userId = await consumeToken(prisma, body.token, 'RESET_PASSWORD', now);
      if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This link has expired or was already used.');
      const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: await hashPassword(body.password),
          sessionVersion: { increment: 1 }, // signs out every other device
          failedLogins: 0,
          lockedUntil: null,
          // Following the emailed link proves they own the address.
          emailVerifiedAt: current.emailVerifiedAt ?? new Date(now),
        },
      });
      await startSession(res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  router.post(
    '/auth/google',
    asyncHandler(async (req, res) => {
      const { credential } = z.object({ credential: z.string().min(10).max(5000) }).parse(req.body);
      const now = clock();
      await enforce(prisma, [{ key: `google:ip:${clientIp(req)}`, max: 60, windowMs: 15 * MIN }], now);

      let identity;
      try {
        identity = await cfg.verifyGoogle(credential);
      } catch {
        throw new ApiError(401, 'INVALID_CREDENTIAL', 'Google sign-in failed. Please try again.');
      }
      if (!identity.emailVerified) {
        throw new ApiError(403, 'ACCOUNT_NOT_ALLOWED', 'This Google account has no verified email address.');
      }
      const email = identity.email.toLowerCase();

      let user = await prisma.user.findUnique({ where: { googleSub: identity.sub } });
      if (!user) {
        const byEmail = await prisma.user.findUnique({ where: { email } });
        if (byEmail) {
          // The email is registered. It may only be linked to a Google identity if it is not already bound to another.
          if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
            throw new ApiError(403, 'ACCOUNT_NOT_ALLOWED', 'This Google account is not allowed.');
          }
          user = await prisma.user.update({
            where: { id: byEmail.id },
            data: {
              googleSub: identity.sub,
              emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(now),
              // A password set up BEFORE the email was proven could belong to someone who does not own
              // the address (pre-registration hijack). Proving the email with Google retires it.
              ...(byEmail.emailVerifiedAt ? {} : { passwordHash: null, sessionVersion: { increment: 1 } }),
            },
          });
        } else {
          await assertRoom();
          await housekeeping(now);
          user = await prisma.user.create({
            data: { email, googleSub: identity.sub, name: identity.name ?? null, emailVerifiedAt: new Date(now) },
          });
        }
      }
      await startSession(res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  router.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res, cfg.secureCookies);
    res.status(204).end();
  });

  router.get(
    '/auth/me',
    asyncHandler(async (req, res) => {
      const auth = await authenticate(req);
      if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.id } });
      res.json({ user: publicUser(user) });
    }),
  );

  return router;
}
