import { Router } from 'express';
import { z } from 'zod';
import { addDays } from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr, fromDbDate, toDbDate } from '../http';
import type { AppDeps } from '../app';

const ruleBody = z
  .object({
    dailyRequiredMinutes: z.number().int().min(1).max(1440),
    weeklyRequiredMinutes: z.number().int().min(1).max(10080),
    halfDayRequiredMinutes: z.number().int().min(0).max(1440),
    workingDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .refine((d) => new Set(d).size === d.length, 'Working days must not repeat.'),
    weekStartsOn: z.number().int().min(1).max(7).default(1),
    effectiveFrom: dateStr,
  })
  .refine((r) => r.halfDayRequiredMinutes <= r.dailyRequiredMinutes, {
    message: 'A half day cannot need more than a full day.',
  });

const serialize = (r: {
  id: string;
  dailyRequiredMinutes: number;
  weeklyRequiredMinutes: number;
  halfDayRequiredMinutes: number;
  workingDays: number[];
  weekStartsOn: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}) => ({
  id: r.id,
  dailyRequiredMinutes: r.dailyRequiredMinutes,
  weeklyRequiredMinutes: r.weeklyRequiredMinutes,
  halfDayRequiredMinutes: r.halfDayRequiredMinutes,
  workingDays: r.workingDays,
  weekStartsOn: r.weekStartsOn,
  effectiveFrom: fromDbDate(r.effectiveFrom),
  effectiveTo: r.effectiveTo ? fromDbDate(r.effectiveTo) : null,
});

export function ruleRoutes({ prisma }: AppDeps): Router {
  const router = Router();

  router.get(
    '/rules',
    asyncHandler(async (req, res) => {
      const rows = await prisma.workRule.findMany({
        where: { userId: currentUser(req).id },
        orderBy: { effectiveFrom: 'desc' },
      });
      res.json({ rules: rows.map(serialize) });
    }),
  );

  /**
   * Rules are versioned (R-25): a change closes the current version the day before and
   * creates a new one, so past dates keep the rule that applied then. There is no PUT.
   */
  router.post(
    '/rules',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const body = ruleBody.parse(req.body);

      const created = await prisma.$transaction(async (tx) => {
        const latest = await tx.workRule.findFirst({
          where: { userId: user.id },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (latest) {
          if (fromDbDate(latest.effectiveFrom) >= body.effectiveFrom) {
            throw new ApiError(
              409,
              'RULE_DATE_INVALID',
              `The new rule must start after the current rule's start date (${fromDbDate(latest.effectiveFrom)}).`,
            );
          }
          await tx.workRule.update({
            where: { id: latest.id },
            data: { effectiveTo: toDbDate(addDays(body.effectiveFrom, -1)) },
          });
        }
        return tx.workRule.create({
          data: {
            userId: user.id,
            dailyRequiredMinutes: body.dailyRequiredMinutes,
            weeklyRequiredMinutes: body.weeklyRequiredMinutes,
            halfDayRequiredMinutes: body.halfDayRequiredMinutes,
            workingDays: [...body.workingDays].sort(),
            weekStartsOn: body.weekStartsOn,
            effectiveFrom: toDbDate(body.effectiveFrom),
          },
        });
      });
      res.status(201).json(serialize(created));
    }),
  );

  return router;
}
