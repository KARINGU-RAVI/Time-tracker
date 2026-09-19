import { MINUTE_MS, floorToMinute, istClock, istDateOf } from './time';
import type { Session, SessionIssue } from './types';

export const DEFAULT_MAX_SESSION_MINUTES = 16 * 60;

function byIn(a: Session, b: Session): number {
  return a.inTime - b.inTime;
}

/**
 * Validates a set of sessions belonging to one user (R-05..R-08).
 * Touching sessions (OUT 10:00, next IN 10:00) are allowed.
 * Returns an empty array when everything is valid.
 */
export function validateSessions(
  sessions: Session[],
  options: { maxSessionMinutes?: number; date?: string } = {},
): SessionIssue[] {
  const max = options.maxSessionMinutes ?? DEFAULT_MAX_SESSION_MINUTES;
  const issues: SessionIssue[] = [];
  const sorted = [...sessions].sort(byIn);

  const openCount = sorted.filter((s) => s.outTime === null).length;
  if (openCount > 1) {
    const first = sorted.find((s) => s.outTime === null)!;
    issues.push({
      code: 'MULTIPLE_OPEN',
      message: `You are already checked in since ${istClock(first.inTime)}.`,
    });
  }

  sorted.forEach((s, index) => {
    const inMin = floorToMinute(s.inTime);
    if (options.date && istDateOf(s.inTime) !== options.date) {
      issues.push({
        code: 'IN_DATE_MISMATCH',
        message: 'The IN time must fall on the selected date.',
        index,
      });
    }
    if (s.outTime !== null) {
      const outMin = floorToMinute(s.outTime);
      if (outMin < inMin) {
        issues.push({ code: 'OUT_BEFORE_IN', message: 'OUT must be after IN.', index });
      } else if (outMin === inMin) {
        issues.push({ code: 'ZERO_LENGTH', message: 'OUT must be after IN.', index });
      } else if ((outMin - inMin) / MINUTE_MS > max) {
        issues.push({
          code: 'TOO_LONG',
          message: `This session is longer than ${Math.round(max / 60)} hours. Check the date and time.`,
          index,
        });
      }
    }
  });

  let prev: Session | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (prev) {
      const prevEnd = prev.outTime === null ? Number.POSITIVE_INFINITY : floorToMinute(prev.outTime);
      if (floorToMinute(cur.inTime) < prevEnd) {
        const prevOut = prev.outTime === null ? 'now' : istClock(prev.outTime);
        issues.push({
          code: 'OVERLAP',
          message: `This overlaps your ${istClock(prev.inTime)}-${prevOut} session.`,
          index: i,
        });
      }
    }
    prev = cur;
  }
  return issues;
}

export interface WorkedResult {
  /** Minutes inside the office that count (R-02). */
  workedMinutes: number;
  /** True when an open session belongs to a past date (R-09). */
  incomplete: boolean;
  /** True when an open session exists on today's date. */
  hasOpenSessionToday: boolean;
}

/**
 * Worked minutes for the sessions of one attendance date.
 *  - Closed sessions count (OUT - IN).
 *  - An open session counts up to `now`, but only when the date is today.
 *  - An open session on a past date counts as 0 and marks the day incomplete.
 * Intervals are merged, so accidental overlaps can never over-count.
 */
export function calculateWorkedMinutes(
  sessions: Session[],
  ctx: { now: number; date: string },
): WorkedResult {
  const today = istDateOf(ctx.now);
  const intervals: Array<[number, number]> = [];
  let incomplete = false;
  let hasOpenSessionToday = false;

  for (const s of sessions) {
    const start = floorToMinute(s.inTime);
    if (s.outTime !== null) {
      const end = floorToMinute(s.outTime);
      if (end > start) intervals.push([start, end]);
    } else if (ctx.date === today) {
      hasOpenSessionToday = true;
      const end = floorToMinute(ctx.now);
      if (end > start) intervals.push([start, end]);
    } else if (ctx.date < today) {
      incomplete = true;
    }
  }

  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = 0;
  let curEnd = 0;
  let has = false;
  for (const [s, e] of intervals) {
    if (!has) {
      curStart = s;
      curEnd = e;
      has = true;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (has) total += curEnd - curStart;

  return {
    workedMinutes: Math.round(total / MINUTE_MS),
    incomplete,
    hasOpenSessionToday,
  };
}

/**
 * Minutes spent outside between sessions (R-03). Time before the first IN and
 * after the last OUT is not counted. A gap that ends at an open session counts.
 */
export function calculateOutsideMinutes(sessions: Session[]): number {
  const sorted = [...sessions].sort(byIn);
  let lastEnd: number | null = null;
  let total = 0;
  for (const s of sorted) {
    const start = floorToMinute(s.inTime);
    if (lastEnd !== null && start > lastEnd) total += start - lastEnd;
    if (s.outTime === null) {
      lastEnd = null;
    } else {
      const end = floorToMinute(s.outTime);
      lastEnd = lastEnd === null ? end : Math.max(lastEnd, end);
    }
  }
  return Math.round(total / MINUTE_MS);
}

export function firstIn(sessions: Session[]): number | null {
  if (sessions.length === 0) return null;
  return Math.min(...sessions.map((s) => s.inTime));
}

/** Latest recorded OUT (ignores open sessions), or null. */
export function lastOut(sessions: Session[]): number | null {
  const outs = sessions.flatMap((s) => (s.outTime === null ? [] : [s.outTime]));
  return outs.length === 0 ? null : Math.max(...outs);
}
