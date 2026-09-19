import { describe, expect, it } from 'vitest';
import {
  allocateLeave,
  calculateDailyAttendance,
  calculatePeriod,
  leaveBalanceAt,
  type LedgerEntry,
  type LeaveUsage,
} from '../src';
import { NOW_PAST, companyHoliday, ctx, rec, ses } from './helpers';

const D = '2026-09-15'; // Tuesday, a working day

/** The half-day is worked like any half-day leave: 4 hours are still required, and it uses only the birthday allowance. */
describe('birthday half-day: one day', () => {
  it('needs 4 hours of work and uses half a day from the birthday pool, not the annual pool', () => {
    const r = calculateDailyAttendance(rec(D, [ses(D, '09:00', '13:00')], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST));
    expect(r.kind).toBe('BIRTHDAY_HALF_DAY');
    expect(r.requiredMinutes).toBe(240);
    expect(r.workedMinutes).toBe(240);
    expect(r.balanceMinutes).toBe(0);
    expect(r.leaveUse).toEqual({ pool: 'BIRTHDAY', days: 0.5 });
    expect(r.warnings).toEqual([]);
  });

  it('is short when less than 4 hours are worked, and overtime beyond 4', () => {
    const short = calculateDailyAttendance(rec(D, [ses(D, '09:00', '12:00')], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST));
    expect(short.balanceMinutes).toBe(-60);
    const over = calculateDailyAttendance(rec(D, [ses(D, '09:00', '14:00')], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST));
    expect(over.balanceMinutes).toBe(60);
    expect(over.overtimeMinutes).toBe(60);
  });

  it('with no work recorded on a past day, the whole 4 hours are missing', () => {
    const r = calculateDailyAttendance(rec(D, [], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST));
    expect(r.balanceMinutes).toBe(-240);
  });

  it('is always half a day: a full-day fraction on a birthday record is still treated as a half-day', () => {
    const r = calculateDailyAttendance(rec(D, [], 'BIRTHDAY_LEAVE', 1), D, ctx(NOW_PAST));
    expect(r.kind).toBe('BIRTHDAY_HALF_DAY');
    expect(r.requiredMinutes).toBe(240);
    expect(r.leaveUse).toEqual({ pool: 'BIRTHDAY', days: 0.5 });
  });

  it('uses the half-day hours of the rule in force, not a fixed 4', () => {
    const custom = { dailyRequiredMinutes: 450, weeklyRequiredMinutes: 2250, halfDayRequiredMinutes: 225, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, effectiveFrom: '2026-09-01', effectiveTo: null };
    const r = calculateDailyAttendance(rec(D, [], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST, { rules: [custom] }));
    expect(r.requiredMinutes).toBe(225);
  });

  it('on a holiday or a weekend it changes nothing and uses no allowance', () => {
    const onHoliday = calculateDailyAttendance(rec(D, [], 'BIRTHDAY_LEAVE', 0.5), D, ctx(NOW_PAST, { holidays: [companyHoliday(D)] }));
    expect(onHoliday.kind).toBe('HOLIDAY');
    expect(onHoliday.requiredMinutes).toBe(0);
    expect(onHoliday.leaveUse).toBeNull();
    expect(onHoliday.warnings).toContain('LEAVE_ON_NON_WORKING_DAY');
    const sat = '2026-09-19';
    const weekend = calculateDailyAttendance(rec(sat, [], 'BIRTHDAY_LEAVE', 0.5), sat, ctx(NOW_PAST));
    expect(weekend.kind).toBe('WEEKLY_OFF');
    expect(weekend.leaveUse).toBeNull();
  });
});

describe('birthday half-day: in a week', () => {
  it('counts as a working day with half a birthday day, and reduces nothing else', () => {
    const records = {
      '2026-09-14': rec('2026-09-14', [ses('2026-09-14', '09:00', '17:00')]),
      '2026-09-15': rec('2026-09-15', [ses('2026-09-15', '09:00', '13:00')], 'BIRTHDAY_LEAVE', 0.5),
    };
    const p = calculatePeriod('2026-09-14', '2026-09-15', records, ctx(NOW_PAST));
    expect(p.counts.working).toBe(2);
    expect(p.counts.birthdayDays).toBe(0.5);
    expect(p.counts.leaveDays).toBe(0); // annual leave is untouched
    expect(p.requiredMinutes).toBe(480 + 240);
    expect(p.workedMinutes).toBe(480 + 240);
    expect(p.balanceMinutes).toBe(0);
  });
});

describe('birthday half-day: the yearly allowance', () => {
  const grant = (year: number): LedgerEntry => ({ pool: 'BIRTHDAY', type: 'GRANT', days: 0.5, effectiveDate: `${year}-01-01` });
  const used = (date: string): LeaveUsage => ({ date, days: 0.5, pool: 'BIRTHDAY' });

  it('one half-day a year is paid, and the balance goes to zero', () => {
    const ledger = [grant(2026)];
    expect(leaveBalanceAt(ledger, [], 'BIRTHDAY', '2026-07-13')).toBe(0.5);
    const a = allocateLeave(ledger, [used('2026-07-14')], 'BIRTHDAY');
    expect(a).toEqual([{ date: '2026-07-14', pool: 'BIRTHDAY', days: 0.5, paid: 0.5, lop: 0 }]);
    expect(leaveBalanceAt(ledger, [used('2026-07-14')], 'BIRTHDAY', '2026-07-14')).toBe(0);
  });

  it('a second one in the same year is unpaid (loss of pay), never a negative balance', () => {
    const ledger = [grant(2026)];
    const a = allocateLeave(ledger, [used('2026-07-14'), used('2026-08-03')], 'BIRTHDAY');
    expect(a.map((x) => [x.paid, x.lop])).toEqual([[0.5, 0], [0, 0.5]]);
    expect(leaveBalanceAt(ledger, [used('2026-07-14'), used('2026-08-03')], 'BIRTHDAY', '2026-12-31')).toBe(0);
  });

  it('it does not touch the annual or optional balances', () => {
    const ledger: LedgerEntry[] = [grant(2026), { pool: 'ANNUAL', type: 'ACCRUAL', days: 1.75, effectiveDate: '2026-01-01' }, { pool: 'OPTIONAL', type: 'GRANT', days: 2, effectiveDate: '2026-01-01' }];
    const usage = [used('2026-07-14')];
    expect(leaveBalanceAt(ledger, usage, 'ANNUAL', '2026-12-31')).toBe(1.75);
    expect(leaveBalanceAt(ledger, usage, 'OPTIONAL', '2026-12-31')).toBe(2);
  });

  it('each year has its own allowance once the yearly grant is added', () => {
    const ledger: LedgerEntry[] = [grant(2026), { pool: 'BIRTHDAY', type: 'LAPSE', days: 0.5, effectiveDate: '2026-12-31' }, grant(2027)];
    // used none in 2026: the 0.5 lapses at year end (recorded as a negative entry), then 2027 gets a fresh one
    ledger[1] = { pool: 'BIRTHDAY', type: 'LAPSE', days: -0.5, effectiveDate: '2026-12-31' };
    expect(leaveBalanceAt(ledger, [], 'BIRTHDAY', '2026-12-31')).toBe(0);
    expect(leaveBalanceAt(ledger, [], 'BIRTHDAY', '2027-01-01')).toBe(0.5);
    expect(leaveBalanceAt(ledger, [used('2027-03-02')], 'BIRTHDAY', '2027-06-01')).toBe(0);
  });
});
