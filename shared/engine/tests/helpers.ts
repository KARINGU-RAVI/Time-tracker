import { istInstant } from '../src/time';
import type {
  AttendanceRecord,
  AttendanceStatus,
  EngineContext,
  Holiday,
  Session,
  WorkRule,
} from '../src/types';

export const RULE: WorkRule = {
  dailyRequiredMinutes: 480,
  weeklyRequiredMinutes: 2400,
  halfDayRequiredMinutes: 240,
  workingDays: [1, 2, 3, 4, 5],
  weekStartsOn: 1,
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
};

export const at = (date: string, hhmm: string): number => istInstant(date, hhmm);

/** A session on one date. Pass null for an open session. */
export function ses(date: string, inn: string, out: string | null): Session {
  return { inTime: at(date, inn), outTime: out === null ? null : at(date, out) };
}

/** A session whose OUT is on another date (midnight crossing). */
export function sesX(inDate: string, inn: string, outDate: string, out: string): Session {
  return { inTime: at(inDate, inn), outTime: at(outDate, out) };
}

export function ctx(now: number, overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    rules: [RULE],
    holidays: [],
    now,
    trackingStartDate: '2026-09-01',
    ...overrides,
  };
}

export function rec(
  date: string,
  sessions: Session[],
  status: AttendanceStatus = 'WORKING',
  dayFraction: 1 | 0.5 = 1,
): AttendanceRecord {
  return { date, status, dayFraction, sessions };
}

/** A record with a single closed session of `minutes` starting 09:00. */
export function minutesRec(date: string, minutes: number): AttendanceRecord {
  const start = at(date, '09:00');
  return rec(date, [{ inTime: start, outTime: start + minutes * 60_000 }]);
}

export const companyHoliday = (date: string): Holiday => ({ date, type: 'COMPANY' });
export const optionalHoliday = (date: string): Holiday => ({ date, type: 'OPTIONAL' });

/** Monday 21 Sep 2026, 10:00 IST: all of 14-18 Sep are in the past. */
export const NOW_PAST = at('2026-09-21', '10:00');
/** Friday 18 Sep 2026, 15:42 IST. */
export const NOW_FRI = at('2026-09-18', '15:42');
