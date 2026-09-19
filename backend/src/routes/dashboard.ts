import { Router } from 'express';
import { z } from 'zod';
import {
  addDays,
  calculateDailyAttendance,
  calculateExpectedCheckout,
  calculateMonthlyAttendance,
  calculatePeriod,
  calculateWeeklyAttendance,
  canILeaveNow,
  formatDuration,
  isoWeekday,
  istClock12,
  istDateOf,
  lastDayOfMonth,
  firstDayOfMonth,
  type PeriodResult,
} from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr } from '../http';
import { loadRecords, loadUserConfig, serializeDay, serializeSession } from '../services/engineData';
import { leaveSummary } from '../services/leave';
import type { AppDeps } from '../app';

export function serializePeriod(p: PeriodResult) {
  return {
    start: p.start,
    end: p.end,
    throughDate: p.throughDate,
    requiredMinutes: p.requiredMinutes,
    requiredFullPeriodMinutes: p.requiredFullPeriodMinutes,
    workedMinutes: p.workedMinutes,
    balanceMinutes: p.balanceMinutes,
    periodOvertimeMinutes: p.periodOvertimeMinutes,
    dailyOvertimeMinutes: p.dailyOvertimeMinutes,
    offDayWorkedMinutes: p.offDayWorkedMinutes,
    counts: p.counts,
    incompleteDates: p.incompleteDates,
    unrecordedDates: p.unrecordedDates,
    days: p.days.map(serializeDay),
  };
}

export function dashboardRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  router.get(
    '/dashboard',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const now = clock();
      const today = istDateOf(now);
      const cfg = await loadUserConfig(prisma, user.id, now);

      const from = addDays(today, -14);
      const to = addDays(today, 8);
      const { records, stored } = await loadRecords(prisma, user.id, from, to);

      const day = calculateDailyAttendance(records[today], today, cfg.ctx);
      const live = calculateExpectedCheckout(day, now);
      const week = calculateWeeklyAttendance(today, records, cfg.ctx);

      // Days that need attention: unclosed sessions and unrecorded working days.
      const alertStart = from < cfg.trackingStartDate ? cfg.trackingStartDate : from;
      const alertEnd = addDays(today, -1);
      const past =
        alertStart <= alertEnd ? calculatePeriod(alertStart, alertEnd, records, cfg.ctx) : null;

      const leave = await leaveSummary(prisma, user.id, cfg, today);

      const weekday = isoWeekday(today);
      const nudge =
        (weekday === 4 || weekday === 5) && week.balanceMinutes < 0
          ? `${formatDuration(-week.balanceMinutes)} left to reach this week's target.`
          : null;

      res.json({
        now: new Date(now).toISOString(),
        trackingStartDate: cfg.trackingStartDate,
        today: {
          ...serializeDay(day),
          sessions: (stored[today]?.sessions ?? []).map(serializeSession),
          live: {
            status: live.status,
            remainingMinutes: live.remainingMinutes,
            expectedOutAt: live.expectedOutAt === null ? null : new Date(live.expectedOutAt).toISOString(),
            expectedOutClock: live.expectedOutAt === null ? null : istClock12(live.expectedOutAt),
            ifCheckInNowOutClock: live.ifCheckInNowOutAt === null ? null : istClock12(live.ifCheckInNowOutAt),
          },
          message: canILeaveNow(day),
        },
        week: { ...serializePeriod(week), nudge },
        leave: {
          annualBalance: leave.annual.balance,
          optionalRemaining: leave.optional.remaining,
          nextCredit: leave.annual.nextCredit,
          yearEnd: leave.yearEnd,
        },
        alerts: {
          incompleteDates: past?.incompleteDates ?? [],
          unrecordedDates: past?.unrecordedDates ?? [],
        },
      });
    }),
  );

  router.get(
    '/summary/week',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
      const now = clock();
      const anchor = date ?? istDateOf(now);
      const cfg = await loadUserConfig(prisma, user.id, now);
      const { records } = await loadRecords(prisma, user.id, addDays(anchor, -7), addDays(anchor, 14));
      res.json(serializePeriod(calculateWeeklyAttendance(anchor, records, cfg.ctx)));
    }),
  );

  router.get(
    '/summary/month',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const q = z
        .object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) })
        .parse(req.query);
      const now = clock();
      const cfg = await loadUserConfig(prisma, user.id, now);
      const start = firstDayOfMonth(q.year, q.month);
      const end = lastDayOfMonth(q.year, q.month);
      const { records } = await loadRecords(prisma, user.id, start, end);
      const result = calculateMonthlyAttendance(q.year, q.month, records, cfg.ctx);
      const leave = await leaveSummary(prisma, user.id, cfg, istDateOf(now));
      const key = `${q.year}-${String(q.month).padStart(2, '0')}`;
      res.json({ ...serializePeriod(result), lopDays: leave.lopByMonth[key] ?? 0 });
    }),
  );

  void ApiError;
  return router;
}
