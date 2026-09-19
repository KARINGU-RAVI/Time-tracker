import { formatDuration } from './format';
import { MINUTE_MS, floorToMinute } from './time';
import { calculateRemainingMinutes } from './day';
import type { DayResult } from './types';

export type OfficeStatus = 'NOT_STARTED' | 'INSIDE' | 'OUTSIDE' | 'COMPLETED' | 'NO_WORK_REQUIRED';

export interface LiveStatus {
  status: OfficeStatus;
  remainingMinutes: number;
  /** When the user would be done if they stay inside from now (only while INSIDE). */
  expectedOutAt: number | null;
  /** When the user would be done if they check in right now (while OUTSIDE or NOT_STARTED). */
  ifCheckInNowOutAt: number | null;
}

/**
 * Remaining time and expected OUT for today (R-22).
 * `day.workedMinutes` already includes the open session up to now, so
 * expectedOut = now + (required - worked).
 */
export function calculateExpectedCheckout(day: DayResult, now: number): LiveStatus {
  if (day.requiredMinutes <= 0) {
    return { status: 'NO_WORK_REQUIRED', remainingMinutes: 0, expectedOutAt: null, ifCheckInNowOutAt: null };
  }
  const remaining = calculateRemainingMinutes(day.requiredMinutes, day.workedMinutes);
  const nowMin = floorToMinute(now);
  const at = nowMin + remaining * MINUTE_MS;

  if (remaining === 0) {
    return { status: 'COMPLETED', remainingMinutes: 0, expectedOutAt: null, ifCheckInNowOutAt: null };
  }
  if (day.isInside) {
    return { status: 'INSIDE', remainingMinutes: remaining, expectedOutAt: at, ifCheckInNowOutAt: null };
  }
  return {
    status: day.sessionCount === 0 ? 'NOT_STARTED' : 'OUTSIDE',
    remainingMinutes: remaining,
    expectedOutAt: null,
    ifCheckInNowOutAt: at,
  };
}

/** The "Can I leave now?" message (R-23). */
export function canILeaveNow(day: DayResult): string {
  if (day.requiredMinutes <= 0) return 'No work is required today.';
  if (day.workedMinutes < day.requiredMinutes) {
    return `You need ${formatDuration(day.requiredMinutes - day.workedMinutes)} more.`;
  }
  if (day.workedMinutes === day.requiredMinutes) return "Today's required hours are completed.";
  return `${formatDuration(day.workedMinutes)} completed — ${formatDuration(
    day.workedMinutes - day.requiredMinutes,
  )} overtime.`;
}
