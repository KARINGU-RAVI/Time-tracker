import { describe, expect, it } from 'vitest';
import {
  calculateDailyAttendance,
  calculateExpectedCheckout,
  calculateOvertime,
  calculateRemainingMinutes,
  canILeaveNow,
  istClock12,
} from '../src';
import { at, ctx, rec, ses } from './helpers';

const TODAY = '2026-09-18';

function day(sessions: ReturnType<typeof ses>[], nowHHMM: string) {
  const now = at(TODAY, nowHHMM);
  return { now, result: calculateDailyAttendance(rec(TODAY, sessions), TODAY, ctx(now)) };
}

describe('remaining, overtime, expected OUT', () => {
  it('remaining and overtime helpers', () => {
    expect(calculateRemainingMinutes(480, 420)).toBe(60);
    expect(calculateRemainingMinutes(480, 500)).toBe(0);
    expect(calculateOvertime(480, 500)).toBe(20);
    expect(calculateOvertime(0, 100)).toBe(0);
  });

  it('spec example: 420m done, 60m remaining, at 16:00 expected OUT is 17:00', () => {
    // 09:00-13:00 (240) + 13:00-... needs 420 by 16:00 with an open session.
    const { now, result } = day([ses(TODAY, '09:00', '12:00'), ses(TODAY, '12:00', null)], '16:00');
    expect(result.workedMinutes).toBe(420);
    const live = calculateExpectedCheckout(result, now);
    expect(live.status).toBe('INSIDE');
    expect(live.remainingMinutes).toBe(60);
    expect(live.expectedOutAt).toBe(at(TODAY, '17:00'));
  });

  it('counts the active session correctly (open since 08:30, now 15:00)', () => {
    const { now, result } = day([ses(TODAY, '08:30', null)], '15:00');
    const live = calculateExpectedCheckout(result, now);
    expect(result.workedMinutes).toBe(390);
    expect(live.remainingMinutes).toBe(90);
    expect(istClock12(live.expectedOutAt!)).toBe('4:30 PM');
  });

  it('while outside, offers the time if the user returns now', () => {
    const { now, result } = day([ses(TODAY, '08:00', '12:00')], '12:45');
    const live = calculateExpectedCheckout(result, now);
    expect(live.status).toBe('OUTSIDE');
    expect(live.expectedOutAt).toBeNull();
    expect(live.ifCheckInNowOutAt).toBe(at(TODAY, '16:45'));
  });

  it('before starting, reports NOT_STARTED with the earliest finish', () => {
    const now = at(TODAY, '08:00');
    const result = calculateDailyAttendance(undefined, TODAY, ctx(now));
    const live = calculateExpectedCheckout(result, now);
    expect(live.status).toBe('NOT_STARTED');
    expect(live.ifCheckInNowOutAt).toBe(at(TODAY, '16:00'));
  });

  it('reports COMPLETED once the requirement is met', () => {
    const { now, result } = day([ses(TODAY, '08:00', '16:00')], '16:30');
    expect(calculateExpectedCheckout(result, now).status).toBe('COMPLETED');
  });

  it('no work required on a leave day', () => {
    const now = at(TODAY, '11:00');
    const result = calculateDailyAttendance(rec(TODAY, [], 'CASUAL_LEAVE'), TODAY, ctx(now));
    expect(calculateExpectedCheckout(result, now).status).toBe('NO_WORK_REQUIRED');
    expect(canILeaveNow(result)).toBe('No work is required today.');
  });
});

describe('"Can I leave now?"', () => {
  it('needs more time', () => {
    const { result } = day([ses(TODAY, '08:00', '15:35')], '15:40');
    expect(canILeaveNow(result)).toBe('You need 25m more.');
  });

  it('exactly complete', () => {
    const { result } = day([ses(TODAY, '08:00', '16:00')], '16:10');
    expect(canILeaveNow(result)).toBe("Today's required hours are completed.");
  });

  it('overtime', () => {
    const { result } = day([ses(TODAY, '08:00', '16:30')], '16:45');
    expect(canILeaveNow(result)).toBe('8h 30m completed — 30m overtime.');
  });
});
