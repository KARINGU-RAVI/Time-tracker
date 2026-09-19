/**
 * CSV helpers (RFC 4180 quoting) with a guard against spreadsheet formula injection:
 * free text that starts with = + - @ (or a tab/CR) would be executed as a formula by Excel
 * or Sheets, so it is prefixed with an apostrophe. Only user-written text needs this; numbers
 * and durations the app produces (such as "-1h 40m") must stay untouched.
 */
export function guardText(text: string | null | undefined): string {
  const s = text ?? '';
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to a CSV string with a UTF-8 BOM (so Excel reads non-ASCII text correctly) and CRLF line ends. */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
