import { addDays, firstDayOfMonth, isoWeekday, istDateOf, lastDayOfMonth } from '@oht/engine';

export { addDays, firstDayOfMonth, lastDayOfMonth };

/** Today's IST date. */
export const todayIst = (): string => istDateOf(Date.now());

// Fixed names, not Intl: locale data differs between devices (for example "Sept" vs "Sep"),
// and the app must read the same everywhere.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const parts = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    weekday: WEEKDAYS[d.getUTCDay()]!,
    day: d.getUTCDate(),
    month: MONTHS_SHORT[d.getUTCMonth()]!,
    year: d.getUTCFullYear(),
  };
};

/** 'Fri, 18 Sep 2026' */
export function prettyDate(date: string): string {
  const p = parts(date);
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

/** '18 Sep' */
export function shortDate(date: string): string {
  const p = parts(date);
  return `${p.day} ${p.month}`;
}

/** 'Fri 18 Sep' */
export function dayLabel(date: string): string {
  const p = parts(date);
  return `${p.weekday} ${p.day} ${p.month}`;
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Weeks of a month as rows of 7 cells (null = outside the month), starting on `weekStartsOn`. */
export function monthGrid(year: number, month: number, weekStartsOn = 1): Array<Array<string | null>> {
  const first = firstDayOfMonth(year, month);
  const last = lastDayOfMonth(year, month);
  const lead = (isoWeekday(first) - weekStartsOn + 7) % 7;
  const cells: Array<string | null> = Array(lead).fill(null);
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
