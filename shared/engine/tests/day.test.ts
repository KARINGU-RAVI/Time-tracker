import { describe, expect, it } from 'vitest';
import { calculateDailyAttendance, EngineError } from '../src';
import {
  NOW_FRI,
  NOW_PAST,
  companyHoliday,
  ctx,
  optionalHoliday,
  rec,
  ses,
} from './helpers';

const D = '2026-09-15'; // Tuesday

describe('daily calculation: worked vs required', () => {
  it('exactly 8h has zero balance and no overtime', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '08:00', '12:00'), ses(D, '13:00', '17:00')]),
      D,
      ctx(NOW_PAST),
    );
    expect(r.kind).toBe('WORKING');
    expect(r.workedMinutes).toBe(480);
    expect(r.requiredMinutes).toBe(480);
    expect(r.balanceMinutes).toBe(0);
    expect(r.overtimeMinutes).toBe(0);
  });

  it('7h 30m is 30m short', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '08:00', '12:00'), ses(D, '13:00', '16:30')]),
      D,
      ctx(NOW_PAST),
    );
    expect(r.workedMinutes).toBe(450);
    expect(r.balanceMinutes).toBe(-30);
    expect(r.overtimeMinutes).toBe(0);
  });

  it('8h 30m is 30m overtime', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '08:00', '12:00'), ses(D, '13:00', '17:30')]),
      D,
      ctx(NOW_PAST),
    );
    expect(r.workedMinutes).toBe(510);
    expect(r.balanceMinutes).toBe(30);
    expect(r.overtimeMinutes).toBe(30);
  });

  it('matches the worked example in the spec (8h 15m, +15m, 75m outside)', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '08:00', '10:00'), ses(D, '10:30', '13:00'), ses(D, '13:45', '17:30')]),
      D,
      ctx(NOW_PAST),
    );
    expect(r.workedMinutes).toBe(495);
    expect(r.balanceMinutes).toBe(15);
    expect(r.outsideMinutes).toBe(75);
    expect(r.sessionCount).toBe(3);
    expect(r.firstIn).not.toBeNull();
    expect(r.lastOut).not.toBeNull();
  });
});

describe('open and incomplete sessions', () => {
  it('today: an open session counts up to now and marks the day as inside', () => {
    const today = '2026-09-18';
    const r = calculateDailyAttendance(rec(today, [ses(today, '08:30', null)]), today, ctx(NOW_FRI));
    expect(r.isToday).toBe(true);
    expect(r.isInside).toBe(true);
    expect(r.isIncomplete).toBe(false);
    expect(r.workedMinutes).toBe(432); // 08:30 -> 15:42
  });

  it('past day: an unclosed session is incomplete and excluded from worked', () => {
    const d = '2026-09-17';
    const r = calculateDailyAttendance(
      rec(d, [ses(d, '08:05', '12:35'), ses(d, '13:20', '16:10'), ses(d, '16:45', null)]),
      d,
      ctx(NOW_FRI),
    );
    expect(r.isIncomplete).toBe(true);
    expect(r.isInside).toBe(false);
    expect(r.workedMinutes).toBe(440);
    expect(r.balanceMinutes).toBe(-40);
    expect(r.outsideMinutes).toBe(80);
    expect(r.warnings).toContain('INCOMPLETE_SESSION');
  });
});

describe('day types', () => {
  it('company holiday: nothing required, no balance, no missing-hours warning', () => {
    const r = calculateDailyAttendance(undefined, D, ctx(NOW_PAST, { holidays: [companyHoliday(D)] }));
    expect(r.kind).toBe('HOLIDAY');
    expect(r.requiredMinutes).toBe(0);
    expect(r.balanceMinutes).toBeNull();
    expect(r.isUnrecorded).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('weekly off (Saturday) requires nothing', () => {
    const sat = '2026-09-19';
    const r = calculateDailyAttendance(undefined, sat, ctx(NOW_PAST));
    expect(r.kind).toBe('WEEKLY_OFF');
    expect(r.requiredMinutes).toBe(0);
    expect(r.isUnrecorded).toBe(false);
  });

  it('work on a weekly off is stored but excluded from worked and balance', () => {
    const sat = '2026-09-19';
    const r = calculateDailyAttendance(rec(sat, [ses(sat, '10:00', '12:00')]), sat, ctx(NOW_PAST));
    expect(r.workedMinutes).toBe(0);
    expect(r.offDayWorkedMinutes).toBe(120);
    expect(r.overtimeMinutes).toBe(0);
    expect(r.balanceMinutes).toBeNull();
    expect(r.warnings).toContain('WORKED_ON_OFF_DAY');
  });

  it('full casual leave: required 0, balance N/A, uses 1 annual day', () => {
    const r = calculateDailyAttendance(rec(D, [], 'CASUAL_LEAVE'), D, ctx(NOW_PAST));
    expect(r.kind).toBe('FULL_LEAVE');
    expect(r.requiredMinutes).toBe(0);
    expect(r.balanceMinutes).toBeNull();
    expect(r.leaveUse).toEqual({ pool: 'ANNUAL', days: 1 });
    expect(r.isUnrecorded).toBe(false);
  });

  it('half-day leave needs 4h and uses 0.5 annual day', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '09:00', '13:00')], 'SICK_LEAVE', 0.5),
      D,
      ctx(NOW_PAST),
    );
    expect(r.kind).toBe('HALF_DAY_LEAVE');
    expect(r.requiredMinutes).toBe(240);
    expect(r.workedMinutes).toBe(240);
    expect(r.balanceMinutes).toBe(0);
    expect(r.leaveUse).toEqual({ pool: 'ANNUAL', days: 0.5 });
  });

  it('rejects a half day on a non-leave status', () => {
    const r = calculateDailyAttendance(rec(D, [], 'WORKING', 0.5), D, ctx(NOW_PAST));
    expect(r.warnings).toContain('INVALID_FRACTION');
    expect(r.requiredMinutes).toBe(480);
  });

  it('WFH counts like a working day', () => {
    const r = calculateDailyAttendance(
      rec(D, [ses(D, '09:00', '13:00'), ses(D, '14:00', '18:00')], 'WFH'),
      D,
      ctx(NOW_PAST),
    );
    expect(r.kind).toBe('WFH');
    expect(r.requiredMinutes).toBe(480);
    expect(r.workedMinutes).toBe(480);
    expect(r.balanceMinutes).toBe(0);
  });

  it('bereavement and optional holiday need no work and use their own pools', () => {
    const b = calculateDailyAttendance(rec(D, [], 'BEREAVEMENT_LEAVE'), D, ctx(NOW_PAST));
    expect(b.requiredMinutes).toBe(0);
    expect(b.leaveUse).toEqual({ pool: 'BEREAVEMENT', days: 1 });

    const o = calculateDailyAttendance(
      rec(D, [], 'OPTIONAL_HOLIDAY'),
      D,
      ctx(NOW_PAST, { holidays: [optionalHoliday(D)] }),
    );
    expect(o.kind).toBe('OPTIONAL_HOLIDAY');
    expect(o.leaveUse).toEqual({ pool: 'OPTIONAL', days: 1 });
    expect(o.warnings).toEqual([]);
  });

  it('warns when an optional holiday is not in the holiday list', () => {
    const o = calculateDailyAttendance(rec(D, [], 'OPTIONAL_HOLIDAY'), D, ctx(NOW_PAST));
    expect(o.warnings).toContain('OPTIONAL_HOLIDAY_NOT_LISTED');
  });

  it('an optional holiday that is not taken is a normal working day', () => {
    const r = calculateDailyAttendance(undefined, D, ctx(NOW_PAST, { holidays: [optionalHoliday(D)] }));
    expect(r.kind).toBe('WORKING');
    expect(r.requiredMinutes).toBe(480);
  });

  it('leave on a holiday does not use leave and is flagged', () => {
    const r = calculateDailyAttendance(
      rec(D, [], 'CASUAL_LEAVE'),
      D,
      ctx(NOW_PAST, { holidays: [companyHoliday(D)] }),
    );
    expect(r.kind).toBe('HOLIDAY');
    expect(r.leaveUse).toBeNull();
    expect(r.warnings).toContain('LEAVE_ON_NON_WORKING_DAY');
  });
});

describe('unrecorded, future and pre-tracking days', () => {
  it('a past working day with no record is a flagged full shortfall', () => {
    const r = calculateDailyAttendance(undefined, D, ctx(NOW_PAST));
    expect(r.isUnrecorded).toBe(true);
    expect(r.requiredMinutes).toBe(480);
    expect(r.workedMinutes).toBe(0);
    expect(r.balanceMinutes).toBe(-480);
    expect(r.warnings).toContain('UNRECORDED_DAY');
  });

  it("today with no record is not 'unrecorded' yet", () => {
    const today = '2026-09-18';
    const r = calculateDailyAttendance(undefined, today, ctx(NOW_FRI));
    expect(r.isUnrecorded).toBe(false);
    expect(r.requiredMinutes).toBe(480);
  });

  it('future working days carry a requirement but no balance', () => {
    const r = calculateDailyAttendance(undefined, '2026-09-22', ctx(NOW_FRI));
    expect(r.isFuture).toBe(true);
    expect(r.requiredMinutes).toBe(480);
    expect(r.balanceMinutes).toBeNull();
    expect(r.isUnrecorded).toBe(false);
  });

  it('days before the tracking start are ignored', () => {
    const r = calculateDailyAttendance(undefined, '2026-08-31', ctx(NOW_PAST));
    expect(r.kind).toBe('BEFORE_TRACKING');
    expect(r.requiredMinutes).toBe(0);
  });

  it('throws NO_RULE instead of using a silent default', () => {
    expect(() => calculateDailyAttendance(undefined, D, ctx(NOW_PAST, { rules: [] }))).toThrow(EngineError);
  });
});

describe('historical calculation and rule changes', () => {
  const ruleA = { ...RULE_A(), effectiveTo: '2026-09-16' };
  const ruleB = { ...RULE_A(), dailyRequiredMinutes: 450, effectiveFrom: '2026-09-17', effectiveTo: null };

  it('a past date keeps the rule that applied then, after a new rule is added', () => {
    const c = ctx(NOW_PAST, { rules: [ruleA, ruleB] });
    expect(calculateDailyAttendance(undefined, '2026-09-16', c).requiredMinutes).toBe(480);
    expect(calculateDailyAttendance(undefined, '2026-09-17', c).requiredMinutes).toBe(450);
  });

  it('recalculates from raw sessions when a record is corrected', () => {
    const c = ctx(NOW_PAST);
    const wrong = calculateDailyAttendance(rec(D, [ses(D, '08:00', '16:00')]), D, c);
    const fixed = calculateDailyAttendance(rec(D, [ses(D, '08:00', '17:00')]), D, c);
    expect(wrong.balanceMinutes).toBe(0);
    expect(fixed.balanceMinutes).toBe(60);
  });
});

function RULE_A() {
  return {
    dailyRequiredMinutes: 480,
    weeklyRequiredMinutes: 2400,
    halfDayRequiredMinutes: 240,
    workingDays: [1, 2, 3, 4, 5],
    weekStartsOn: 1,
    effectiveFrom: '2026-09-01',
    effectiveTo: null as string | null,
  };
}
