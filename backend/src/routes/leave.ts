import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  calculateDailyAttendance,
  eachDate,
  formatLeaveDays,
  isoWeekday,
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
    /** A run of days, from startDate to endDate ... */
    startDate: dateStr.optional(),
    endDate: dateStr.optional(),
    /** ... or, instead, the exact dates (they need not be next to each other). */
    dates: z.array(dateStr).min(1).max(31).optional(),
    half: z.boolean().default(false),
    /** Which half a half day covers. The other half is worked. */
    halfPart: z.enum(['FIRST', 'SECOND']).optional(),
    managerInformed: z.boolean().default(false),
    bereavementEventId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.dates !== undefined || (b.startDate !== undefined && b.endDate !== undefined), { message: 'Choose the dates.' })
  .refine((b) => b.dates !== undefined || b.endDate! >= b.startDate!, { message: 'The end date must not be before the start date.' })
  .refine((b) => !b.dates || new Set(b.dates).size === b.dates.length, { message: 'Each date can be picked only once.' })
  .refine((b) => !b.half || (b.dates ? b.dates.length === 1 : b.startDate === b.endDate), { message: 'A half day applies to a single date.' })
  .refine((b) => !b.half || b.type === 'CASUAL_LEAVE' || b.type === 'SICK_LEAVE' || b.type === 'BIRTHDAY_LEAVE', {
    message: 'Only casual, sick or birthday leave can be a half day.',
  })
  .refine((b) => b.type !== 'BIRTHDAY_LEAVE' || (b.dates ? b.dates.length === 1 : b.startDate === b.endDate), { message: 'A birthday half-day is a single date.' })
  .refine((b) => b.halfPart === undefined || b.half || b.type === 'BIRTHDAY_LEAVE', { message: 'Choose the first or second half only for a half day.' });

type LeaveBody = z.infer<typeof leaveBody>;

/** The exact dates the person means, oldest first. */
const datesOf = (b: LeaveBody): string[] => (b.dates ? [...b.dates].sort() : eachDate(b.startDate!, b.endDate!));

/** Leave taken before the person started counting is kept as a dated deduction from the balance; this marks those rows. */
export const EARLIER_PREFIX = 'Earlier leave:';

const TYPE_LABEL: Record<(typeof LEAVE_TYPES)[number], string> = {
  CASUAL_LEAVE: 'Casual leave',
  SICK_LEAVE: 'Sick leave',
  BEREAVEMENT_LEAVE: 'Bereavement leave',
  OPTIONAL_HOLIDAY: 'Optional holiday',
  BIRTHDAY_LEAVE: 'Birthday half-day',
};

const poolOf = (type: (typeof LEAVE_TYPES)[number]): LeavePool =>
  type === 'OPTIONAL_HOLIDAY' ? 'OPTIONAL' : type === 'BEREAVEMENT_LEAVE' ? 'BEREAVEMENT' : type === 'BIRTHDAY_LEAVE' ? 'BIRTHDAY' : 'ANNUAL';

// Fixed month names, not the computer's locale data (which can say "Sept" instead of "Sep").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pretty = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export function leaveRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  /** Works out which dates in the range count, and what would be paid or unpaid. */
  async function plan(userId: string, b: LeaveBody) {
    const now = clock();
    const today = istDateOf(now);
    const cfg = await loadUserConfig(prisma, userId, now);
    await ensureLedger(prisma, userId, cfg, today);

    if (!b.dates && (Date.parse(b.endDate!) - Date.parse(b.startDate!)) / 86_400_000 > 60) {
      throw new ApiError(400, 'RANGE_TOO_LARGE', 'Choose a range of at most 60 days.');
    }
    const all = datesOf(b);
    if (all.some((d) => d.slice(0, 4) > today.slice(0, 4))) {
      throw new ApiError(400, 'LEAVE_TOO_FAR', 'Leave can only be applied within the current year for now.');
    }

    const status: AttendanceStatus = b.type;
    const dayFraction: 1 | 0.5 = b.half || b.type === 'BIRTHDAY_LEAVE' ? 0.5 : 1;
    const counted: string[] = [];
    /** Dates before the person started counting: recorded as earlier leave, which lowers the balance. */
    const earlier: string[] = [];
    const skipped: Array<{ date: string; reason: string }> = [];
    const halfPart: 'FIRST' | 'SECOND' | null = dayFraction === 0.5 ? (b.halfPart ?? null) : null;

    const pool = poolOf(b.type);
    const firstRule = [...cfg.ctx.rules].sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : 1))[0];
    const alreadyEarlier = new Set(
      (
        await prisma.leaveLedgerEntry.findMany({
          where: { userId, pool, type: 'ADJUSTMENT', note: { startsWith: EARLIER_PREFIX }, effectiveDate: { in: all.map(toDbDate) } },
          select: { effectiveDate: true },
        })
      ).map((e) => fromDbDate(e.effectiveDate)),
    );

    for (const date of all) {
      const probe = calculateDailyAttendance({ date, status, dayFraction, sessions: [] }, date, cfg.ctx);
      if (probe.kind === 'BEFORE_TRACKING') {
        if (b.type === 'BEREAVEMENT_LEAVE') {
          skipped.push({ date, reason: 'Bereavement days before you started counting do not change any balance' });
        } else if (date.slice(0, 4) !== today.slice(0, 4)) {
          skipped.push({ date, reason: 'Only earlier dates in the current year can be added' });
        } else if (date > today) {
          skipped.push({ date, reason: 'Before your start date' });
        } else if (cfg.ctx.holidays.some((h) => h.date === date && h.type === 'COMPANY')) {
          skipped.push({ date, reason: 'Company holiday' });
        } else if (firstRule && !firstRule.workingDays.includes(isoWeekday(date))) {
          skipped.push({ date, reason: 'Weekly off' });
        } else if (alreadyEarlier.has(date)) {
          skipped.push({ date, reason: 'Already added as earlier leave' });
        } else earlier.push(date);
      } else if (probe.kind === 'HOLIDAY') skipped.push({ date, reason: 'Company holiday' });
      else if (probe.kind === 'WEEKLY_OFF') skipped.push({ date, reason: 'Weekly off' });
      else if (b.type === 'OPTIONAL_HOLIDAY' && probe.warnings.includes('OPTIONAL_HOLIDAY_NOT_LISTED')) {
        skipped.push({ date, reason: 'Not in your optional holiday list' });
      } else counted.push(date);
    }

    const yearEnd = `${today.slice(0, 4)}-12-31`;
    const lastDate = all.at(-1)!;
    const ledger = await projectedLedger(prisma, userId, today, lastDate < yearEnd ? yearEnd : lastDate);
    const firstYear = ledger.length ? Math.min(...ledger.map((e) => Number(e.effectiveDate.slice(0, 4)))) : Number(today.slice(0, 4));
    const existingAll = await loadLeaveUsage(prisma, userId, cfg, `${firstYear}-01-01`, yearEnd);
    const replacing = new Set(counted);
    const existing = existingAll.filter((u) => !replacing.has(u.date));
    const newUsage: LeaveUsage[] = [...counted, ...earlier].map((date) => ({ date, days: dayFraction, pool }));
    const { paid, lop } = previewLeave(ledger, existing, newUsage, pool);

    const totalDays = (counted.length + earlier.length) * dayFraction;
    const label = b.type === 'SICK_LEAVE' ? 'sick leave' : b.type === 'CASUAL_LEAVE' ? 'casual leave' : b.type === 'OPTIONAL_HOLIDAY' ? 'an optional holiday' : b.type === 'BIRTHDAY_LEAVE' ? 'my birthday half-day' : 'bereavement leave';
    // "on 1 Oct 2026 to 30 Oct 2026" for a run of days; "on 3 Sep 2026, 10 Sep 2026 and 17 Sep 2026" for chosen dates.
    const used = [...counted, ...earlier].sort();
    const listed = used.map(pretty);
    const dates =
      used.length === 0
        ? ''
        : used.length === 1
          ? listed[0]!
          : b.dates
            ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}`
            : `${listed[0]} to ${listed.at(-1)}`;
    const partText = halfPart ? ` (${halfPart === 'FIRST' ? 'first' : 'second'} half)` : '';

    return {
      cfg,
      counted,
      earlier,
      skipped,
      dayFraction,
      halfPart,
      pool,
      typeLabel: TYPE_LABEL[b.type],
      status,
      totalDays,
      paid,
      lop,
      summary:
        counted.length + earlier.length === 0
          ? 'No working days are selected (weekends and holidays are skipped).'
          : `${formatLeaveDays(totalDays)} working day(s) selected (weekends and holidays are skipped).` +
            (earlier.length > 0
              ? ` ${earlier.length} date(s) fall before you started counting: they are saved as earlier leave and reduce your balance.`
              : ''),
      warning:
        lop > 0 && (pool === 'ANNUAL' || pool === 'BIRTHDAY')
          ? `${formatLeaveDays(lop)} day(s) will be unpaid (salary cut).`
          : null,
      managerMessage:
        lop > 0 && (pool === 'ANNUAL' || pool === 'BIRTHDAY')
          ? `Hi, I would like to apply for ${label} on ${dates}${partText}. My leave balance covers ${formatLeaveDays(paid)} day(s), so ${formatLeaveDays(lop)} day(s) would be unpaid. Please let me know if this is fine. Thank you.`
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
      const earlierRows = await prisma.leaveLedgerEntry.findMany({
        where: { userId: user.id, type: 'ADJUSTMENT', note: { startsWith: EARLIER_PREFIX } },
        orderBy: { effectiveDate: 'desc' },
      });
      res.json({
        ...summary,
        trackingStartDate: cfg.trackingStartDate,
        earlier: earlierRows.map((e) => ({ id: e.id, date: fromDbDate(e.effectiveDate), pool: e.pool, days: Math.abs(Number(e.days)), note: e.note })),
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
        earlierDates: p.earlier,
        halfPart: p.halfPart,
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
      if (p.counted.length === 0 && p.earlier.length === 0) {
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
            halfDayPart: p.halfPart,
            managerInformed: b.managerInformed,
            bereavementEventId: b.type === 'BEREAVEMENT_LEAVE' ? (b.bereavementEventId ?? null) : null,
          };
          await tx.attendance.upsert({
            where: { userId_date: { userId: user.id, date: toDbDate(date) } },
            update: data,
            create: { userId: user.id, date: toDbDate(date), ...data },
          });
        }
        if (p.earlier.length > 0) {
          const part = p.halfPart ? ` (${p.halfPart === 'FIRST' ? 'first' : 'second'} half)` : '';
          await tx.leaveLedgerEntry.createMany({
            data: p.earlier.map((date) => ({
              userId: user.id,
              pool: p.pool,
              type: 'ADJUSTMENT' as const,
              days: -p.dayFraction,
              effectiveDate: toDbDate(date),
              leaveYear: Number(date.slice(0, 4)),
              note: `${EARLIER_PREFIX} ${p.typeLabel} on ${pretty(date)}${part}`,
            })),
          });
        }
      });
      res.status(201).json({ applied: p.counted, earlier: p.earlier, paid: p.paid, lop: p.lop, warning: p.warning });
    }),
  );

  /** Removes one earlier-leave entry (only the person's own, and only ones added this way). */
  router.delete(
    '/leave/earlier/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const removed = await prisma.leaveLedgerEntry.deleteMany({
        where: { id, userId: user.id, type: 'ADJUSTMENT', note: { startsWith: EARLIER_PREFIX } },
      });
      if (removed.count === 0) throw new ApiError(404, 'NOT_FOUND', 'That entry was not found.');
      res.status(204).end();
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
