import { Router } from 'express';
import { z } from 'zod';
import {
  addDays,
  calculateMonthlyAttendance,
  calculateWeeklyAttendance,
  firstDayOfMonth,
  istDateOf,
  lastDayOfMonth,
  type PeriodResult,
} from '@oht/engine';
import { currentUser } from '../auth';
import { asyncHandler, dateStr } from '../http';
import { loadRecords, loadUserConfig } from '../services/engineData';
import type { AppDeps } from '../app';

interface Computed {
  pct: number | null;
  period: PeriodResult;
}

/** % of the period's required minutes actually worked. Ranking by this, not raw minutes,
 * means meeting your target beats staying latest (see docs/08-leaderboard-design.md). */
function pctOf(period: PeriodResult): number | null {
  return period.requiredMinutes > 0 ? period.workedMinutes / period.requiredMinutes : null;
}

async function buildBoard(
  { prisma, clock }: Pick<AppDeps, 'prisma' | 'clock'>,
  meId: string,
  computeFor: (userId: string, now: number) => Promise<Computed>,
) {
  const now = clock();
  const me = await computeFor(meId, now);

  const optedIn = await prisma.userSettings.findMany({
    where: { leaderboardOptIn: true },
    select: {
      userId: true,
      leaderboardDisplayName: true,
      user: { select: { name: true, setupCompletedAt: true } },
    },
  });

  const myOptedIn = optedIn.some((row) => row.userId === meId);

  const results: { userId: string; displayName: string; pct: number }[] = [];
  for (const row of optedIn) {
    if (!row.user.setupCompletedAt) continue;
    const displayName = row.leaderboardDisplayName ?? row.user.name ?? 'Anonymous';
    if (row.userId === meId) {
      if (me.pct !== null) results.push({ userId: meId, displayName, pct: me.pct });
      continue;
    }
    const { pct } = await computeFor(row.userId, now);
    if (pct !== null) results.push({ userId: row.userId, displayName, pct });
  }
  results.sort((a, b) => b.pct - a.pct);

  const entries = results.map((r, i) => ({
    rank: i + 1,
    displayName: r.displayName,
    pct: r.pct,
    isYou: r.userId === meId,
  }));

  return {
    period: { start: me.period.start, end: me.period.end, throughDate: me.period.throughDate },
    you: { optedIn: myOptedIn, pct: me.pct, rank: entries.find((e) => e.isYou)?.rank ?? null },
    entries,
  };
}

export function leaderboardRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  router.get(
    '/leaderboard/visibility',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      res.json({ optedIn: settings.leaderboardOptIn, displayName: settings.leaderboardDisplayName });
    }),
  );

  router.put(
    '/leaderboard/visibility',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const body = z
        .object({ optedIn: z.boolean(), displayName: z.string().trim().min(1).max(60).nullable().optional() })
        .parse(req.body);
      const settings = await prisma.userSettings.update({
        where: { userId: user.id },
        data: { leaderboardOptIn: body.optedIn, ...(body.displayName !== undefined ? { leaderboardDisplayName: body.displayName } : {}) },
      });
      res.json({ optedIn: settings.leaderboardOptIn, displayName: settings.leaderboardDisplayName });
    }),
  );

  router.get(
    '/leaderboard/week',
    asyncHandler(async (req, res) => {
      const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
      const board = await buildBoard({ prisma, clock }, currentUser(req).id, async (userId, now) => {
        const anchor = date ?? istDateOf(now);
        const cfg = await loadUserConfig(prisma, userId, now);
        const { records } = await loadRecords(prisma, userId, addDays(anchor, -7), addDays(anchor, 7));
        const period = calculateWeeklyAttendance(anchor, records, cfg.ctx);
        return { pct: pctOf(period), period };
      });
      res.json(board);
    }),
  );

  router.get(
    '/leaderboard/month',
    asyncHandler(async (req, res) => {
      const q = z
        .object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) })
        .parse(req.query);
      const board = await buildBoard({ prisma, clock }, currentUser(req).id, async (userId, now) => {
        const cfg = await loadUserConfig(prisma, userId, now);
        const start = firstDayOfMonth(q.year, q.month);
        const end = lastDayOfMonth(q.year, q.month);
        const { records } = await loadRecords(prisma, userId, start, end);
        const period = calculateMonthlyAttendance(q.year, q.month, records, cfg.ctx);
        return { pct: pctOf(period), period };
      });
      res.json(board);
    }),
  );

  return router;
}
