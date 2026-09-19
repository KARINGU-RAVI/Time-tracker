import { Router, type NextFunction, type Request, type Response } from 'express';
import { istDateOf } from '@oht/engine';
import { z } from 'zod';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler } from '../http';
import { nextMonday, planSetup, SETUP_DEFAULTS, setupSchema } from '../services/setup';
import { toDbDate } from '../http';
import type { AppDeps } from '../app';

/** Blocks every route behind it until the first-time setup is finished. */
export function requireSetup(req: Request, _res: Response, next: NextFunction) {
  if (!currentUser(req).setupComplete) {
    return next(new ApiError(403, 'SETUP_REQUIRED', 'Finish setting up your account first.'));
  }
  next();
}

/** The company holiday calendar copied into a new account. Empty until an admin publishes one. */
async function companyHolidays(): Promise<Array<{ date: string; name: string; type: 'COMPANY' | 'OPTIONAL' }>> {
  return [];
}

export function setupRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  router.get(
    '/setup/defaults',
    asyncHandler(async (req, res) => {
      const auth = currentUser(req);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.id } });
      const today = istDateOf(clock());
      res.json({
        alreadyComplete: user.setupCompletedAt !== null,
        today,
        profile: { name: user.name ?? '' },
        work: { ...SETUP_DEFAULTS.work, trackingStartDate: nextMonday(today) },
        leave: SETUP_DEFAULTS.leave,
        holidays: { companyCount: (await companyHolidays()).length },
      });
    }),
  );

  router.post(
    '/setup/preview',
    asyncHandler(async (req, res) => {
      currentUser(req);
      const input = setupSchema.omit({ profile: true }).extend({ profile: setupSchema.shape.profile.partial().optional() }).parse(req.body);
      const plan = planSetup({ ...input, profile: { name: input.profile?.name ?? 'preview' } }, istDateOf(clock()), await companyHolidays());
      res.json({ preview: plan.preview, holidayCount: plan.holidays.length });
    }),
  );

  router.post(
    '/setup/complete',
    asyncHandler(async (req, res) => {
      const auth = currentUser(req);
      const input = setupSchema.extend({ acknowledged: z.literal(true) }).parse(req.body);
      const plan = planSetup(input, istDateOf(clock()), await companyHolidays());

      await prisma.$transaction(async (tx) => {
        // The single guarded update is the "only once" lock: two simultaneous requests cannot both pass it.
        const claimed = await tx.user.updateMany({
          where: { id: auth.id, setupCompletedAt: null },
          data: { setupCompletedAt: new Date(clock()), name: input.profile.name },
        });
        if (claimed.count !== 1) throw new ApiError(409, 'ALREADY_SET_UP', 'This account is already set up.');

        await tx.userSettings.create({
          data: {
            userId: auth.id,
            trackingStartDate: toDbDate(plan.preview.trackingStartDate),
            employeeId: input.profile.employeeId || null,
            designation: input.profile.designation || null,
            businessUnit: input.profile.businessUnit || null,
          },
        });
        await tx.workRule.create({
          data: { userId: auth.id, ...plan.workRule, effectiveFrom: toDbDate(plan.workRule.effectiveFrom) },
        });
        await tx.leavePolicy.create({
          data: { userId: auth.id, ...plan.policy, effectiveFrom: toDbDate(plan.policy.effectiveFrom) },
        });
        await tx.leaveLedgerEntry.createMany({
          data: plan.ledger.map((r) => ({
            userId: auth.id,
            pool: r.pool,
            type: r.type,
            days: r.days,
            effectiveDate: toDbDate(r.effectiveDate),
            leaveYear: plan.year,
            note: r.note,
          })),
        });
        if (plan.holidays.length) {
          await tx.holiday.createMany({
            data: plan.holidays.map((h) => ({ userId: auth.id, date: toDbDate(h.date), name: h.name, type: h.type })),
          });
        }
      });

      res.status(201).json({ user: { email: auth.email, name: input.profile.name, setupComplete: true }, preview: plan.preview });
    }),
  );

  return router;
}
