import { describe, expect, it } from 'vitest';
import { calculateMonthlyAttendance, calculateWeeklyAttendance, type RecordsByDate } from '../src';
import { NOW_FRI, NOW_PAST, RULE, at, companyHoliday, ctx, minutesRec, rec, ses } from './helpers';

function byDate(...records: ReturnType<typeof rec>[]): RecordsByDate {
  return Object.fromEntries(records.map((r) => [r.date, r]));
}

describe('weekly calculation', () => {
  it('matches the spec example: 40h worked against 40h required', () => {
    const records = byDate(
      minutesRec('2026-09-14', 8 * 60 + 10),
      minutesRec('2026-09-15', 7 * 60 + 50),
      minutesRec('2026-09-16', 8 * 60),
      minutesRec('2026-09-17', 8 * 60 + 20),
      minutesRec('2026-09-18', 7 * 60 + 40),
    );
    const w = calculateWeeklyAttendance('2026-09-16', records, ctx(NOW_PAST));
    expect(w.start).toBe('2026-09-14');
    expect(w.end).toBe('2026-09-20');
    expect(w.requiredMinutes).toBe(2400);
    expect(w.workedMinutes).toBe(2400);
    expect(w.balanceMinutes).toBe(0);
    expect(w.counts.working).toBe(5);
    expect(w.counts.weeklyOffs).toBe(2);
  });

  it('does not force a short day to be made up the same day', () => {
    const records = byDate(
      minutesRec('2026-09-14', 450), // -30
      minutesRec('2026-09-15', 510), // +30
      minutesRec('2026-09-16', 480),
      minutesRec('2026-09-17', 480),
      minutesRec('2026-09-18', 480),
    );
    const w = calculateWeeklyAttendance('2026-09-14', records, ctx(NOW_PAST));
    expect(w.days[0]?.balanceMinutes).toBe(-30);
    expect(w.days[1]?.balanceMinutes).toBe(30);
    expect(w.balanceMinutes).toBe(0);
  });

  it('reduces the weekly requirement for a leave day (32h) and reports -1h 40m', () => {
    const d = (x: string) => x;
    const records = byDate(
      minutesRec(d('2026-09-14'), 490), // 8h 10m
      minutesRec(d('2026-09-15'), 480),
      rec('2026-09-16', [], 'CASUAL_LEAVE'),
      rec('2026-09-17', [ses('2026-09-17', '08:05', '12:35'), ses('2026-09-17', '13:20', '16:10')]),
      rec('2026-09-18', [ses('2026-09-18', '08:00', '14:50')]), // 6h 50m so far
    );
    const w = calculateWeeklyAttendance('2026-09-18', records, ctx(NOW_FRI));
    expect(w.requiredMinutes).toBe(1920);
    expect(w.workedMinutes).toBe(1820);
    expect(w.balanceMinutes).toBe(-100);
    expect(w.periodOvertimeMinutes).toBe(0);
    expect(w.counts.working).toBe(4);
    expect(w.counts.leaveDays).toBe(1);
    expect(w.counts.weeklyOffs).toBe(2);
  });

  it('a holiday removes its day from the weekly requirement', () => {
    const w = calculateWeeklyAttendance(
      '2026-09-16',
      {},
      ctx(NOW_PAST, { holidays: [companyHoliday('2026-09-16')] }),
    );
    expect(w.requiredMinutes).toBe(4 * 480);
    expect(w.counts.holidays).toBe(1);
  });

  it('reports weekly overtime separately from daily overtime (never added)', () => {
    const records = byDate(
      minutesRec('2026-09-14', 540), // +60 daily
      minutesRec('2026-09-15', 420), // -60
      minutesRec('2026-09-16', 540), // +60
      minutesRec('2026-09-17', 480),
      minutesRec('2026-09-18', 480),
    );
    const w = calculateWeeklyAttendance('2026-09-14', records, ctx(NOW_PAST));
    expect(w.balanceMinutes).toBe(60);
    expect(w.periodOvertimeMinutes).toBe(60);
    expect(w.dailyOvertimeMinutes).toBe(120);
  });

  it('handles a rule change in the middle of a week', () => {
    const ruleA = { ...RULE, effectiveTo: '2026-09-16' };
    const ruleB = { ...RULE, dailyRequiredMinutes: 450, weeklyRequiredMinutes: 2250, effectiveFrom: '2026-09-17' };
    const w = calculateWeeklyAttendance('2026-09-14', {}, ctx(NOW_PAST, { rules: [ruleA, ruleB] }));
    expect(w.requiredMinutes).toBe(3 * 480 + 2 * 450);
  });

  it('ignores days before the tracking start inside a week', () => {
    const w = calculateWeeklyAttendance('2026-09-02', {}, ctx(NOW_PAST, { trackingStartDate: '2026-09-03' }));
    // Week of 31 Aug: only Thu 3 and Fri 4 Sep count.
    expect(w.requiredMinutes).toBe(2 * 480);
  });

  it('lists incomplete and unrecorded dates', () => {
    const records = byDate(
      rec('2026-09-17', [ses('2026-09-17', '08:05', '12:35'), ses('2026-09-17', '16:45', null)]),
    );
    const w = calculateWeeklyAttendance('2026-09-14', records, ctx(NOW_FRI));
    expect(w.incompleteDates).toEqual(['2026-09-17']);
    expect(w.unrecordedDates).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });
});

describe('monthly calculation', () => {
  it('counts required time only through today for the current month', () => {
    const m = calculateMonthlyAttendance(2026, 9, {}, ctx(NOW_FRI));
    // Working days 1-18 Sep: 14. Whole month: 22 weekdays.
    expect(m.throughDate).toBe('2026-09-18');
    expect(m.requiredMinutes).toBe(14 * 480);
    expect(m.requiredFullPeriodMinutes).toBe(22 * 480);
    expect(m.unrecordedDates).toHaveLength(13); // today is not yet unrecorded
  });

  it('takes holidays into account', () => {
    const m = calculateMonthlyAttendance(
      2026,
      9,
      {},
      ctx(NOW_FRI, { holidays: [companyHoliday('2026-09-07')] }),
    );
    expect(m.requiredMinutes).toBe(13 * 480);
    expect(m.requiredFullPeriodMinutes).toBe(21 * 480);
    expect(m.counts.holidays).toBe(1);
  });

  it('a past month counts every day', () => {
    const m = calculateMonthlyAttendance(2026, 9, {}, ctx(at('2026-10-05', '09:00')));
    expect(m.throughDate).toBe('2026-09-30');
    expect(m.requiredMinutes).toBe(22 * 480);
  });
});
