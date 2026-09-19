/**
 * Time helpers. All calendar logic is IST (UTC+05:30, no daylight saving),
 * done with integer arithmetic so no runtime timezone database is needed.
 */

export const MINUTE_MS = 60_000;
export const IST_OFFSET_MIN = 330;

export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** IST calendar date ('YYYY-MM-DD') of an instant. */
export function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MIN * MINUTE_MS).toISOString().slice(0, 10);
}

/** Builds the instant for an IST date and 'HH:MM' clock time. */
export function istInstant(date: string, hhmm: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  return Date.UTC(y, m - 1, d, h, mi) - IST_OFFSET_MIN * MINUTE_MS;
}

/** 24-hour IST clock time 'HH:MM'. */
export function istClock(ms: number): string {
  return new Date(ms + IST_OFFSET_MIN * MINUTE_MS).toISOString().slice(11, 16);
}

/** 24-hour IST clock time with seconds, 'HH:MM:SS'. */
export function istClockSeconds(ms: number): string {
  return new Date(ms + IST_OFFSET_MIN * MINUTE_MS).toISOString().slice(11, 19);
}

/** 12-hour IST clock time such as '4:52 PM'. */
export function istClock12(ms: number): string {
  const [hh, mm] = istClock(ms).split(':').map(Number) as [number, number];
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function parseDate(date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${date}`);
  return d;
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const wd = parseDate(date).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function startOfWeek(date: string, weekStartsOn: number): string {
  const diff = (isoWeekday(date) - weekStartsOn + 7) % 7;
  return addDays(date, -diff);
}

/** Inclusive list of dates. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function lastDayOfMonth(year: number, month: number): string {
  // month is 1-12. Day 0 of the next month is the last day of this month.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}
