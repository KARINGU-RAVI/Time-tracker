import { describe, expect, it } from 'vitest';
import {
  addDays,
  eachDate,
  formatDuration,
  formatLeaveDays,
  isoWeekday,
  istClock,
  istClock12,
  istDateOf,
  istInstant,
  lastDayOfMonth,
  startOfWeek,
} from '../src';

describe('IST time helpers', () => {
  it('maps instants to IST calendar dates across midnight', () => {
    const t = istInstant('2026-09-14', '23:30');
    expect(istDateOf(t)).toBe('2026-09-14');
    expect(istDateOf(t + 60 * 60_000)).toBe('2026-09-15');
  });

  it('uses IST even when UTC is still on the previous day', () => {
    // 01:00 IST on 15 Sep is 19:30 UTC on 14 Sep.
    expect(istDateOf(istInstant('2026-09-15', '01:00'))).toBe('2026-09-15');
  });

  it('formats clocks', () => {
    expect(istClock(istInstant('2026-09-18', '08:05'))).toBe('08:05');
    expect(istClock12(istInstant('2026-09-18', '16:52'))).toBe('4:52 PM');
    expect(istClock12(istInstant('2026-09-18', '00:10'))).toBe('12:10 AM');
    expect(istClock12(istInstant('2026-09-18', '12:00'))).toBe('12:00 PM');
  });

  it('computes weekdays and week starts', () => {
    expect(isoWeekday('2026-09-18')).toBe(5); // Friday
    expect(isoWeekday('2026-09-20')).toBe(7); // Sunday
    expect(startOfWeek('2026-09-20', 1)).toBe('2026-09-14');
    expect(startOfWeek('2026-09-14', 1)).toBe('2026-09-14');
  });

  it('does date arithmetic without DST issues', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(eachDate('2026-09-14', '2026-09-16')).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(lastDayOfMonth(2026, 2)).toBe('2026-02-28');
    expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29');
  });
});

describe('formatDuration', () => {
  it('formats as Xh Ym, never decimals', () => {
    expect(formatDuration(480)).toBe('8h 00m');
    expect(formatDuration(495)).toBe('8h 15m');
    expect(formatDuration(35)).toBe('35m');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(1920)).toBe('32h 00m');
  });

  it('handles negative and signed values', () => {
    expect(formatDuration(-100)).toBe('-1h 40m');
    expect(formatDuration(-40)).toBe('-40m');
    expect(formatDuration(10, { signed: true })).toBe('+10m');
    expect(formatDuration(0, { signed: true })).toBe('0m');
  });

  it('formats leave days with two decimals', () => {
    expect(formatLeaveDays(12.75)).toBe('12.75');
    expect(formatLeaveDays(2)).toBe('2.00');
  });
});
