import { describe, expect, it } from 'vitest';
import { HOLIDAY_TEMPLATE, parseHolidayCsv } from './holidayCsv';

describe('parseHolidayCsv', () => {
  it('reads the downloadable template exactly', () => {
    expect(parseHolidayCsv(HOLIDAY_TEMPLATE)).toEqual({
      rows: [
        { date: '2026-10-02', name: 'Gandhi Jayanti', type: 'COMPANY' },
        { date: '2026-11-08', name: 'Diwali (optional)', type: 'OPTIONAL' },
      ],
      errors: [],
    });
  });

  it('works without a header, with Windows line endings, a BOM and blank lines', () => {
    const r = parseHolidayCsv('﻿2026-01-26,Republic Day\r\n\r\n2026-08-15,Independence Day,public\r\n');
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.date)).toEqual(['2026-01-26', '2026-08-15']);
  });

  it('keeps commas inside quoted names', () => {
    expect(parseHolidayCsv('2026-12-25,"Christmas, Day",optional').rows).toEqual([{ date: '2026-12-25', name: 'Christmas, Day', type: 'OPTIONAL' }]);
  });

  it('reports every bad line with its line number, and still reads the good ones', () => {
    const r = parseHolidayCsv('date,name,type\n2026-13-40,Not a date\n2026-10-02,\n2026-10-03,Fine\n2026-10-03,Again\nnot-a-date,X');
    expect(r.rows).toEqual([{ date: '2026-10-03', name: 'Fine', type: 'COMPANY' }]);
    expect(r.errors).toEqual([
      'Line 2: "2026-13-40" is not a date like 2026-10-02.',
      'Line 3: the holiday has no name.',
      'Line 5: 2026-10-03 is listed more than once.',
      'Line 6: "not-a-date" is not a date like 2026-10-02.',
    ]);
  });

  it('rejects an impossible calendar date such as 30 February', () => {
    expect(parseHolidayCsv('2026-02-30,Nope').errors).toHaveLength(1);
  });

  it('refuses names that a spreadsheet would run as a formula', () => {
    for (const bad of ['=HYPERLINK("x")', '+1', '-2', '@sum']) {
      expect(parseHolidayCsv(`2026-10-02,"${bad.replace(/"/g, '""')}"`).errors[0], bad).toMatch(/formula/);
    }
  });

  it('refuses very long names and lists of more than 100', () => {
    expect(parseHolidayCsv(`2026-10-02,${'x'.repeat(81)}`).errors[0]).toMatch(/80 characters/);
    const many = Array.from({ length: 101 }, (_, i) => `${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},Day ${i}`).join('\n');
    expect(parseHolidayCsv(many).errors).toContain('The list has more than 100 holidays. Split it into smaller files.');
  });

  it('an empty file gives no holidays and no errors', () => {
    expect(parseHolidayCsv('')).toEqual({ rows: [], errors: [] });
  });
});
