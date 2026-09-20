/** Shapes returned by the backend API (see backend/src/routes). */

export type DayKind =
  | 'WORKING'
  | 'WFH'
  | 'HALF_DAY_LEAVE'
  | 'FULL_LEAVE'
  | 'OPTIONAL_HOLIDAY'
  | 'BEREAVEMENT'
  | 'BIRTHDAY_HALF_DAY'
  | 'HOLIDAY'
  | 'WEEKLY_OFF'
  | 'BEFORE_TRACKING';

export type AttendanceStatus =
  | 'WORKING'
  | 'WFH'
  | 'CASUAL_LEAVE'
  | 'SICK_LEAVE'
  | 'BEREAVEMENT_LEAVE'
  | 'OPTIONAL_HOLIDAY'
  | 'BIRTHDAY_LEAVE';

export interface Session {
  id: string;
  inTime: string;
  inClock: string;
  outTime: string | null;
  outClock: string | null;
}

export interface Day {
  date: string;
  kind: DayKind;
  isToday: boolean;
  isFuture: boolean;
  requiredMinutes: number;
  workedMinutes: number;
  offDayWorkedMinutes: number;
  outsideMinutes: number;
  sessionCount: number;
  firstIn: string | null;
  firstInClock: string | null;
  lastOut: string | null;
  lastOutClock: string | null;
  balanceMinutes: number | null;
  overtimeMinutes: number;
  isInside: boolean;
  isIncomplete: boolean;
  isUnrecorded: boolean;
  leaveUse: { pool: string; days: number } | null;
  warnings: string[];
}

export type LiveStatusName = 'NOT_STARTED' | 'INSIDE' | 'OUTSIDE' | 'COMPLETED' | 'NO_WORK_REQUIRED';

export interface Live {
  status: LiveStatusName;
  remainingMinutes: number;
  expectedOutAt: string | null;
  expectedOutClock: string | null;
  ifCheckInNowOutAt?: string | null;
  ifCheckInNowOutClock: string | null;
}

export interface DayDetail {
  day: Day;
  status: AttendanceStatus | null;
  dayFraction: 1 | 0.5;
  /** Which half a half day covers (the other half is worked). */
  halfDayPart: 'FIRST' | 'SECOND' | null;
  notes: string | null;
  managerInformed: boolean;
  bereavementEventId: string | null;
  sessions: Session[];
  live: Live | null;
  message: string | null;
}

export interface Period {
  start: string;
  end: string;
  throughDate: string;
  requiredMinutes: number;
  requiredFullPeriodMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  periodOvertimeMinutes: number;
  dailyOvertimeMinutes: number;
  offDayWorkedMinutes: number;
  counts: {
    working: number;
    wfh: number;
    leaveDays: number;
    optionalHolidays: number;
    bereavementDays: number;
    birthdayDays: number;
    holidays: number;
    weeklyOffs: number;
  };
  incompleteDates: string[];
  unrecordedDates: string[];
  days: Day[];
  lopDays?: number;
}

export interface Dashboard {
  now: string;
  trackingStartDate: string;
  today: Day & { sessions: Session[]; live: Live; message: string };
  week: Period & { nudge: string | null };
  leave: {
    annualBalance: number;
    optionalRemaining: number;
    nextCredit: { date: string; days: number } | null;
    yearEnd: { balance: number; carryForward: number; willLapse: number } | null;
  };
  alerts: { incompleteDates: string[]; unrecordedDates: string[] };
}

export interface LeaveSummary {
  asOf: string;
  year: number;
  annual: {
    balance: number;
    carriedIn: number;
    accruedThisYear: number;
    usedThisYear: number;
    nextCredit: { date: string; days: number } | null;
  };
  optional: { quota: number; used: number; remaining: number };
  /** The first day that is counted; leave before it is saved as earlier leave. */
  trackingStartDate: string;
  /** Leave from before the start date that was added by hand. It lowers the balance. */
  earlier: Array<{ id: string; date: string; pool: string; days: number; note: string | null }>;
  /** Birthday half-day: separate from annual leave, one allowance a year. */
  birthday: { quota: number; used: number; remaining: number };
  lopByMonth: Record<string, number>;
  ledger: Array<{ date: string; kind: string; note: string | null; days: number; running: number }>;
  yearEnd: { balance: number; carryForward: number; willLapse: number } | null;
  bereavement: {
    maxDaysPerEvent: number;
    events: Array<{ id: string; relation: string; startDate: string; note: string | null; daysUsed: number }>;
  };
}

export interface LeavePreview {
  workingDays: string[];
  /** Dates before the start date: saved as earlier leave. */
  earlierDates?: string[];
  halfPart?: 'FIRST' | 'SECOND' | null;
  skipped: Array<{ date: string; reason: string }>;
  totalDays: number;
  paid: number;
  lop: number;
  summary: string;
  warning: string | null;
  managerMessage: string | null;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  type: 'COMPANY' | 'OPTIONAL';
  description: string | null;
}

export interface ImportRow {
  row: number;
  date: string | null;
  name: string;
  type: 'COMPANY' | 'OPTIONAL' | null;
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  error?: string;
}

export interface WorkRule {
  id: string;
  dailyRequiredMinutes: number;
  weeklyRequiredMinutes: number;
  halfDayRequiredMinutes: number;
  workingDays: number[];
  weekStartsOn: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}
