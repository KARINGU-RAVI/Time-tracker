import { Router } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  calculateDailyAttendance,
  calculateExpectedCheckout,
  canILeaveNow,
  floorToMinute,
  istClock,
  istClock12,
  istDateOf,
  validateSessions,
  type AttendanceStatus,
} from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr, fromDbDate, paramDate, parseInstant, prettyDate, toDbDate } from '../http';
import {
  loadRecords,
  loadUserConfig,
  type UserConfig,
  serializeDay,
  serializeSession,
  toEngineSession,
} from '../services/engineData';
import type { AppDeps } from '../app';

type Db = PrismaClient | Prisma.TransactionClient;

const STATUSES = ['WORKING', 'WFH', 'CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY'] as const;
const LEAVE_STATUSES: AttendanceStatus[] = ['CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY'];

const sessionBody = z.object({
  inTime: z.string().min(1),
  outTime: z.string().min(1).nullable().optional(),
});

const dayBody = z.object({
  status: z.enum(STATUSES),
  dayFraction: z.union([z.literal(1), z.literal(0.5)]).default(1),
  notes: z.string().max(2000).nullable().optional(),
  managerInformed: z.boolean().optional(),
  bereavementEventId: z.string().uuid().nullable().optional(),
});

async function audit(
  db: Db,
  userId: string,
  entity: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  await db.auditLog.create({
    data: {
      userId,
      entity,
      entityId,
      action,
      before: before === null ? undefined : (before as Prisma.InputJsonValue),
      after: after === null ? undefined : (after as Prisma.InputJsonValue),
    },
  });
}

/** Nothing before the tracking start date is counted, so nothing may be recorded there. */
function assertTracked(date: string, cfg: UserConfig) {
  if (date < cfg.trackingStartDate) {
    throw new ApiError(
      400,
      'BEFORE_TRACKING_START',
      `Tracking starts on ${prettyDate(cfg.trackingStartDate)}. Nothing before that date is counted.`,
    );
  }
}

/** Friendly pre-checks (the database constraints remain the final guard). */
async function assertSessionOk(
  db: Db,
  userId: string,
  p: { date: string; inMs: number; outMs: number | null; excludeId?: string; maxSessionMinutes: number },
) {
  const issues = validateSessions([{ inTime: p.inMs, outTime: p.outMs }], {
    date: p.date,
    maxSessionMinutes: p.maxSessionMinutes,
  });
  if (issues[0]) throw new ApiError(400, issues[0].code, issues[0].message);

  if (p.outMs === null) {
    const open = await db.attendanceSession.findFirst({
      where: { userId, outTime: null, ...(p.excludeId ? { id: { not: p.excludeId } } : {}) },
    });
    if (open) {
      throw new ApiError(409, 'ALREADY_CHECKED_IN', `You are already checked in since ${istClock(open.inTime.getTime())}.`);
    }
  }

  const overlap = await db.attendanceSession.findFirst({
    where: {
      userId,
      ...(p.excludeId ? { id: { not: p.excludeId } } : {}),
      ...(p.outMs === null ? {} : { inTime: { lt: new Date(p.outMs) } }),
      OR: [{ outTime: null }, { outTime: { gt: new Date(p.inMs) } }],
    },
  });
  if (overlap) {
    const out = overlap.outTime ? istClock(overlap.outTime.getTime()) : 'now';
    throw new ApiError(409, 'OVERLAP', `This overlaps your ${istClock(overlap.inTime.getTime())}-${out} session.`);
  }
}

export function attendanceRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  /** Full detail of one day: computed numbers, sessions, and live status when it is today. */
  async function dayDetail(userId: string, date: string) {
    const now = clock();
    const cfg = await loadUserConfig(prisma, userId, now);
    const { records, stored } = await loadRecords(prisma, userId, date, date);
    const record = records[date];
    const day = calculateDailyAttendance(record, date, cfg.ctx);
    const st = stored[date];
    const live = day.isToday ? calculateExpectedCheckout(day, now) : null;
    return {
      day: serializeDay(day),
      status: record?.status ?? null,
      dayFraction: record?.dayFraction ?? 1,
      notes: st?.notes ?? null,
      managerInformed: st?.managerInformed ?? false,
      bereavementEventId: st?.bereavementEventId ?? null,
      sessions: (st?.sessions ?? []).map(serializeSession),
      live: live && {
        status: live.status,
        remainingMinutes: live.remainingMinutes,
        expectedOutAt: live.expectedOutAt === null ? null : new Date(live.expectedOutAt).toISOString(),
        expectedOutClock: live.expectedOutAt === null ? null : istClock12(live.expectedOutAt),
        ifCheckInNowOutAt: live.ifCheckInNowOutAt === null ? null : new Date(live.ifCheckInNowOutAt).toISOString(),
        ifCheckInNowOutClock: live.ifCheckInNowOutAt === null ? null : istClock12(live.ifCheckInNowOutAt),
      },
      message: day.isToday ? canILeaveNow(day) : null,
    };
  }

  // ---- Check in / check out -------------------------------------------------

  router.post(
    '/attendance/check-in',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const now = clock();
      const inMs = floorToMinute(now);
      const today = istDateOf(now);
      const cfg = await loadUserConfig(prisma, user.id, now);
      assertTracked(today, cfg);

      await prisma.$transaction(async (tx) => {
        await assertSessionOk(tx, user.id, {
          date: today,
          inMs,
          outMs: null,
          maxSessionMinutes: cfg.maxSessionMinutes,
        });
        const attendance = await tx.attendance.upsert({
          where: { userId_date: { userId: user.id, date: toDbDate(today) } },
          update: {},
          create: { userId: user.id, date: toDbDate(today) },
        });
        await tx.attendanceSession.create({
          data: { attendanceId: attendance.id, userId: user.id, inTime: new Date(inMs) },
        });
      });
      res.status(201).json(await dayDetail(user.id, today));
    }),
  );

  router.post(
    '/attendance/check-out',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const now = clock();
      const outMs = floorToMinute(now);
      const cfg = await loadUserConfig(prisma, user.id, now);

      const open = await prisma.attendanceSession.findFirst({
        where: { userId: user.id, outTime: null },
        include: { attendance: true },
      });
      if (!open) throw new ApiError(409, 'NOT_CHECKED_IN', 'No active session to check out.');

      const inMs = open.inTime.getTime();
      if (outMs <= inMs) throw new ApiError(409, 'TOO_SHORT', 'OUT must be after IN.');
      if ((outMs - inMs) / 60_000 > cfg.maxSessionMinutes) {
        // Forgot to check out on an earlier day: never guess. Ask for the real OUT time.
        throw new ApiError(
          409,
          'OPEN_SESSION_FROM_PAST',
          `Your session from ${fromDbDate(open.attendance.date)} ${istClock(inMs)} has no OUT time. Enter the real OUT time.`,
          { sessionId: open.id, date: fromDbDate(open.attendance.date), inTime: open.inTime.toISOString() },
        );
      }
      await prisma.attendanceSession.update({ where: { id: open.id }, data: { outTime: new Date(outMs) } });
      res.json(await dayDetail(user.id, fromDbDate(open.attendance.date)));
    }),
  );

  // ---- Reads -----------------------------------------------------------------

  router.get(
    '/attendance/today',
    asyncHandler(async (req, res) => {
      res.json(await dayDetail(currentUser(req).id, istDateOf(clock())));
    }),
  );

  router.get(
    '/attendance',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const q = z.object({ startDate: dateStr, endDate: dateStr }).parse(req.query);
      if (q.endDate < q.startDate) throw new ApiError(400, 'INVALID_RANGE', 'endDate must not be before startDate.');
      const span = (Date.parse(q.endDate) - Date.parse(q.startDate)) / 86_400_000;
      if (span > 366) throw new ApiError(400, 'RANGE_TOO_LARGE', 'Choose a range of at most one year.');

      const now = clock();
      const cfg = await loadUserConfig(prisma, user.id, now);
      const { records } = await loadRecords(prisma, user.id, q.startDate, q.endDate);
      const days = [];
      for (let d = q.startDate; d <= q.endDate; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        days.push(serializeDay(calculateDailyAttendance(records[d], d, cfg.ctx)));
      }
      res.json({ days });
    }),
  );

  router.get(
    '/attendance/:date',
    asyncHandler(async (req, res) => {
      res.json(await dayDetail(currentUser(req).id, paramDate(req.params.date)));
    }),
  );

  // ---- Day status ------------------------------------------------------------

  router.put(
    '/attendance/:date',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const date = paramDate(req.params.date);
      const body = dayBody.parse(req.body);
      const now = clock();
      const cfg = await loadUserConfig(prisma, user.id, now);
      assertTracked(date, cfg);

      if (body.dayFraction === 0.5 && body.status !== 'CASUAL_LEAVE' && body.status !== 'SICK_LEAVE') {
        throw new ApiError(400, 'HALF_DAY_NOT_ALLOWED', 'Only casual or sick leave can be a half day.');
      }
      if (LEAVE_STATUSES.includes(body.status)) {
        const probe = calculateDailyAttendance(
          { date, status: body.status, dayFraction: body.dayFraction, sessions: [] },
          date,
          cfg.ctx,
        );
        if (probe.warnings.includes('LEAVE_ON_NON_WORKING_DAY')) {
          throw new ApiError(400, 'LEAVE_ON_NON_WORKING_DAY', 'Leave cannot be applied on a holiday or weekly off.');
        }
        if (body.status === 'OPTIONAL_HOLIDAY' && probe.warnings.includes('OPTIONAL_HOLIDAY_NOT_LISTED')) {
          throw new ApiError(400, 'OPTIONAL_HOLIDAY_NOT_LISTED', 'This date is not in your optional holiday list.');
        }
      }
      if (body.status === 'BEREAVEMENT_LEAVE') {
        if (!body.bereavementEventId) {
          throw new ApiError(400, 'BEREAVEMENT_EVENT_REQUIRED', 'Bereavement leave must be linked to an event.');
        }
        const event = await prisma.bereavementEvent.findFirst({
          where: { id: body.bereavementEventId, userId: user.id },
        });
        if (!event) throw new ApiError(404, 'NOT_FOUND', 'Bereavement event not found.');
        const policy = await prisma.leavePolicy.findFirst({ where: { userId: user.id }, orderBy: { effectiveFrom: 'desc' } });
        const limit = policy?.bereavementDaysPerEvent ?? 5;
        const already = await prisma.attendance.count({
          where: { userId: user.id, bereavementEventId: event.id, date: { not: toDbDate(date) } },
        });
        if (already + 1 > limit) {
          throw new ApiError(409, 'BEREAVEMENT_LIMIT', `Bereavement leave is limited to ${limit} days per event.`);
        }
      } else if (body.bereavementEventId) {
        throw new ApiError(400, 'BEREAVEMENT_EVENT_NOT_ALLOWED', 'Only bereavement days can link to an event.');
      }

      const before = await prisma.attendance.findUnique({
        where: { userId_date: { userId: user.id, date: toDbDate(date) } },
      });
      const data = {
        status: body.status,
        dayFraction: body.dayFraction,
        notes: body.notes ?? null,
        managerInformed: body.managerInformed ?? before?.managerInformed ?? false,
        bereavementEventId: body.status === 'BEREAVEMENT_LEAVE' ? (body.bereavementEventId ?? null) : null,
      };
      const saved = await prisma.$transaction(async (tx) => {
        const row = await tx.attendance.upsert({
          where: { userId_date: { userId: user.id, date: toDbDate(date) } },
          update: data,
          create: { userId: user.id, date: toDbDate(date), ...data },
        });
        await audit(tx, user.id, 'Attendance', row.id, before ? 'UPDATE' : 'CREATE', before, row);
        return row;
      });
      res.json({ ...(await dayDetail(user.id, date)), id: saved.id });
    }),
  );

  router.delete(
    '/attendance/:date',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const date = paramDate(req.params.date);
      const row = await prisma.attendance.findUnique({
        where: { userId_date: { userId: user.id, date: toDbDate(date) } },
        include: { sessions: true },
      });
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'There is no record for that day.');
      await prisma.$transaction(async (tx) => {
        await audit(tx, user.id, 'Attendance', row.id, 'DELETE', row, null);
        await tx.attendance.delete({ where: { id: row.id } });
      });
      res.status(204).end();
    }),
  );

  // ---- Sessions --------------------------------------------------------------

  router.post(
    '/attendance/:date/sessions',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const date = paramDate(req.params.date);
      const body = sessionBody.parse(req.body);
      const inMs = parseInstant(body.inTime);
      const outMs = body.outTime ? parseInstant(body.outTime) : null;
      const cfg = await loadUserConfig(prisma, user.id, clock());
      assertTracked(date, cfg);

      await prisma.$transaction(async (tx) => {
        await assertSessionOk(tx, user.id, { date, inMs, outMs, maxSessionMinutes: cfg.maxSessionMinutes });
        const attendance = await tx.attendance.upsert({
          where: { userId_date: { userId: user.id, date: toDbDate(date) } },
          update: {},
          create: { userId: user.id, date: toDbDate(date) },
        });
        const s = await tx.attendanceSession.create({
          data: {
            attendanceId: attendance.id,
            userId: user.id,
            inTime: new Date(inMs),
            outTime: outMs === null ? null : new Date(outMs),
          },
        });
        await audit(tx, user.id, 'AttendanceSession', s.id, 'CREATE', null, s);
      });
      res.status(201).json(await dayDetail(user.id, date));
    }),
  );

  router.put(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const body = sessionBody.partial().parse(req.body);
      const existing = await prisma.attendanceSession.findFirst({
        where: { id, userId: user.id },
        include: { attendance: true },
      });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Session not found.');

      const date = fromDbDate(existing.attendance.date);
      const inMs = body.inTime ? parseInstant(body.inTime) : existing.inTime.getTime();
      const outMs =
        body.outTime === undefined
          ? existing.outTime
            ? existing.outTime.getTime()
            : null
          : body.outTime === null
            ? null
            : parseInstant(body.outTime);
      const cfg = await loadUserConfig(prisma, user.id, clock());

      await prisma.$transaction(async (tx) => {
        await assertSessionOk(tx, user.id, { date, inMs, outMs, excludeId: id, maxSessionMinutes: cfg.maxSessionMinutes });
        const updated = await tx.attendanceSession.update({
          where: { id },
          data: { inTime: new Date(inMs), outTime: outMs === null ? null : new Date(outMs) },
        });
        await audit(tx, user.id, 'AttendanceSession', id, 'UPDATE', existing, updated);
      });
      res.json(await dayDetail(user.id, date));
    }),
  );

  router.delete(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const existing = await prisma.attendanceSession.findFirst({
        where: { id, userId: user.id },
        include: { attendance: { include: { sessions: true } } },
      });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Session not found.');
      const date = fromDbDate(existing.attendance.date);

      await prisma.$transaction(async (tx) => {
        await audit(tx, user.id, 'AttendanceSession', id, 'DELETE', existing, null);
        await tx.attendanceSession.delete({ where: { id } });
        // An empty plain working-day record would hide a shortfall as "recorded". Remove it.
        const a = existing.attendance;
        if (a.sessions.length === 1 && a.status === 'WORKING' && !a.notes) {
          await tx.attendance.delete({ where: { id: a.id } });
        }
      });
      res.json(await dayDetail(user.id, date));
    }),
  );

  void toEngineSession;
  return router;
}
