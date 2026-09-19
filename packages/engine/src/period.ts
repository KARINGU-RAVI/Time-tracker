import { calculateDailyAttendance } from './day';
import { resolveRule } from './rules';
import { addDays, eachDate, firstDayOfMonth, istDateOf, lastDayOfMonth, startOfWeek } from './time';
import type { AttendanceRecord, DayResult, EngineContext } from './types';

export interface PeriodCounts {
  /** Days with required work, excluding WFH (a half-day leave counts as working). */
  working: number;
  wfh: number;
  /** Annual leave days used (a half day counts 0.5). */
  leaveDays: number;
  optionalHolidays: number;
  bereavementDays: number;
  holidays: number;
  weeklyOffs: number;
}

export interface PeriodResult {
  start: string;
  end: string;
  /** Totals only include days up to and including this date. */
  throughDate: string;
  days: DayResult[];
  requiredMinutes: number;
  /** Required minutes for the whole period, including days after throughDate. */
  requiredFullPeriodMinutes: number;
  workedMinutes: number;
  /** worked - required. Short days are not forced to be made up (R-19). */
  balanceMinutes: number;
  /** max(0, balance) at period level (R-20). */
  periodOvertimeMinutes: number;
  /** Sum of per-day overtime. Reported separately, never added to the above (R-20). */
  dailyOvertimeMinutes: number;
  offDayWorkedMinutes: number;
  counts: PeriodCounts;
  incompleteDates: string[];
  unrecordedDates: string[];
}

export type RecordsByDate = Record<string, AttendanceRecord | undefined>;

/**
 * Generic period calculation. Weekly and monthly views are built on it, so the
 * per-day rule lookup makes mid-period rule changes work automatically.
 */
export function calculatePeriod(
  start: string,
  end: string,
  records: RecordsByDate,
  ctx: EngineContext,
  options: { throughDate?: string } = {},
): PeriodResult {
  const throughDate = options.throughDate && options.throughDate < end ? options.throughDate : end;
  const days = eachDate(start, end).map((d) => calculateDailyAttendance(records[d], d, ctx));

  const counts: PeriodCounts = {
    working: 0,
    wfh: 0,
    leaveDays: 0,
    optionalHolidays: 0,
    bereavementDays: 0,
    holidays: 0,
    weeklyOffs: 0,
  };
  let required = 0;
  let requiredFull = 0;
  let worked = 0;
  let dailyOvertime = 0;
  let offDayWorked = 0;
  const incompleteDates: string[] = [];
  const unrecordedDates: string[] = [];

  for (const day of days) {
    if (day.kind === 'BEFORE_TRACKING') continue;
    requiredFull += day.requiredMinutes;
    if (day.date > throughDate) continue;

    required += day.requiredMinutes;
    worked += day.workedMinutes;
    dailyOvertime += day.overtimeMinutes;
    offDayWorked += day.offDayWorkedMinutes;
    if (day.isIncomplete) incompleteDates.push(day.date);
    if (day.isUnrecorded) unrecordedDates.push(day.date);

    switch (day.kind) {
      case 'WORKING':
        counts.working += 1;
        break;
      case 'HALF_DAY_LEAVE':
        counts.working += 1;
        counts.leaveDays += 0.5;
        break;
      case 'WFH':
        counts.wfh += 1;
        break;
      case 'FULL_LEAVE':
        counts.leaveDays += 1;
        break;
      case 'OPTIONAL_HOLIDAY':
        counts.optionalHolidays += 1;
        break;
      case 'BEREAVEMENT':
        counts.bereavementDays += 1;
        break;
      case 'HOLIDAY':
        counts.holidays += 1;
        break;
      case 'WEEKLY_OFF':
        counts.weeklyOffs += 1;
        break;
    }
  }

  const balance = worked - required;
  return {
    start,
    end,
    throughDate,
    days,
    requiredMinutes: required,
    requiredFullPeriodMinutes: requiredFull,
    workedMinutes: worked,
    balanceMinutes: balance,
    periodOvertimeMinutes: Math.max(0, balance),
    dailyOvertimeMinutes: dailyOvertime,
    offDayWorkedMinutes: offDayWorked,
    counts,
    incompleteDates,
    unrecordedDates,
  };
}

/**
 * The week containing `anyDate`. Weekly required is the sum of each day's
 * required minutes, so leave, holidays and rule changes are handled (R-18).
 * Future days of the current week are included in the requirement.
 */
export function calculateWeeklyAttendance(
  anyDate: string,
  records: RecordsByDate,
  ctx: EngineContext,
): PeriodResult {
  let weekStartsOn = 1;
  try {
    weekStartsOn = resolveRule(ctx.rules, anyDate).weekStartsOn;
  } catch {
    // Before any rule exists we still need a sensible week boundary.
  }
  const start = startOfWeek(anyDate, weekStartsOn);
  return calculatePeriod(start, addDays(start, 6), records, ctx);
}

/**
 * A calendar month. Totals run through today for the current month
 * (`requiredFullPeriodMinutes` holds the whole-month requirement) (R-21).
 */
export function calculateMonthlyAttendance(
  year: number,
  month: number,
  records: RecordsByDate,
  ctx: EngineContext,
): PeriodResult {
  const start = firstDayOfMonth(year, month);
  const end = lastDayOfMonth(year, month);
  const today = istDateOf(ctx.now);
  return calculatePeriod(start, end, records, ctx, { throughDate: today < end ? today : end });
}
