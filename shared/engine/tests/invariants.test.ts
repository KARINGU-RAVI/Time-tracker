import { describe, expect, it } from 'vitest';
import {
  calculateDailyAttendance,
  calculateMonthlyAttendance,
  calculateOutsideMinutes,
  calculateWeeklyAttendance,
  calculateWorkedMinutes,
  istDateOf,
  istInstant,
  resolveRule,
  rulesOverlap,
  validateSessions,
  type Session,
} from '../src';
import { NOW_PAST, RULE, ctx, optionalHoliday, rec, ses } from './helpers';

/** Small deterministic PRNG so failures are reproducible (no extra dependency). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Random, non-overlapping, closed sessions inside one IST day. */
function randomDay(rand: () => number, date: string): Session[] {
  const sessions: Session[] = [];
  let cursor = 6 * 60 + Math.floor(rand() * 180); // 06:00-09:00
  const count = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < count; i++) {
    const length = 5 + Math.floor(rand() * 200);
    const gap = Math.floor(rand() * 90);
    const start = cursor + gap;
    const end = start + length;
    if (end >= 24 * 60) break;
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    sessions.push(ses(date, hh(start), hh(end)));
    cursor = end;
  }
  return sessions;
}

describe('invariants over many random days', () => {
  const D = '2026-09-15';
  const days = Array.from({ length: 300 }, (_, i) => randomDay(prng(i + 1), D)).filter((s) => s.length > 0);

  it('worked + outside always equals the span from first IN to last OUT', () => {
    for (const sessions of days) {
      const worked = calculateWorkedMinutes(sessions, { now: NOW_PAST, date: D }).workedMinutes;
      const outside = calculateOutsideMinutes(sessions);
      const first = Math.min(...sessions.map((s) => s.inTime));
      const last = Math.max(...sessions.map((s) => s.outTime!));
      expect(worked + outside).toBe(Math.round((last - first) / 60_000));
    }
  });

  it('valid generated sessions never produce validation issues', () => {
    for (const sessions of days) expect(validateSessions(sessions, { date: D })).toEqual([]);
  });

  it('balance is always worked - required, and overtime is never negative', () => {
    for (const sessions of days) {
      const r = calculateDailyAttendance(rec(D, sessions), D, ctx(NOW_PAST));
      expect(r.balanceMinutes).toBe(r.workedMinutes - r.requiredMinutes);
      expect(r.overtimeMinutes).toBe(Math.max(0, r.workedMinutes - r.requiredMinutes));
      expect(r.overtimeMinutes).toBeGreaterThanOrEqual(0);
      expect(r.workedMinutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('is order independent: shuffled sessions give identical results', () => {
    const rand = prng(99);
    for (const sessions of days.slice(0, 60)) {
      const shuffled = [...sessions].sort(() => rand() - 0.5);
      const a = calculateDailyAttendance(rec(D, sessions), D, ctx(NOW_PAST));
      const b = calculateDailyAttendance(rec(D, shuffled), D, ctx(NOW_PAST));
      expect(b).toEqual(a);
    }
  });

  it('adding a valid session never reduces worked time', () => {
    for (const sessions of days.slice(0, 80)) {
      const before = calculateWorkedMinutes(sessions, { now: NOW_PAST, date: D }).workedMinutes;
      const last = Math.max(...sessions.map((s) => s.outTime!));
      const extra: Session = { inTime: last + 60_000, outTime: last + 31 * 60_000 };
      const after = calculateWorkedMinutes([...sessions, extra], { now: NOW_PAST, date: D }).workedMinutes;
      expect(after).toBe(before + 30);
    }
  });

  it('is deterministic: the same input always gives the same output', () => {
    const sessions = days[0]!;
    const first = calculateDailyAttendance(rec(D, sessions), D, ctx(NOW_PAST));
    for (let i = 0; i < 20; i++) expect(calculateDailyAttendance(rec(D, sessions), D, ctx(NOW_PAST))).toEqual(first);
  });

  it('never mutates its inputs', () => {
    const sessions = days[1]!;
    const record = rec(D, sessions);
    const snapshot = JSON.stringify(record);
    calculateDailyAttendance(record, D, ctx(NOW_PAST));
    calculateWeeklyAttendance(D, { [D]: record }, ctx(NOW_PAST));
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});

describe('device timezone must not matter (IST only)', () => {
  const zones = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland', 'Europe/London', 'Asia/Tokyo'];

  it('gives identical results whatever timezone the machine is set to', () => {
    const original = process.env.TZ;
    const results: string[] = [];
    try {
      for (const tz of zones) {
        process.env.TZ = tz;
        const D = '2026-09-14';
        const day = calculateDailyAttendance(
          rec(D, [ses(D, '00:30', '03:00'), { inTime: istInstant(D, '22:00'), outTime: istInstant('2026-09-15', '02:00') }]),
          D,
          ctx(NOW_PAST),
        );
        const week = calculateWeeklyAttendance('2026-09-16', {}, ctx(NOW_PAST));
        const month = calculateMonthlyAttendance(2026, 9, {}, ctx(NOW_PAST));
        results.push(
          JSON.stringify({ day, week: [week.start, week.end, week.requiredMinutes], month: month.requiredMinutes, d: istDateOf(istInstant(D, '00:10')) }),
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(new Set(results).size).toBe(1);
  });

  it('maps an instant near midnight to the right IST date in every timezone', () => {
    const original = process.env.TZ;
    try {
      for (const tz of zones) {
        process.env.TZ = tz;
        expect(istDateOf(Date.UTC(2026, 8, 14, 18, 29))).toBe('2026-09-14'); // 23:59 IST
        expect(istDateOf(Date.UTC(2026, 8, 14, 18, 30))).toBe('2026-09-15'); // 00:00 IST
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('rules', () => {
  it('detects overlapping and non-overlapping rule versions', () => {
    const a = { ...RULE, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' };
    expect(rulesOverlap(a, { ...RULE, effectiveFrom: '2026-07-01', effectiveTo: null })).toBe(false);
    expect(rulesOverlap(a, { ...RULE, effectiveFrom: '2026-06-30', effectiveTo: null })).toBe(true);
    expect(rulesOverlap({ ...RULE, effectiveFrom: '2026-01-01', effectiveTo: null }, { ...RULE, effectiveFrom: '2030-01-01', effectiveTo: null })).toBe(true);
  });

  it('resolves on the boundary dates of a rule', () => {
    const rules = [
      { ...RULE, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', dailyRequiredMinutes: 450 },
      { ...RULE, effectiveFrom: '2026-07-01', effectiveTo: null },
    ];
    expect(resolveRule(rules, '2026-06-30').dailyRequiredMinutes).toBe(450);
    expect(resolveRule(rules, '2026-07-01').dailyRequiredMinutes).toBe(480);
    expect(() => resolveRule(rules, '2025-12-31')).toThrow(/No work rule/);
  });
});

describe('period totals for every day type', () => {
  it('counts optional holidays and bereavement days and gives them no requirement', () => {
    const c = ctx(NOW_PAST, { holidays: [optionalHoliday('2026-09-15')] });
    const w = calculateWeeklyAttendance(
      '2026-09-14',
      {
        '2026-09-15': rec('2026-09-15', [], 'OPTIONAL_HOLIDAY'),
        '2026-09-16': rec('2026-09-16', [], 'BEREAVEMENT_LEAVE'),
        '2026-09-17': rec('2026-09-17', [ses('2026-09-17', '09:00', '13:00')], 'SICK_LEAVE', 0.5),
      },
      c,
    );
    expect(w.counts.optionalHolidays).toBe(1);
    expect(w.counts.bereavementDays).toBe(1);
    expect(w.counts.leaveDays).toBe(0.5);
    expect(w.counts.working).toBe(3); // Mon, half-day Thu, Fri
    expect(w.requiredMinutes).toBe(480 + 240 + 480);
  });

  it('refuses to guess when no rule applies (R-27), instead of using a default', () => {
    const noRules = ctx(NOW_PAST, { trackingStartDate: '2026-08-01', rules: [] });
    expect(() => calculateWeeklyAttendance('2026-08-19', {}, noRules)).toThrow(/No work rule/);
    expect(() => calculateMonthlyAttendance(2026, 8, {}, noRules)).toThrow(/No work rule/);
  });

  it('ignores the missing rule for days before the tracking start', () => {
    const c = ctx(NOW_PAST, { trackingStartDate: '2026-09-15', rules: [{ ...RULE, effectiveFrom: '2026-09-15' }] });
    const w = calculateWeeklyAttendance('2026-09-14', {}, c);
    expect(w.requiredMinutes).toBe(4 * 480); // Tue 15 to Fri 18; Mon 14 is before tracking
  });
});
