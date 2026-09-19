import { describe, expect, it } from 'vitest';
import { formatClockDuration, istClockSeconds } from '../src';

describe('formatClockDuration', () => {
  it('formats seconds as H:MM:SS', () => {
    expect(formatClockDuration(0)).toBe('0:00:00');
    expect(formatClockDuration(59)).toBe('0:00:59');
    expect(formatClockDuration(61)).toBe('0:01:01');
    expect(formatClockDuration(3600)).toBe('1:00:00');
    expect(formatClockDuration(6 * 3600 + 55 * 60 + 7)).toBe('6:55:07');
    expect(formatClockDuration(100 * 3600)).toBe('100:00:00');
  });

  it('never shows a negative value, and shows whole seconds only', () => {
    expect(formatClockDuration(-5)).toBe('0:00:00');
    expect(formatClockDuration(59.9)).toBe('0:00:59');
  });
});

describe('istClockSeconds', () => {
  it('shows the India time with seconds, whatever the device time zone', () => {
    expect(istClockSeconds(Date.UTC(2026, 8, 18, 10, 12, 7))).toBe('15:42:07');
    expect(istClockSeconds(Date.UTC(2026, 8, 18, 18, 29, 59))).toBe('23:59:59');
    expect(istClockSeconds(Date.UTC(2026, 8, 18, 18, 30, 0))).toBe('00:00:00'); // midnight in India
  });
});
