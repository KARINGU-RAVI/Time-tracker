import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from './api';
import { monthGrid, monthTitle, prettyDate, shiftMonth, dayLabel } from './dates';
import { dayBalanceLabel, dayMessage, dayStatus, minutesBetween } from './status';
import type { Day } from './types';

const day = (over: Partial<Day> = {}): Day => ({
  date: '2026-09-15',
  kind: 'WORKING',
  isToday: false,
  isFuture: false,
  requiredMinutes: 480,
  workedMinutes: 480,
  offDayWorkedMinutes: 0,
  outsideMinutes: 0,
  sessionCount: 1,
  firstIn: null,
  firstInClock: null,
  lastOut: null,
  lastOutClock: null,
  balanceMinutes: 0,
  overtimeMinutes: 0,
  isInside: false,
  isIncomplete: false,
  isUnrecorded: false,
  leaveUse: null,
  warnings: [],
  ...over,
});

describe('dayStatus', () => {
  it('labels every status with text and an icon, not just a colour', () => {
    expect(dayStatus(day())).toMatchObject({ label: 'Target met', tone: 'ok', icon: 'check' });
    expect(dayStatus(day({ balanceMinutes: -30 }))).toMatchObject({ label: 'Short', tone: 'warn' });
    expect(dayStatus(day({ kind: 'WFH' }))).toMatchObject({ label: 'WFH', tone: 'wfh', icon: 'home' });
    expect(dayStatus(day({ kind: 'FULL_LEAVE' }))).toMatchObject({ label: 'Leave', tone: 'leave' });
    expect(dayStatus(day({ kind: 'HOLIDAY' }))).toMatchObject({ label: 'Holiday', tone: 'holiday' });
    expect(dayStatus(day({ kind: 'WEEKLY_OFF' }))).toMatchObject({ label: 'Weekly off', tone: 'off' });
  });

  it('flags problems above everything else', () => {
    expect(dayStatus(day({ isIncomplete: true, balanceMinutes: 0 }))).toMatchObject({ label: 'Needs fix', tone: 'bad' });
    expect(dayStatus(day({ isUnrecorded: true }))).toMatchObject({ label: 'No record', tone: 'bad' });
  });

  it('never calls a leave, holiday or off day "short"', () => {
    for (const kind of ['FULL_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'BEREAVEMENT', 'OPTIONAL_HOLIDAY'] as const) {
      expect(dayStatus(day({ kind, requiredMinutes: 0, balanceMinutes: null })).label).not.toBe('Short');
    }
  });

  it('shows today as in progress and future days as upcoming', () => {
    expect(dayStatus(day({ isToday: true, balanceMinutes: -100 }))).toMatchObject({ label: 'In progress', tone: 'ok' });
    expect(dayStatus(day({ isFuture: true, balanceMinutes: null }))).toMatchObject({ label: 'Upcoming' });
  });
});

describe('dayMessage ("Can I leave now?")', () => {
  it('matches the engine wording', () => {
    expect(dayMessage(480, 455)).toBe('You need 25m more.');
    expect(dayMessage(480, 480)).toBe("Today's required hours are completed.");
    expect(dayMessage(480, 510)).toBe('8h 30m completed — 30m overtime.');
    expect(dayMessage(0, 0)).toBe('No work is required today.');
  });

  it('measures minutes between instants', () => {
    expect(minutesBetween('2026-09-17T03:00:00Z', '2026-09-17T04:30:59Z')).toBe(90);
    expect(minutesBetween('2026-09-17T04:00:00Z', '2026-09-17T03:00:00Z')).toBe(0);
  });
});

describe('dates', () => {
  it('formats dates in the app style', () => {
    expect(prettyDate('2026-09-18')).toBe('Fri, 18 Sep 2026');
    expect(dayLabel('2026-09-17')).toBe('Thu 17 Sep');
    expect(monthTitle(2026, 9)).toBe('September 2026');
  });

  it('moves between months across year boundaries', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('lays out September 2026 with Monday first (1 Sep is a Tuesday)', () => {
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(5);
    expect(grid[0]?.[0]).toBeNull();
    expect(grid[0]?.[1]).toBe('2026-09-01');
    expect(grid.flat().filter(Boolean)).toHaveLength(30);
    expect(grid.every((w) => w.length === 7)).toBe(true);
  });
});

describe('toApiError', () => {
  it('turns a network failure into a friendly message', () => {
    const e = toApiError(new AxiosError('Network Error', 'ERR_NETWORK'));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isNetwork).toBe(true);
    expect(e.message).toBe("Can't reach the server. Check your connection and try again.");
  });

  it('keeps the server message and code', () => {
    const response = { status: 409, data: { error: { code: 'OVERLAP', message: 'This overlaps your 08:05-12:35 session.' } } } as AxiosResponse;
    const e = toApiError(new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, response));
    expect(e).toMatchObject({ code: 'OVERLAP', status: 409, message: 'This overlaps your 08:05-12:35 session.' });
    expect(e.isNetwork).toBe(false);
  });

  it('never leaks unknown error text', () => {
    expect(toApiError(new Error('SELECT * FROM secrets')).message).toBe('Something went wrong. Please try again.');
  });
});

describe('birthday half-day status', () => {
  it('has its own label, in the leave colour with an icon (never colour alone)', () => {
    expect(dayStatus(day({ kind: 'BIRTHDAY_HALF_DAY', requiredMinutes: 240 }))).toMatchObject({ label: 'Birthday half-day', tone: 'leave', icon: 'leave' });
  });
});

describe('dayBalanceLabel', () => {
  it('shows the signed balance once the day has counted', () => {
    expect(dayBalanceLabel(day({ balanceMinutes: 10 }))).toEqual({ text: '+10m', hint: null });
    expect(dayBalanceLabel(day({ balanceMinutes: -70 }))).toEqual({ text: '-1h 10m', hint: null });
    expect(dayBalanceLabel(day({ balanceMinutes: 0 }))).toEqual({ text: '0m', hint: null });
  });
  it('says Pending for a working day that has not happened yet', () => {
    expect(dayBalanceLabel(day({ balanceMinutes: null, isFuture: true, requiredMinutes: 480 }))).toEqual({ text: 'Pending', hint: 'Counted once the day has passed' });
  });
  it('shows a dash where nothing is required (weekly off, holiday, leave), past or future', () => {
    for (const over of [{ kind: 'WEEKLY_OFF' as const }, { kind: 'HOLIDAY' as const }, { kind: 'FULL_LEAVE' as const }]) {
      for (const isFuture of [false, true]) {
        expect(dayBalanceLabel(day({ ...over, requiredMinutes: 0, balanceMinutes: null, isFuture }))).toEqual({ text: '–', hint: 'Nothing is required this day' });
      }
    }
  });
});

