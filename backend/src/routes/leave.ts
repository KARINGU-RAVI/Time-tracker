import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  calculateDailyAttendance,
  eachDate,
  formatLeaveDays,
  istDateOf,
  previewLeave,
  type AttendanceStatus,
  type LeavePool,
  type LeaveUsage,
} from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr, fromDbDate, toDbDate } from '../http';
import { loadUserConfig } from '../services/engineData';
import { ensureLedger, leaveSummary, loadLeaveUsage, projectedLedger } from '../services/leave';
import type { AppDeps } from '../app';

const LEAVE_TYPES = ['CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY', 'BIRTHDAY_LEAVE'] as const;

const leaveBody = z
  .object({
    type: z.enum(LEAVE_TYPES),
    startDate: dateStr,
    endDate: dateStr,
    half: z.boolean().default(false),
    managerInformed: z.boolean().default(false),
    bereavementEventId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.endDate >= b.startDate, { message: 'The end date must not be before the start date.' })
  .refine((b) => !b.half || b.startDate === b.endDate, { message: 'A half day applies to a single date.' })
  .refine((b) => !b.half || b.type === 'CASUAL_LEAVE' || b.type === 'SICK_LEAVE' || b.type === 'BIRTHDAY_LEAVE', {
    message: 'Only casual, sick or birthday leave can be a half day.',
  })
  .refine((b) => b.type !== 'BIRTHDAY_LEAVE' || b.startDate === b.endDate, { message: 'A birthday half-day is a single date.' });

const poolOf = (type: (typeof LEAVE_TYPES)[number]): LeavePool =>
  type === 'OPTIONAL_HOLIDAY' ? 'OPTIONAL' : type === 'BEREAVEMENT_LEAVE' ? 'BEREAVEMENT' : type === 'BIRTHDAY_LEAVE' ? 'BIRTHDAY' : 'ANNUAL';

const pretty = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
};

export function leaveRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  /** Works out which dates in the range count, and what would be paid or unpaid. */
  async function plan(userId: string, b: z.infer<typeof leaveBody>) {
    const now = clock();
    const today = istDateOf(now);
    const cfg = await loadUserConfig(prisma, userId, now);
    await ensureLedger(prisma, userId, cfg, today);

    if (b.startDate.slice(0, 4) > today.slice(0, 4)) {
      throw new ApiError(400, 'LEAVE_TOO_FAR', 'Leave can only be applied within the current year for now.');
    }
    if ((Date.parse(b.endDate) - Date.parse(b.startDate)) / 86_400_000 > 60) {
      throw new ApiError(400, 'RANGE_TOO_LARGE', 'Choose a range of at most 60 days.');
    }

    const status: AttendanceStatus = b.type;
    const dayFraction: 1 | 0.5 = b.half || b.type === 'BIRTHDAY_LEAVE' ? 0.5 : 1;
    const counted: string[] = [];
    const skipped: Array<{ date: string; reason: string }> = [];
    for (const date of eachDate(b.startDate, b.endDate)) {
      const probe = calculateDailyAttendance({ date, status, dayFraction, sessions: [] }, date, cfg.ctx);
      if (probe.kind === 'BEFORE_TRACKING') skipped.push({ date, reason: 'Before your tracking start date' });
      else if (probe.kind === 'HOLIDAY') skipped.push({ date, reason: 'Company holiday' });
      else if (probe.kind === 'WEEKLY_OFF') skipped.push({ date, reason: 'Weekly off' });
      else if (b.type === 'OPTIONAL_HOLIDAY' && probe.warnings.includes('OPTIONAL_HOLIDAY_NOT_LISTED')) {
        skipped.push({ date, reason: 'Not in your optional holiday list' });
      } else counted.push(date);
    }

    const pool = poolOf(b.type);
    const yearEnd = `${today.slice(0, 4)}-12-31`;
    const ledger = await projectedLedger(prisma, userId, today, b.endDate < yearEnd ? yearEnd : b.endDate);
    const firstYear = ledger.length ? Math.min(...ledger.map((e) => Number(e.effectiveDate.slice(0, 4)))) : Number(today.slice(0, 4));
    const existingAll = await loadLeaveUsage(prisma, userId, cfg, `${firstYear}-01-01`, yearEnd);
    const replacing = new Set(counted);
    const existing = existingAll.filter((u) => !replacing.has(u.date));
    const newUsage: LeaveUsage[] = counted.map((date) => ({ date, days: dayFraction, pool }));
    const { paid, lop } = previewLeave(ledger, existing, newUsage, pool);

    const totalDays = counted.length * dayFraction;
    const label = b.type === 'SICK_LEAVE' ? 'sick leave' : b.type === 'CASUAL_LEAVE' ? 'casual leave' : b.type === 'OPTIONAL_HOLIDAY' ? 'an optional holiday' : b.type === 'BIRTHDAY_LEAVE' ? 'my birthday half-day' : 'bereavement leave';
    const dates =
      counted.length === 0
        ? ''
        : counted.length === 1
          ? pretty(counted[0]!)
          : `${pretty(counted[0]!)} to ${pretty(counted.at(-1)!)}`;

    return {
      cfg,
      counted,
      skipped,
      dayFraction,
      status,
      totalDays,
      paid,
      lop,
      summary:
        counted.length === 0
          ? 'No working days are selected (weekends and holidays are skipped).'
          : `${formatLeaveDays(totalDays)} working day(s) selected (weekends and holidays are skipped).`,
      warning:
        lop > 0 && (pool === 'ANNUAL' || pool === 'BIRTHDAY')
          ? `${formatLeaveDays(lop)} day(s) will be unpaid (salary cut).`
          : null,
      managerMessage:
        lop > 0 && (pool === 'ANNUAL' || pool === 'BIRTHDAY')
          ? `Hi, I would like to apply for ${label} on ${dates}. My leave balance covers ${formatLeaveDays(paid)} day(s), so ${formatLeaveDays(lop)} day(s) would be unpaid. Please let me know if this is fine. Thank you.`
          : null,
    };
  }

  router.get(
    '/leave',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const now = clock();
      const cfg = await loadUserConfig(prisma, user.id, now);
      const summary = await leaveSummary(prisma, user.id, cfg, istDateOf(now));
      const events = await prisma.bereavementEvent.findMany({
        where: { userId: user.id },
        orderBy: { startDate: 'desc' },
        include: { _count: { select: { attendances: true } } },
      });
      const policy = await prisma.leavePolicy.findFirst({ where: { userId: user.id }, orderBy: { effectiveFrom: 'desc' } });
      res.json({
        ...summary,
        bereavement: {
          maxDaysPerEvent: policy?.bereavementDaysPerEvent ?? 5,
          events: events.map((e) => ({
            id: e.id,
            relation: e.relation,
            startDate: fromDbDate(e.startDate),
            note: e.note,
            daysUsed: e._count.attendances,
          })),
        },
      });
    }),
  );

  router.post(
    '/leave/preview',
    asyncHandler(async (req, res) => {
      const p = await plan(currentUser(req).id, leaveBody.parse(req.body));
      res.json({
        workingDays: p.counted,
        skipped: p.skipped,
        totalDays: p.totalDays,
        paid: p.paid,
        lop: p.lop,
        summary: p.summary,
        warning: p.warning,
        managerMessage: p.managerMessage,
      });
    }),
  );

  /** Saving is never blocked by a shortfall: leave beyond balance is recorded as unpaid. */
  router.post(
    '/leave/apply',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const b = leaveBody.parse(req.body);
      const p = await plan(user.id, b);
      if (p.counted.length === 0) {
        throw new ApiError(400, 'NO_WORKING_DAYS', 'No working days are selected (weekends and holidays are skipped).');
      }

      if (b.type === 'BEREAVEMENT_LEAVE') {
        if (!b.bereavementEventId) {
          throw new ApiError(400, 'BEREAVEMENT_EVENT_REQUIRED', 'Choose or log a bereavement event first.');
        }
        const event = await prisma.bereavementEvent.findFirst({ where: { id: b.bereavementEventId, userId: user.id } });
        if (!event) throw new ApiError(404, 'NOT_FOUND', 'Bereavement event not found.');
        const policy = await prisma.leavePolicy.findFirst({ where: { userId: user.id }, orderBy: { effectiveFrom: 'desc' } });
        const limit = policy?.bereavementDaysPerEvent ?? 5;
        const already = await prisma.attendance.count({
          where: {
            userId: user.id,
            bereavementEventId: event.id,
            date: { notIn: p.counted.map(toDbDate) },
          },
        });
        if (already + p.counted.length > limit) {
          throw new ApiError(409, 'BEREAVEMENT_LIMIT', `Bereavement leave is limited to ${limit} days per event.`);
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const date of p.counted) {
          const data = {
            status: b.type,
            dayFraction: p.dayFraction,
            managerInformed: b.managerInformed,
            bereavementEventId: b.type === 'BEREAVEMENT_LEAVE' ? (b.bereavementEventId ?? null) : null,
          };
          await tx.attendance.upsert({
            where: { userId_date: { userId: user.id, date: toDbDate(date) } },
            update: data,
            create: { userId: user.id, date: toDbDate(date), ...data },
          });
        }
      });
      res.status(201).json({ applied: p.counted, paid: p.paid, lop: p.lop, warning: p.warning });
    }),
  );

  router.post(
    '/leave/bereavement-events',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const b = z
        .object({ relation: z.string().trim().min(1).max(80), startDate: dateStr, note: z.string().max(500).nullable().optional() })
        .parse(req.body);
      const e = await prisma.bereavementEvent.create({
        data: { userId: user.id, relation: b.relation, startDate: toDbDate(b.startDate), note: b.note ?? null },
      });
      res.status(201).json({ id: e.id, relation: e.relation, startDate: b.startDate, note: e.note });
    }),
  );

  return router;
}
