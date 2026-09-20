import { formatDuration } from '@oht/engine';
import type { Day } from './types';

export type Tone = 'ok' | 'warn' | 'wfh' | 'leave' | 'holiday' | 'off' | 'bad' | 'neutral';
export type IconName = 'check' | 'clock' | 'home' | 'leave' | 'star' | 'off' | 'warning' | 'dot' | 'help';

export interface StatusInfo {
  label: string;
  tone: Tone;
  icon: IconName;
}

/**
 * One place that decides how a day is labelled and coloured. Every status has an icon and text
 * as well as a colour, so colour is never the only signal.
 */
export function dayStatus(d: Day): StatusInfo {
  if (d.isIncomplete) return { label: 'Needs fix', tone: 'bad', icon: 'warning' };
  if (d.isUnrecorded) return { label: 'No record', tone: 'bad', icon: 'help' };

  switch (d.kind) {
    case 'HOLIDAY':
      return { label: 'Holiday', tone: 'holiday', icon: 'star' };
    case 'WEEKLY_OFF':
      return { label: 'Weekly off', tone: 'off', icon: 'off' };
    case 'FULL_LEAVE':
      return { label: 'Leave', tone: 'leave', icon: 'leave' };
    case 'HALF_DAY_LEAVE':
      return { label: 'Half-day leave', tone: 'leave', icon: 'leave' };
    case 'OPTIONAL_HOLIDAY':
      return { label: 'Optional holiday', tone: 'holiday', icon: 'star' };
    case 'BEREAVEMENT':
      return { label: 'Death in family', tone: 'leave', icon: 'leave' };
    case 'BIRTHDAY_HALF_DAY':
      return { label: 'Birthday half-day', tone: 'leave', icon: 'leave' };
    case 'BEFORE_TRACKING':
      return { label: 'Not counted', tone: 'neutral', icon: 'dot' };
    case 'WFH':
    case 'WORKING':
      break;
  }

  if (d.isFuture) return { label: 'Upcoming', tone: 'neutral', icon: 'dot' };
  if (d.isToday) {
    return d.kind === 'WFH'
      ? { label: 'WFH, in progress', tone: 'wfh', icon: 'home' }
      : { label: 'In progress', tone: 'ok', icon: 'clock' };
  }
  if (d.kind === 'WFH') return { label: 'WFH', tone: 'wfh', icon: 'home' };
  return (d.balanceMinutes ?? 0) >= 0
    ? { label: 'Hours done', tone: 'ok', icon: 'check' }
    : { label: 'Short', tone: 'warn', icon: 'clock' };
}

/**
 * What the Balance column shows for a day. A number once the day has counted; otherwise a word that says why there is none:
 * "Pending" for a working day that has not happened yet, and a dash where nothing is required (weekly off, holiday, leave).
 */
export function dayBalanceLabel(d: Day): { text: string; hint: string | null } {
  if (d.balanceMinutes !== null) return { text: formatDuration(d.balanceMinutes, { signed: true }), hint: null };
  if (d.isFuture && d.requiredMinutes > 0) return { text: 'Pending', hint: 'Counted once the day has passed' };
  return { text: '\u2013', hint: 'Nothing is required this day' };
}

/** Tailwind classes per tone (tinted background + coloured text). */
export const toneClasses: Record<Tone, string> = {
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/15 text-[#8a6300]',
  wfh: 'bg-wfh/10 text-wfh',
  leave: 'bg-leave/10 text-leave',
  holiday: 'bg-holiday/10 text-holiday',
  off: 'bg-off/15 text-ink-soft',
  bad: 'bg-bad/10 text-bad',
  neutral: 'bg-muted text-ink-soft',
};

export const toneSolid: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  wfh: 'bg-wfh',
  leave: 'bg-leave',
  holiday: 'bg-holiday',
  off: 'bg-off',
  bad: 'bg-bad',
  neutral: 'bg-line',
};

/** The "Can I leave now?" line, recomputed locally so it stays right between server refreshes. */
export function dayMessage(requiredMinutes: number, workedMinutes: number): string {
  if (requiredMinutes <= 0) return 'No work is required today.';
  if (workedMinutes < requiredMinutes) return `You need ${formatDuration(requiredMinutes - workedMinutes)} more.`;
  if (workedMinutes === requiredMinutes) return "Today's required hours are completed.";
  return `${formatDuration(workedMinutes)} completed — ${formatDuration(workedMinutes - requiredMinutes)} overtime.`;
}

/** Minutes between two ISO instants, rounded down. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
}
