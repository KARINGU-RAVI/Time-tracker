import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler } from '../http';
import { verifyPassword } from '../password';
import { enforce } from '../ratelimit';
import { clearSessionCookie } from '../session';
import type { AppDeps } from '../app';

/** Account-level actions that must work even before setup is finished. */
export function accountRoutes({ prisma, clock, auth }: AppDeps): Router {
  const router = Router();

  // Permanently removes the caller and everything they own (all owned tables cascade from User).
  router.delete(
    '/account',
    asyncHandler(async (req, res) => {
      const me = currentUser(req);
      const body = z.object({ confirm: z.literal('DELETE'), password: z.string().max(1000).optional() }).parse(req.body ?? {});
      await enforce(prisma, [{ key: `delete:user:${me.id}`, max: 5, windowMs: 60 * 60 * 1000 }], clock());

      const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
      // Accounts with a password must prove they know it, so a stolen open session cannot wipe the data.
      if (user.passwordHash && !(body.password && (await verifyPassword(body.password, user.passwordHash)))) {
        throw new ApiError(403, 'WRONG_PASSWORD', 'Enter your current password to delete this account.');
      }
      await prisma.user.delete({ where: { id: me.id } });
      clearSessionCookie(res, auth?.secureCookies ?? false);
      res.status(204).end();
    }),
  );

  return router;
}
