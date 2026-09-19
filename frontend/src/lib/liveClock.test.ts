import { describe, expect, it } from 'vitest';
import { liveFigures, serverClock } from './liveClock';

const T = (hhmmss: string) => Date.parse(`2026-09-18T${hhmmss}Z`); // any fixed base; only differences matter

/** A person who checked in at 03:30:30 (UTC clock) and has nothing else recorded. */
const base = { workedMinutes: 0, requiredMinutes: 480, isInside: true, openInMs: T('03:30:30'), fetchNowMs: T('03:30:30') };

describe('liveFigures', () => {
  it('starts at exactly 0:00:00 on check-in and counts up second by second', () => {
    expect(liveFigures({ ...base, nowMs: T('03:30:30') }).workedSeconds).toBe(0);
    expect(liveFigures({ ...base, nowMs: T('03:30:31') }).workedSeconds).toBe(1);
    expect(liveFigures({ ...base, nowMs: T('03:31:00') }).workedSeconds).toBe(30);
    expect(liveFigures({ ...base, nowMs: T('04:30:30') }).workedSeconds).toBe(3600);
  });

  it('adds the running session to time already closed, without counting the running minutes twice', () => {
    // 208 minutes closed earlier. Checked in again at 03:30:30. The server answered at 03:42:30, having counted 12 whole minutes for it.
    const fetchNowMs = T('03:42:30');
    const input = { workedMinutes: 208 + 12, requiredMinutes: 480, isInside: true, openInMs: T('03:30:30'), fetchNowMs };
    expect(liveFigures({ ...input, nowMs: fetchNowMs }).workedSeconds).toBe(208 * 60 + 12 * 60);
    expect(liveFigures({ ...input, nowMs: fetchNowMs + 45_000 }).workedSeconds).toBe(208 * 60 + 12 * 60 + 45);
    expect(liveFigures({ ...input, nowMs: fetchNowMs }).sessionSeconds).toBe(12 * 60);
  });

  it('when a session closes the figure is exactly the server minutes, with no seconds', () => {
    const f = liveFigures({ workedMinutes: 415, requiredMinutes: 480, isInside: false, openInMs: null, fetchNowMs: T('05:00:00'), nowMs: T('05:07:41') });
    expect(f.workedSeconds).toBe(415 * 60);
    expect(f.sessionSeconds).toBe(0);
    expect(f.remainingSeconds).toBe(65 * 60); // does not tick while you are out
  });

  it('counts the remaining time down to zero, then overtime up from zero', () => {
    // Open since 03:30:00. At 03:59:00 the server had counted 29 minutes for it, so 450 minutes were closed.
    const input = { workedMinutes: 479, requiredMinutes: 480, isInside: true, openInMs: T('03:30:00'), fetchNowMs: T('03:59:00') };
    const at = (s: string) => liveFigures({ ...input, nowMs: T(s) });
    expect(at('03:59:00').remainingSeconds).toBe(60);
    expect(at('03:59:30').remainingSeconds).toBe(30);
    expect(at('03:59:59').remainingSeconds).toBe(1);
    const zero = at('04:00:00');
    expect(zero.remainingSeconds).toBe(0);
    expect(zero.overtimeSeconds).toBe(0);
    expect(at('04:00:01').overtimeSeconds).toBe(1);
    expect(at('04:00:01').remainingSeconds).toBe(0);
    expect(at('05:00:00').overtimeSeconds).toBe(3600);
  });

  it('worked plus remaining always equals the requirement until it is met', () => {
    for (let s = 0; s < 480 * 60; s += 997) {
      const f = liveFigures({ ...base, nowMs: T('03:30:30') + s * 1000 });
      expect(f.workedSeconds + f.remainingSeconds).toBe(480 * 60);
    }
  });

  it('a day with nothing required shows no countdown and no overtime', () => {
    const f = liveFigures({ ...base, requiredMinutes: 0, nowMs: T('05:30:30') });
    expect(f.remainingSeconds).toBe(0);
    expect(f.overtimeSeconds).toBe(0);
    expect(f.workedSeconds).toBe(2 * 3600);
  });

  it('never goes negative, even if the clocks are a moment out of step', () => {
    const f = liveFigures({ ...base, nowMs: T('03:30:29') });
    expect(f.workedSeconds).toBe(0);
    expect(f.sessionSeconds).toBe(0);
    // The server counted fewer minutes than the open session alone: never subtract below zero.
    const g = liveFigures({ workedMinutes: 2, requiredMinutes: 480, isInside: true, openInMs: T('03:00:00'), fetchNowMs: T('03:30:00'), nowMs: T('03:30:00') });
    expect(g.workedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not depend on which second of the minute the check-in happened (whole-minute rounding at both ends)', () => {
    for (const open of ['03:00:00', '03:00:59', '03:59:59']) {
      const openInMs = T(open);
      const fetchNowMs = openInMs + 5 * 60_000 + 20_000;
      const counted = Math.floor(fetchNowMs / 60_000) - Math.floor(openInMs / 60_000);
      const f = liveFigures({ workedMinutes: 100 + counted, requiredMinutes: 480, isInside: true, openInMs, fetchNowMs, nowMs: fetchNowMs });
      expect(f.workedSeconds).toBe(100 * 60 + 5 * 60 + 20); // 100 closed minutes plus the true running time
    }
  });
});

describe('serverClock', () => {
  it('follows the server and ignores how wrong the device clock is', () => {
    const server = '2026-09-18T10:12:00.000Z';
    const rightDevice = serverClock(server, 1_000_000, 1_000_000 + 5_000);
    const wrongDevice = serverClock(server, 9_000_000_000, 9_000_000_000 + 5_000); // a clock years ahead
    expect(rightDevice).toBe(Date.parse(server) + 5_000);
    expect(wrongDevice).toBe(rightDevice); // the same second on both devices
  });

  it('never runs backwards if the device clock is set back', () => {
    expect(serverClock('2026-09-18T10:12:00.000Z', 2_000, 1_000)).toBe(Date.parse('2026-09-18T10:12:00.000Z'));
  });
});
