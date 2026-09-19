import { describe, expect, it } from 'vitest';
import {
  calculateOutsideMinutes,
  calculateWorkedMinutes,
  firstIn,
  lastOut,
  validateSessions,
} from '../src';
import { at, ses, sesX } from './helpers';

const D = '2026-09-17';
const NOW_LATER = at('2026-09-18', '10:00');

describe('worked and outside minutes', () => {
  it('sums closed sessions and ignores the gaps between them', () => {
    const sessions = [ses(D, '08:00', '10:00'), ses(D, '10:30', '13:00'), ses(D, '13:45', '17:30')];
    expect(calculateWorkedMinutes(sessions, { now: NOW_LATER, date: D }).workedMinutes).toBe(495);
    expect(calculateOutsideMinutes(sessions)).toBe(75);
    expect(firstIn(sessions)).toBe(at(D, '08:00'));
    expect(lastOut(sessions)).toBe(at(D, '17:30'));
  });

  it('supports unlimited sessions', () => {
    const sessions = [
      ses(D, '08:00', '10:00'),
      ses(D, '10:20', '13:00'),
      ses(D, '13:45', '16:00'),
      ses(D, '16:15', '18:00'),
    ];
    expect(calculateWorkedMinutes(sessions, { now: NOW_LATER, date: D }).workedMinutes).toBe(520);
    expect(calculateOutsideMinutes(sessions)).toBe(20 + 45 + 15);
  });

  it('counts a very short break as outside time', () => {
    const sessions = [ses(D, '08:00', '12:00'), ses(D, '12:02', '16:02')];
    expect(calculateWorkedMinutes(sessions, { now: NOW_LATER, date: D }).workedMinutes).toBe(480);
    expect(calculateOutsideMinutes(sessions)).toBe(2);
  });

  it('counts an open session up to now on today only', () => {
    const today = '2026-09-18';
    const now = at(today, '15:00');
    const r = calculateWorkedMinutes([ses(today, '08:30', null)], { now, date: today });
    expect(r.workedMinutes).toBe(390); // 6h 30m
    expect(r.hasOpenSessionToday).toBe(true);
    expect(r.incomplete).toBe(false);
  });

  it('treats an open session on a past day as incomplete and counts nothing for it', () => {
    const r = calculateWorkedMinutes(
      [ses(D, '08:05', '12:35'), ses(D, '13:20', '16:10'), ses(D, '16:45', null)],
      { now: at('2026-09-18', '15:42'), date: D },
    );
    expect(r.workedMinutes).toBe(440); // 7h 20m
    expect(r.incomplete).toBe(true);
    expect(r.hasOpenSessionToday).toBe(false);
  });

  it('counts the gap that ends at an open session as outside time', () => {
    const sessions = [ses(D, '08:05', '12:35'), ses(D, '13:20', '16:10'), ses(D, '16:45', null)];
    expect(calculateOutsideMinutes(sessions)).toBe(45 + 35);
  });

  it('keeps a midnight-crossing session whole', () => {
    const s = [sesX('2026-09-14', '22:00', '2026-09-15', '02:00')];
    expect(calculateWorkedMinutes(s, { now: NOW_LATER, date: '2026-09-14' }).workedMinutes).toBe(240);
  });

  it('never over-counts overlapping data', () => {
    const s = [ses(D, '08:00', '12:00'), ses(D, '11:00', '13:00')];
    expect(calculateWorkedMinutes(s, { now: NOW_LATER, date: D }).workedMinutes).toBe(300);
  });

  it('ignores seconds', () => {
    const s = [{ inTime: at(D, '08:00') + 45_000, outTime: at(D, '09:00') + 59_000 }];
    expect(calculateWorkedMinutes(s, { now: NOW_LATER, date: D }).workedMinutes).toBe(60);
  });

  it('returns null first IN and last OUT for an empty day', () => {
    expect(firstIn([])).toBeNull();
    expect(lastOut([ses(D, '08:00', null)])).toBeNull();
  });
});

describe('validateSessions', () => {
  it('accepts sequential and touching sessions', () => {
    const s = [ses(D, '08:00', '10:00'), ses(D, '10:00', '12:00')];
    expect(validateSessions(s, { date: D })).toEqual([]);
  });

  it('rejects OUT before IN', () => {
    const issues = validateSessions([ses(D, '09:00', '08:00')]);
    expect(issues.map((i) => i.code)).toContain('OUT_BEFORE_IN');
    expect(issues[0]?.message).toBe('OUT must be after IN.');
  });

  it('rejects zero-length sessions', () => {
    expect(validateSessions([ses(D, '09:00', '09:00')]).map((i) => i.code)).toContain('ZERO_LENGTH');
  });

  it('rejects overlapping sessions with a clear message', () => {
    const issues = validateSessions([ses(D, '08:05', '12:35'), ses(D, '12:00', '13:00')]);
    expect(issues.find((i) => i.code === 'OVERLAP')?.message).toBe(
      'This overlaps your 08:05-12:35 session.',
    );
  });

  it('rejects a second open session (duplicate IN)', () => {
    const issues = validateSessions([ses(D, '08:00', null), ses(D, '10:00', null)]);
    expect(issues.find((i) => i.code === 'MULTIPLE_OPEN')?.message).toBe(
      'You are already checked in since 08:00.',
    );
  });

  it('rejects a new session that starts inside an open one', () => {
    const issues = validateSessions([ses(D, '08:00', null), ses(D, '10:00', '11:00')]);
    expect(issues.map((i) => i.code)).toContain('OVERLAP');
  });

  it('rejects sessions longer than the cap', () => {
    const issues = validateSessions([ses(D, '01:00', '18:00')]);
    expect(issues.find((i) => i.code === 'TOO_LONG')?.message).toBe(
      'This session is longer than 16 hours. Check the date and time.',
    );
  });

  it('rejects an IN that is not on the selected date', () => {
    const issues = validateSessions([ses('2026-09-16', '08:00', '09:00')], { date: D });
    expect(issues.map((i) => i.code)).toContain('IN_DATE_MISMATCH');
  });

  it('allows a midnight-crossing session on its IN date', () => {
    const s = [sesX('2026-09-14', '22:00', '2026-09-15', '02:00')];
    expect(validateSessions(s, { date: '2026-09-14' })).toEqual([]);
  });
});
