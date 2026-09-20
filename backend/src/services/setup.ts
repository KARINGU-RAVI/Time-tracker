import { addDays, isoWeekday } from '@oht/engine';
import { z } from 'zod';
import { ApiError } from '../errors';

/**
 * First-time setup. `planSetup` is pure: it checks the answers and returns the exact records to store, so the same
 * code produces the live preview and the saved data, and can be tested without a database.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-21.').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'That is not a real date.');
const text = (max: number) => z.string().trim().max(max);
const days = (max: number) => z.number().min(0).max(max).multipleOf(0.01);

export const setupSchema = z.object({
  profile: z.object({
    name: text(80).min(1, 'Enter your name.'),
    employeeId: text(40).optional(),
    designation: text(80).optional(),
    businessUnit: text(80).optional(),
  }),
  work: z.object({
    dailyMinutes: z.number().int().min(60).max(960),
    weeklyMinutes: z.number().int().min(60).max(6720),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    weekStartsOn: z.union([z.literal(1), z.literal(7)]),
    trackingStartDate: date,
  }),
  leave: z.object({
    annualEntitlement: days(60),
    accrualPerMonth: days(10),
    carryForwardCap: days(60),
    optionalQuota: z.number().int().min(0).max(20),
    bereavementDaysPerEvent: z.number().int().min(0).max(30),
    /** Annual leave brought in from last year. */
    carriedForward: days(60),
    /** Annual leave already taken this year, before tracking starts. */
    annualUsedSoFar: days(60),
    optionalUsedSoFar: z.number().int().min(0).max(20),
    /** Half-day allowance for a birthday, separate from annual leave (default half a day a year). */
    birthdayQuota: days(1).default(0.5),
    /** Whether the birthday half-day was already taken this year, before tracking starts. */
    birthdayTaken: z.boolean().default(false),
    /** First month (1-12) this year that earns monthly leave, for someone who joined mid-year. */
    creditsFromMonth: z.number().int().min(1).max(12).default(1),
  }),
  holidays: z.object({
    source: z.enum(['none', 'company', 'list']),
    list: z
      .array(z.object({ date, name: text(80).min(1), type: z.enum(['COMPANY', 'OPTIONAL']) }))
      .max(100)
      .optional(),
  }),
});
export type SetupInput = z.infer<typeof setupSchema>;

export interface LedgerRow {
  pool: 'ANNUAL' | 'OPTIONAL' | 'BIRTHDAY';
  type: 'OPENING' | 'ACCRUAL' | 'GRANT' | 'ADJUSTMENT';
  days: number;
  effectiveDate: string;
  note?: string;
}

export interface SetupPlan {
  year: number;
  workRule: { dailyRequiredMinutes: number; weeklyRequiredMinutes: number; halfDayRequiredMinutes: number; workingDays: number[]; weekStartsOn: number; effectiveFrom: string };
  policy: { annualEntitlement: number; accrualPerMonth: number; carryForwardCap: number; optionalQuota: number; birthdayQuota: number; bereavementDaysPerEvent: number; effectiveFrom: string };
  ledger: LedgerRow[];
  holidays: Array<{ date: string; name: string; type: 'COMPANY' | 'OPTIONAL' }>;
  preview: {
    annual: { carriedIn: number; credited: number; used: number; balance: number };
    optional: { quota: number; used: number; remaining: number };
    birthday: { quota: number; used: number; remaining: number };
    trackingStartDate: string;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

const bad = (code: string, message: string) => new ApiError(400, code, message);

/** The Monday on or after `today`: a sensible default for the first tracked day. */
export function nextMonday(today: string): string {
  const wd = isoWeekday(today);
  return wd === 1 ? today : addDays(today, 8 - wd);
}

export function planSetup(input: SetupInput, today: string, companyHolidays: SetupPlan['holidays'] = []): SetupPlan {
  const { work, leave } = input;
  const year = Number(today.slice(0, 4));

  if (new Set(work.workingDays).size !== work.workingDays.length) throw bad('INVALID_WORKING_DAYS', 'Each working day can be chosen only once.');
  if (work.weeklyMinutes > work.dailyMinutes * work.workingDays.length) {
    throw bad('WEEKLY_TOO_HIGH', 'The weekly hours are more than the daily hours across your working days.');
  }
  if (!work.trackingStartDate.startsWith(String(year))) {
    throw bad('INVALID_TRACKING_START', `Choose a tracking start date in ${year}.`);
  }
  if (leave.carriedForward > leave.carryForwardCap) {
    throw bad('CARRY_TOO_HIGH', `At most ${leave.carryForwardCap} days can be carried forward, so this cannot be more.`);
  }
  if (leave.birthdayTaken && leave.birthdayQuota <= 0) {
    throw bad('BIRTHDAY_NOT_AVAILABLE', 'There is no birthday half-day allowance to have used.');
  }
  if (leave.optionalUsedSoFar > leave.optionalQuota) {
    throw bad('OPTIONAL_TOO_HIGH', `You cannot have used more than the ${leave.optionalQuota} optional leave(s) available.`);
  }

  const start = work.trackingStartDate;
  const dayBefore = addDays(start, -1);
  // Leave taken before tracking is already in the past, so it must count from today at the latest
  // (a future date would leave the balance too high until that day arrives).
  const adjustmentDate = dayBefore < today ? dayBefore : today;
  const ledger: LedgerRow[] = [];
  const jan1 = `${year}-01-01`;

  if (leave.carriedForward > 0) ledger.push({ pool: 'ANNUAL', type: 'OPENING', days: leave.carriedForward, effectiveDate: jan1, note: `Carried forward from ${year - 1}` });

  let creditedByToday = 0;
  let creditedBeforeStart = 0;
  for (let m = leave.creditsFromMonth; m <= 12; m++) {
    const first = `${year}-${pad(m)}-01`;
    if (first > start) break; // later months are added automatically as they come due
    ledger.push({ pool: 'ANNUAL', type: 'ACCRUAL', days: leave.accrualPerMonth, effectiveDate: first });
    if (first <= today) creditedByToday += leave.accrualPerMonth;
    if (first <= dayBefore) creditedBeforeStart += leave.accrualPerMonth;
  }

  // The used-so-far figure is checked against what could have been available before tracking began.
  const available = round2(leave.carriedForward + creditedBeforeStart);
  if (leave.annualUsedSoFar > available) {
    throw bad('USED_MORE_THAN_AVAILABLE', `You cannot have used ${leave.annualUsedSoFar} days when only ${available} were available before your tracking start date.`);
  }
  if (leave.annualUsedSoFar > 0) ledger.push({ pool: 'ANNUAL', type: 'ADJUSTMENT', days: -leave.annualUsedSoFar, effectiveDate: adjustmentDate, note: 'Leave taken before tracking began' });

  if (leave.optionalQuota > 0) ledger.push({ pool: 'OPTIONAL', type: 'GRANT', days: leave.optionalQuota, effectiveDate: jan1, note: `Optional leave quota for ${year}` });
  if (leave.optionalUsedSoFar > 0) ledger.push({ pool: 'OPTIONAL', type: 'ADJUSTMENT', days: -leave.optionalUsedSoFar, effectiveDate: adjustmentDate, note: 'Optional leave used before tracking began' });

  const birthdayUsed = leave.birthdayTaken ? leave.birthdayQuota : 0;
  if (leave.birthdayQuota > 0) ledger.push({ pool: 'BIRTHDAY', type: 'GRANT', days: leave.birthdayQuota, effectiveDate: jan1, note: `Birthday half-day allowance for ${year}` });
  if (birthdayUsed > 0) ledger.push({ pool: 'BIRTHDAY', type: 'ADJUSTMENT', days: -birthdayUsed, effectiveDate: adjustmentDate, note: 'Birthday half-day taken before tracking began' });

  // Holidays
  let holidays: SetupPlan['holidays'] = [];
  if (input.holidays.source === 'list') holidays = input.holidays.list ?? [];
  else if (input.holidays.source === 'company') holidays = companyHolidays;
  const seen = new Set<string>();
  for (const h of holidays) {
    if (seen.has(h.date)) throw bad('DUPLICATE_HOLIDAY', `The date ${h.date} appears more than once in the holiday list.`);
    seen.add(h.date);
    const y = Number(h.date.slice(0, 4));
    if (y < year - 1 || y > year + 1) throw bad('HOLIDAY_OUT_OF_RANGE', `The holiday on ${h.date} is more than a year away.`);
  }

  return {
    year,
    workRule: {
      dailyRequiredMinutes: work.dailyMinutes,
      weeklyRequiredMinutes: work.weeklyMinutes,
      halfDayRequiredMinutes: Math.floor(work.dailyMinutes / 2),
      workingDays: [...work.workingDays].sort((a, b) => a - b),
      weekStartsOn: work.weekStartsOn,
      effectiveFrom: start,
    },
    policy: {
      annualEntitlement: leave.annualEntitlement,
      accrualPerMonth: leave.accrualPerMonth,
      carryForwardCap: leave.carryForwardCap,
      optionalQuota: leave.optionalQuota,
      birthdayQuota: leave.birthdayQuota,
      bereavementDaysPerEvent: leave.bereavementDaysPerEvent,
      effectiveFrom: jan1,
    },
    ledger,
    holidays,
    preview: {
      annual: {
        carriedIn: leave.carriedForward,
        credited: round2(creditedByToday),
        used: leave.annualUsedSoFar,
        balance: round2(leave.carriedForward + creditedByToday - leave.annualUsedSoFar),
      },
      optional: { quota: leave.optionalQuota, used: leave.optionalUsedSoFar, remaining: leave.optionalQuota - leave.optionalUsedSoFar },
      birthday: { quota: leave.birthdayQuota, used: birthdayUsed, remaining: round2(leave.birthdayQuota - birthdayUsed) },
      trackingStartDate: start,
    },
  };
}

export const SETUP_DEFAULTS = {
  work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1 as const },
  leave: {
    annualEntitlement: 21,
    accrualPerMonth: 1.75,
    carryForwardCap: 3,
    optionalQuota: 2,
    bereavementDaysPerEvent: 5,
    carriedForward: 0,
    annualUsedSoFar: 0,
    optionalUsedSoFar: 0,
    birthdayQuota: 0.5,
    birthdayTaken: false,
    creditsFromMonth: 1,
  },
};
