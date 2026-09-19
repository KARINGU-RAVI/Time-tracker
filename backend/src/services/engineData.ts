import type { Prisma, PrismaClient } from '@prisma/client';
import {
  addDays,
  istClock,
  istDateOf,
  type AttendanceRecord,
  type DayResult,
  type EngineContext,
  type RecordsByDate,
  type Session,
  type WorkRule,
} from '@oht/engine';
import { ApiError } from '../errors';
import { fromDbDate, toDbDate } from '../http';

type Db = PrismaClient | Prisma.TransactionClient;

export interface UserConfig {
  ctx: EngineContext;
  trackingStartDate: string;
  maxSessionMinutes: number;
}

/** Loads rules, holidays and settings into an engine context for a given "now". */
export async function loadUserConfig(db: Db, userId: string, now: number): Promise<UserConfig> {
  const [settings, rules, holidays] = await Promise.all([
    db.userSettings.findUnique({ where: { userId } }),
    db.workRule.findMany({ where: { userId }, orderBy: { effectiveFrom: 'asc' } }),
    db.holiday.findMany({ where: { userId } }),
  ]);
  if (!settings) {
    throw new ApiError(409, 'NOT_CONFIGURED', 'Settings are missing. Run the setup first.');
  }
  const engineRules: WorkRule[] = rules.map((r) => ({
    dailyRequiredMinutes: r.dailyRequiredMinutes,
    weeklyRequiredMinutes: r.weeklyRequiredMinutes,
    halfDayRequiredMinutes: r.halfDayRequiredMinutes,
    workingDays: r.workingDays,
    weekStartsOn: r.weekStartsOn,
    effectiveFrom: fromDbDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? fromDbDate(r.effectiveTo) : null,
  }));
  return {
    trackingStartDate: fromDbDate(settings.trackingStartDate),
    maxSessionMinutes: settings.maxSessionMinutes,
    ctx: {
      rules: engineRules,
      holidays: holidays.map((h) => ({ date: fromDbDate(h.date), type: h.type })),
      now,
      trackingStartDate: fromDbDate(settings.trackingStartDate),
      maxSessionMinutes: settings.maxSessionMinutes,
    },
  };
}

export interface StoredSession {
  id: string;
  inTime: Date;
  outTime: Date | null;
}

export function toEngineSession(s: { inTime: Date; outTime: Date | null }): Session {
  return { inTime: s.inTime.getTime(), outTime: s.outTime ? s.outTime.getTime() : null };
}

/** Attendance rows (with sessions) for a date range, keyed by date. */
export async function loadRecords(
  db: Db,
  userId: string,
  start: string,
  end: string,
): Promise<{ records: RecordsByDate; stored: Record<string, { id: string; sessions: StoredSession[]; notes: string | null; managerInformed: boolean; bereavementEventId: string | null }> }> {
  const rows = await db.attendance.findMany({
    where: { userId, date: { gte: toDbDate(start), lte: toDbDate(end) } },
    include: { sessions: { orderBy: { inTime: 'asc' } } },
  });
  const records: RecordsByDate = {};
  const stored: Record<string, { id: string; sessions: StoredSession[]; notes: string | null; managerInformed: boolean; bereavementEventId: string | null }> = {};
  for (const r of rows) {
    const date = fromDbDate(r.date);
    const rec: AttendanceRecord = {
      date,
      status: r.status,
      dayFraction: Number(r.dayFraction) === 0.5 ? 0.5 : 1,
      sessions: r.sessions.map(toEngineSession),
    };
    records[date] = rec;
    stored[date] = {
      id: r.id,
      sessions: r.sessions.map((s) => ({ id: s.id, inTime: s.inTime, outTime: s.outTime })),
      notes: r.notes,
      managerInformed: r.managerInformed,
      bereavementEventId: r.bereavementEventId,
    };
  }
  return { records, stored };
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** JSON-friendly day: instants become ISO strings plus IST clock text. */
export function serializeDay(d: DayResult) {
  return {
    date: d.date,
    kind: d.kind,
    isToday: d.isToday,
    isFuture: d.isFuture,
    requiredMinutes: d.requiredMinutes,
    workedMinutes: d.workedMinutes,
    offDayWorkedMinutes: d.offDayWorkedMinutes,
    outsideMinutes: d.outsideMinutes,
    sessionCount: d.sessionCount,
    firstIn: iso(d.firstIn),
    firstInClock: d.firstIn === null ? null : istClock(d.firstIn),
    lastOut: iso(d.lastOut),
    lastOutClock: d.lastOut === null ? null : istClock(d.lastOut),
    balanceMinutes: d.balanceMinutes,
    overtimeMinutes: d.overtimeMinutes,
    isInside: d.isInside,
    isIncomplete: d.isIncomplete,
    isUnrecorded: d.isUnrecorded,
    leaveUse: d.leaveUse,
    warnings: d.warnings,
    sessionIssues: d.sessionIssues,
  };
}

export function serializeSession(s: StoredSession) {
  return {
    id: s.id,
    inTime: s.inTime.toISOString(),
    inClock: istClock(s.inTime.getTime()),
    outTime: s.outTime ? s.outTime.toISOString() : null,
    outClock: s.outTime ? istClock(s.outTime.getTime()) : null,
  };
}

export { addDays, istDateOf };
