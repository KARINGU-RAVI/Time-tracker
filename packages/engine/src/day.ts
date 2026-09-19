import { resolveRule } from './rules';
import {
  calculateOutsideMinutes,
  calculateWorkedMinutes,
  firstIn,
  lastOut,
  validateSessions,
} from './sessions';
import { isoWeekday, istDateOf } from './time';
import type {
  AttendanceRecord,
  AttendanceStatus,
  DayKind,
  DayResult,
  DayWarning,
  EngineContext,
  LeaveUse,
} from './types';

function isLeaveStatus(status: AttendanceStatus): boolean {
  return (
    status === 'CASUAL_LEAVE' ||
    status === 'SICK_LEAVE' ||
    status === 'BEREAVEMENT_LEAVE' ||
    status === 'OPTIONAL_HOLIDAY'
  );
}

/** Overtime for a day (R-17). Days where nothing is required have no overtime. */
export function calculateOvertime(requiredMinutes: number, workedMinutes: number): number {
  if (requiredMinutes <= 0) return 0;
  return Math.max(0, workedMinutes - requiredMinutes);
}

/** Minutes still needed today (R-22). */
export function calculateRemainingMinutes(requiredMinutes: number, workedMinutes: number): number {
  return Math.max(0, requiredMinutes - workedMinutes);
}

/**
 * Full calculation for one calendar date, from raw records only (R-38).
 * `record` is undefined when nothing has been recorded for the date.
 */
export function calculateDailyAttendance(
  record: AttendanceRecord | undefined,
  date: string,
  ctx: EngineContext,
): DayResult {
  const today = istDateOf(ctx.now);
  const isToday = date === today;
  const isFuture = date > today;
  const sessions = record?.sessions ?? [];

  const empty: DayResult = {
    date,
    kind: 'BEFORE_TRACKING',
    isToday,
    isFuture,
    requiredMinutes: 0,
    workedMinutes: 0,
    offDayWorkedMinutes: 0,
    outsideMinutes: 0,
    sessionCount: 0,
    firstIn: null,
    lastOut: null,
    balanceMinutes: null,
    overtimeMinutes: 0,
    isInside: false,
    isIncomplete: false,
    isUnrecorded: false,
    leaveUse: null,
    warnings: [],
    sessionIssues: [],
  };

  if (date < ctx.trackingStartDate) return empty;

  const rule = resolveRule(ctx.rules, date);
  const warnings: DayWarning[] = [];
  const isWorkingWeekday = rule.workingDays.includes(isoWeekday(date));
  const companyHoliday = ctx.holidays.some((h) => h.date === date && h.type === 'COMPANY');
  const status: AttendanceStatus = record?.status ?? 'WORKING';

  let kind: DayKind;
  let required = 0;
  let leaveUse: LeaveUse | null = null;

  if (companyHoliday || !isWorkingWeekday) {
    kind = companyHoliday ? 'HOLIDAY' : 'WEEKLY_OFF';
    if (record && isLeaveStatus(record.status)) warnings.push('LEAVE_ON_NON_WORKING_DAY');
  } else {
    let fraction: 1 | 0.5 = record?.dayFraction ?? 1;
    const halfAllowed = status === 'CASUAL_LEAVE' || status === 'SICK_LEAVE';
    if (fraction === 0.5 && !halfAllowed) {
      warnings.push('INVALID_FRACTION');
      fraction = 1;
    }
    switch (status) {
      case 'WORKING':
        kind = 'WORKING';
        required = rule.dailyRequiredMinutes;
        break;
      case 'WFH':
        kind = 'WFH';
        required = rule.dailyRequiredMinutes;
        break;
      case 'CASUAL_LEAVE':
      case 'SICK_LEAVE':
        if (fraction === 0.5) {
          kind = 'HALF_DAY_LEAVE';
          required = rule.halfDayRequiredMinutes;
          leaveUse = { pool: 'ANNUAL', days: 0.5 };
        } else {
          kind = 'FULL_LEAVE';
          leaveUse = { pool: 'ANNUAL', days: 1 };
        }
        break;
      case 'OPTIONAL_HOLIDAY':
        kind = 'OPTIONAL_HOLIDAY';
        leaveUse = { pool: 'OPTIONAL', days: 1 };
        if (!ctx.holidays.some((h) => h.date === date && h.type === 'OPTIONAL')) {
          warnings.push('OPTIONAL_HOLIDAY_NOT_LISTED');
        }
        break;
      case 'BEREAVEMENT_LEAVE':
        kind = 'BEREAVEMENT';
        leaveUse = { pool: 'BEREAVEMENT', days: 1 };
        break;
    }
  }

  const worked = calculateWorkedMinutes(sessions, { now: ctx.now, date });
  const requiresWork = required > 0;

  const workedMinutes = requiresWork ? worked.workedMinutes : 0;
  const offDayWorkedMinutes = requiresWork ? 0 : worked.workedMinutes;
  if (offDayWorkedMinutes > 0) warnings.push('WORKED_ON_OFF_DAY');
  if (worked.incomplete) warnings.push('INCOMPLETE_SESSION');

  const isUnrecorded = !record && requiresWork && date < today;
  if (isUnrecorded) warnings.push('UNRECORDED_DAY');

  const balanceMinutes = requiresWork && !isFuture ? workedMinutes - required : null;

  return {
    date,
    kind: kind!,
    isToday,
    isFuture,
    requiredMinutes: required,
    workedMinutes,
    offDayWorkedMinutes,
    outsideMinutes: calculateOutsideMinutes(sessions),
    sessionCount: sessions.length,
    firstIn: firstIn(sessions),
    lastOut: lastOut(sessions),
    balanceMinutes,
    overtimeMinutes: isFuture ? 0 : calculateOvertime(required, workedMinutes),
    isInside: worked.hasOpenSessionToday,
    isIncomplete: worked.incomplete,
    isUnrecorded,
    leaveUse,
    warnings,
    sessionIssues: validateSessions(sessions, {
      date,
      maxSessionMinutes: ctx.maxSessionMinutes,
    }),
  };
}
