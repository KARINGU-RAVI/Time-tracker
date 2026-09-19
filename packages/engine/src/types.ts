/**
 * Core types for the calculation engine.
 *
 * Conventions:
 *  - Instants are epoch milliseconds (UTC). Precision used is one minute.
 *  - Calendar dates are IST dates as 'YYYY-MM-DD' strings.
 *  - Durations are integer minutes. Leave quantities are days (may be 0.5).
 */

export type AttendanceStatus =
  | 'WORKING'
  | 'WFH'
  | 'CASUAL_LEAVE'
  | 'SICK_LEAVE'
  | 'BEREAVEMENT_LEAVE'
  | 'OPTIONAL_HOLIDAY';

export type HolidayType = 'COMPANY' | 'OPTIONAL';

export type LeavePool = 'ANNUAL' | 'OPTIONAL' | 'BEREAVEMENT';

export interface Session {
  /** Epoch ms of IN. */
  inTime: number;
  /** Epoch ms of OUT, or null while the session is still open. */
  outTime: number | null;
}

export interface AttendanceRecord {
  date: string;
  status: AttendanceStatus;
  /** 1 for a full day, 0.5 for a half-day leave. */
  dayFraction: 1 | 0.5;
  sessions: Session[];
}

export interface Holiday {
  date: string;
  type: HolidayType;
}

export interface WorkRule {
  dailyRequiredMinutes: number;
  weeklyRequiredMinutes: number;
  halfDayRequiredMinutes: number;
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: number[];
  /** ISO weekday the week starts on (1 = Monday). */
  weekStartsOn: number;
  effectiveFrom: string;
  /** Inclusive end date, or null for open-ended. */
  effectiveTo: string | null;
}

export interface EngineContext {
  rules: WorkRule[];
  holidays: Holiday[];
  /** The current instant. Injected so every calculation is deterministic. */
  now: number;
  /** Days before this date are never counted. */
  trackingStartDate: string;
  /** Sessions longer than this are invalid. Default 960 (16h). */
  maxSessionMinutes?: number;
}

export type DayKind =
  | 'WORKING'
  | 'WFH'
  | 'HALF_DAY_LEAVE'
  | 'FULL_LEAVE'
  | 'OPTIONAL_HOLIDAY'
  | 'BEREAVEMENT'
  | 'HOLIDAY'
  | 'WEEKLY_OFF'
  | 'BEFORE_TRACKING';

export interface LeaveUse {
  pool: LeavePool;
  days: number;
}

export type DayWarning =
  | 'LEAVE_ON_NON_WORKING_DAY'
  | 'INVALID_FRACTION'
  | 'OPTIONAL_HOLIDAY_NOT_LISTED'
  | 'WORKED_ON_OFF_DAY'
  | 'INCOMPLETE_SESSION'
  | 'UNRECORDED_DAY';

export interface SessionIssue {
  code: 'OUT_BEFORE_IN' | 'ZERO_LENGTH' | 'OVERLAP' | 'MULTIPLE_OPEN' | 'TOO_LONG' | 'IN_DATE_MISMATCH';
  message: string;
  index?: number;
}

export interface DayResult {
  date: string;
  kind: DayKind;
  isToday: boolean;
  isFuture: boolean;
  requiredMinutes: number;
  /** Worked minutes that count toward the day (0 on off-days). */
  workedMinutes: number;
  /** Minutes recorded on a day where no work is required. Excluded from balances. */
  offDayWorkedMinutes: number;
  outsideMinutes: number;
  sessionCount: number;
  firstIn: number | null;
  lastOut: number | null;
  /** worked - required, or null when not applicable (off-days, future days). */
  balanceMinutes: number | null;
  overtimeMinutes: number;
  isInside: boolean;
  isIncomplete: boolean;
  isUnrecorded: boolean;
  leaveUse: LeaveUse | null;
  warnings: DayWarning[];
  sessionIssues: SessionIssue[];
}

export class EngineError extends Error {
  constructor(
    public readonly code: 'NO_RULE' | 'INVALID_DATE',
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
