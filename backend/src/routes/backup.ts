import express, { Router } from 'express';
import { z } from 'zod';
import {
  addDays,
  calculateDailyAttendance,
  formatDuration,
  istClock,
  istDateOf,
  isoWeekday,
  eachDate,
  type DayResult,
} from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr, fromDbDate } from '../http';
import { countsOf, currentCounts, exportBackup, parseBackup, restoreBackup } from '../services/backup';
import { guardText, toCsv } from '../services/csv';
import { loadRecords, loadUserConfig } from '../services/engineData';
import type { AppDeps } from '../app';

/** Backups can be a few MB. 6 MB is also the serverless request limit, so nothing larger could arrive anyway. */
const backupJson = express.json({ limit: '6mb' });

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_LABEL: Record<string, string> = {
  WORKING: 'Working',
  WFH: 'WFH',
  CASUAL_LEAVE: 'Casual leave',
  SICK_LEAVE: 'Sick leave',
  BEREAVEMENT_LEAVE: 'Bereavement leave',
  OPTIONAL_HOLIDAY: 'Optional holiday',
  BIRTHDAY_LEAVE: 'Birthday half-day',
};

function statusLabel(day: DayResult, recordStatus: string | undefined, half: boolean): string {
  if (day.isIncomplete) return 'Needs fix';
  if (day.isUnrecorded) return 'No record';
  if (day.kind === 'HOLIDAY') return 'Holiday';
  if (day.kind === 'WEEKLY_OFF') return 'Weekly off';
  if (day.isFuture && !recordStatus) return 'Upcoming';
  const base = recordStatus ? (STATUS_LABEL[recordStatus] ?? recordStatus) : 'Working';
  return half ? `${base} (half day)` : base;
}

export function backupRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  /** A complete, portable copy of all data. Served as a download. */
  router.get(
    '/backup',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const now = clock();
      const backup = await exportBackup(prisma, user.id, now);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="office-hours-backup-${istDateOf(now)}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify(backup, null, 2));
    }),
  );

  /** Step 1 of a restore: checks the file completely and reports what would change. Saves nothing. */
  router.post(
    '/backup/validate',
    backupJson,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const backup = parseBackup(req.body);
      const [current, existing] = await Promise.all([
        currentCounts(prisma, user.id),
        prisma.attendance.findMany({ where: { userId: user.id }, select: { date: true } }),
      ]);
      const inBackup = new Set(backup.data.attendance.map((a) => a.date));
      const onlyInCurrent = existing.filter((a) => !inBackup.has(fromDbDate(a.date))).length;
      res.json({
        valid: true,
        exportedAt: backup.exportedAt,
        backup: countsOf(backup.data),
        current,
        // Days recorded now that the backup does not have: they would be deleted by a restore.
        daysThatWouldBeLost: onlyInCurrent,
      });
    }),
  );

  /**
   * Step 2: replaces ALL data with the backup, atomically. The caller must send confirm = "REPLACE",
   * so a stray request can never wipe data.
   */
  router.post(
    '/backup/restore',
    backupJson,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const body = z.object({ confirm: z.literal('REPLACE'), backup: z.unknown() }).safeParse(req.body);
      if (!body.success) {
        throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Send confirm: "REPLACE" to restore. This replaces all current data.');
      }
      const backup = parseBackup(body.data.backup);
      const restored = await restoreBackup(prisma, user.id, backup);
      res.json({ restored, exportedAt: backup.exportedAt });
    }),
  );

  /** Report: one row per day (daily) or per session (sessions), for a date range. */
  router.get(
    '/export/csv',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const q = z
        .object({ startDate: dateStr, endDate: dateStr, type: z.enum(['daily', 'sessions']).default('daily') })
        .parse(req.query);
      if (q.endDate < q.startDate) throw new ApiError(400, 'INVALID_RANGE', 'endDate must not be before startDate.');
      if ((Date.parse(q.endDate) - Date.parse(q.startDate)) / 86_400_000 > 366) {
        throw new ApiError(400, 'RANGE_TOO_LARGE', 'Choose a range of at most one year.');
      }

      const now = clock();
      const cfg = await loadUserConfig(prisma, user.id, now);
      const { records, stored } = await loadRecords(prisma, user.id, q.startDate, q.endDate);
      const start = q.startDate < cfg.trackingStartDate ? cfg.trackingStartDate : q.startDate;

      let csv: string;
      if (q.type === 'daily') {
        const rows = [];
        for (const date of q.startDate <= q.endDate && start <= q.endDate ? eachDate(start, q.endDate) : []) {
          const day = calculateDailyAttendance(records[date], date, cfg.ctx);
          const rec = records[date];
          const worked = day.isFuture ? null : day.workedMinutes;
          rows.push([
            date,
            WEEKDAYS[isoWeekday(date) - 1],
            statusLabel(day, rec?.status, rec?.dayFraction === 0.5),
            day.firstIn === null ? '' : istClock(day.firstIn),
            day.lastOut === null ? '' : istClock(day.lastOut),
            worked,
            worked === null ? '' : formatDuration(worked),
            day.requiredMinutes,
            formatDuration(day.requiredMinutes),
            day.balanceMinutes,
            day.balanceMinutes === null ? '' : formatDuration(day.balanceMinutes, { signed: true }),
            day.overtimeMinutes,
            guardText(stored[date]?.notes),
          ]);
        }
        csv = toCsv(
          ['Date', 'Weekday', 'Status', 'First IN', 'Last OUT', 'Worked (min)', 'Worked', 'Required (min)', 'Required', 'Balance (min)', 'Balance', 'Overtime (min)', 'Notes'],
          rows,
        );
      } else {
        const rows = [];
        for (const date of Object.keys(stored).sort()) {
          if (date < start) continue;
          for (const s of stored[date]!.sessions) {
            const minutes = s.outTime ? Math.round((s.outTime.getTime() - s.inTime.getTime()) / 60_000) : null;
            rows.push([date, istClock(s.inTime.getTime()), s.outTime ? istClock(s.outTime.getTime()) : '', minutes]);
          }
        }
        csv = toCsv(['Date', 'IN', 'OUT', 'Minutes'], rows);
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="office-hours-${q.type}-${q.startDate}_to_${q.endDate}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    }),
  );

  void addDays;
  return router;
}
