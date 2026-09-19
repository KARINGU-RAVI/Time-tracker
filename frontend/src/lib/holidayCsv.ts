export interface HolidayRow {
  date: string;
  name: string;
  type: 'COMPANY' | 'OPTIONAL';
}

export const HOLIDAY_TEMPLATE = 'date,name,type\n2026-10-02,Gandhi Jayanti,public\n2026-11-08,Diwali (optional),optional\n';

/** Splits one CSV line, honouring "quoted, values". */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Month 13 gives an invalid Date; 30 February rolls over to March. Both must be refused.
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/**
 * Reads a holiday list: columns date (YYYY-MM-DD), name, and an optional type ("optional", otherwise a public holiday).
 * A header row is allowed. Problems are reported by line so the person can fix the file.
 */
export function parseHolidayCsv(text: string): { rows: HolidayRow[]; errors: string[] } {
  const rows: HolidayRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const [date = '', name = '', type = ''] = cells(raw);
    if (i === 0 && !isRealDate(date) && /date/i.test(date)) return; // header
    const line = i + 1;
    if (!isRealDate(date)) return void errors.push(`Line ${line}: "${date}" is not a date like 2026-10-02.`);
    if (!name) return void errors.push(`Line ${line}: the holiday has no name.`);
    if (name.length > 80) return void errors.push(`Line ${line}: the name is longer than 80 characters.`);
    if (/^[=+\-@\t\r]/.test(name)) return void errors.push(`Line ${line}: the name starts with a character that spreadsheets treat as a formula.`);
    if (seen.has(date)) return void errors.push(`Line ${line}: ${date} is listed more than once.`);
    seen.add(date);
    rows.push({ date, name, type: /^optional$/i.test(type) ? 'OPTIONAL' : 'COMPANY' });
  });
  if (rows.length > 100) errors.push('The list has more than 100 holidays. Split it into smaller files.');
  return { rows, errors };
}
