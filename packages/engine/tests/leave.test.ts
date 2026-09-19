import { describe, expect, it } from 'vitest';
import {
  allocateLeave,
  leaveBalanceAt,
  lopByMonth,
  missingMonthlyAccruals,
  previewLeave,
  yearEndLapse,
  type LedgerEntry,
  type LeaveUsage,
} from '../src';

const annual = (type: LedgerEntry['type'], days: number, effectiveDate: string): LedgerEntry => ({
  pool: 'ANNUAL',
  type,
  days,
  effectiveDate,
});

/** The user's real position: 2.00 carried, 9 x 1.75 accrued, 5.00 used before tracking. */
function realLedger(): LedgerEntry[] {
  const entries: LedgerEntry[] = [annual('OPENING', 2, '2026-01-01')];
  for (let m = 1; m <= 9; m++) entries.push(annual('ACCRUAL', 1.75, `2026-${String(m).padStart(2, '0')}-01`));
  entries.push(annual('ADJUSTMENT', -5, '2026-09-19'));
  return entries;
}

const use = (date: string, days = 1): LeaveUsage => ({ date, days, pool: 'ANNUAL' });

describe('leave balances', () => {
  it("reproduces the user's opening balance: 12.75", () => {
    expect(leaveBalanceAt(realLedger(), [], 'ANNUAL', '2026-09-19')).toBe(12.75);
  });

  it('adds the 1 Oct credit', () => {
    const entries = [...realLedger(), annual('ACCRUAL', 1.75, '2026-10-01')];
    expect(leaveBalanceAt(entries, [], 'ANNUAL', '2026-10-01')).toBe(14.5);
  });

  it('subtracts leave usage, including half days', () => {
    const usage = [use('2026-09-22', 1), use('2026-09-23', 0.5)];
    expect(leaveBalanceAt(realLedger(), usage, 'ANNUAL', '2026-09-30')).toBe(11.25);
  });

  it('optional pool: 2 granted, 1 used before tracking, 1 left', () => {
    const entries: LedgerEntry[] = [
      { pool: 'OPTIONAL', type: 'GRANT', days: 2, effectiveDate: '2026-01-01' },
      { pool: 'OPTIONAL', type: 'ADJUSTMENT', days: -1, effectiveDate: '2026-09-19' },
    ];
    expect(leaveBalanceAt(entries, [], 'OPTIONAL', '2026-09-19')).toBe(1);
  });
});

describe('leave beyond balance becomes LOP (salary cut)', () => {
  const entries = [annual('OPENING', 0.5, '2026-11-01')];

  it('splits paid and unpaid days in date order', () => {
    const a = allocateLeave(entries, [use('2026-11-24'), use('2026-11-25')], 'ANNUAL');
    expect(a).toEqual([
      { date: '2026-11-24', pool: 'ANNUAL', days: 1, paid: 0.5, lop: 0.5 },
      { date: '2026-11-25', pool: 'ANNUAL', days: 1, paid: 0, lop: 1 },
    ]);
    expect(lopByMonth(a)).toEqual({ '2026-11': 1.5 });
  });

  it('never reverses an earlier LOP when a later accrual arrives', () => {
    const withDec = [...entries, annual('ACCRUAL', 1.75, '2026-12-01')];
    const a = allocateLeave(withDec, [use('2026-11-24'), use('2026-11-25'), use('2026-12-02')], 'ANNUAL');
    expect(a[0]?.lop).toBe(0.5);
    expect(a[1]?.lop).toBe(1);
    expect(a[2]).toMatchObject({ paid: 1, lop: 0 });
    expect(lopByMonth(a)).toEqual({ '2026-11': 1.5 });
  });

  it('previews the warning before saving', () => {
    expect(previewLeave(entries, [], [use('2026-11-24'), use('2026-11-25')], 'ANNUAL')).toEqual({
      paid: 0.5,
      lop: 1.5,
    });
  });

  it('a request within balance has no LOP', () => {
    expect(previewLeave(realLedger(), [], [use('2026-09-22', 2)], 'ANNUAL')).toEqual({ paid: 2, lop: 0 });
  });

  it('never lets the balance go below zero', () => {
    const balance = leaveBalanceAt(entries, [use('2026-11-24', 3)], 'ANNUAL', '2026-11-30');
    expect(balance).toBe(0);
  });

  it('bereavement leave is never LOP and does not touch the annual pool', () => {
    const a = allocateLeave([], [{ date: '2026-10-05', days: 1, pool: 'BEREAVEMENT' }], 'BEREAVEMENT');
    expect(a).toEqual([{ date: '2026-10-05', pool: 'BEREAVEMENT', days: 1, paid: 1, lop: 0 }]);
  });
});

describe('year end and accrual materialisation', () => {
  it('lapses everything above the carry-forward cap of 3', () => {
    expect(yearEndLapse(7, 3)).toBe(4);
    expect(yearEndLapse(2, 3)).toBe(0);
    expect(yearEndLapse(3, 3)).toBe(0);
  });

  it('carries 3 into January and adds the January credit: 4.75', () => {
    const entries = [
      annual('OPENING', 7, '2026-01-01'),
      annual('LAPSE', -4, '2026-12-31'),
      annual('ACCRUAL', 1.75, '2027-01-01'),
    ];
    expect(leaveBalanceAt(entries, [], 'ANNUAL', '2026-12-31')).toBe(3);
    expect(leaveBalanceAt(entries, [], 'ANNUAL', '2027-01-01')).toBe(4.75);
  });

  it('leave taken on 31 Dec is paid from the pre-lapse balance', () => {
    const entries = [annual('OPENING', 7, '2026-01-01'), annual('LAPSE', -4, '2026-12-31')];
    const a = allocateLeave(entries, [use('2026-12-31')], 'ANNUAL');
    expect(a[0]).toMatchObject({ paid: 1, lop: 0 });
  });

  it('creates only the missing monthly accruals (idempotent)', () => {
    const existing: LedgerEntry[] = [];
    for (let m = 1; m <= 9; m++) existing.push(annual('ACCRUAL', 1.75, `2026-${String(m).padStart(2, '0')}-01`));

    expect(missingMonthlyAccruals(existing, 2026, 1.75, '2026-09-19')).toEqual([]);
    expect(missingMonthlyAccruals(existing, 2026, 1.75, '2026-10-05')).toEqual([
      annual('ACCRUAL', 1.75, '2026-10-01'),
    ]);
    expect(missingMonthlyAccruals([], 2026, 1.75, '2026-03-15')).toHaveLength(3);
  });
});
