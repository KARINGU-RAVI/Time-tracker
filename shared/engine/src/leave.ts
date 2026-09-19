import type { LeavePool } from './types';

/**
 * Leave ledger maths (R-28..R-34).
 *
 * The ledger holds only what cannot be derived: opening balance, accruals,
 * grants, lapses and adjustments. Usage comes from attendance records.
 * Everything is computed in hundredths of a day to avoid float drift.
 */

export type LedgerEntryType = 'OPENING' | 'ACCRUAL' | 'GRANT' | 'LAPSE' | 'ADJUSTMENT';

export interface LedgerEntry {
  pool: LeavePool;
  type: LedgerEntryType;
  /** Signed days. */
  days: number;
  /** IST date 'YYYY-MM-DD'. */
  effectiveDate: string;
}

export interface LeaveUsage {
  date: string;
  days: number;
  pool: LeavePool;
}

export interface LeaveAllocation {
  date: string;
  pool: LeavePool;
  days: number;
  /** Days covered by the balance. */
  paid: number;
  /** Days beyond the balance: unpaid, salary is cut for that month (R-32). */
  lop: number;
}

const cents = (days: number): number => Math.round(days * 100);
const fromCents = (c: number): number => c / 100;

/** A LAPSE happens at the end of its day, so it only affects later usage. */
function counts(entry: LedgerEntry, onDate: string): boolean {
  return entry.type === 'LAPSE' ? entry.effectiveDate < onDate : entry.effectiveDate <= onDate;
}

/**
 * Allocates leave usage against the balance in date order. Whatever the
 * balance cannot cover on that date becomes LOP. The balance never goes
 * negative, and later accruals never reverse an earlier LOP (R-32, R-32a).
 */
export function allocateLeave(
  entries: LedgerEntry[],
  usage: LeaveUsage[],
  pool: LeavePool,
): LeaveAllocation[] {
  const poolEntries = entries.filter((e) => e.pool === pool);
  const sorted = usage
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.pool === pool)
    .sort((a, b) => (a.u.date === b.u.date ? a.i - b.i : a.u.date < b.u.date ? -1 : 1))
    .map(({ u }) => u);

  let paidSoFar = 0;
  return sorted.map((u) => {
    const daysC = cents(u.days);
    if (pool === 'BEREAVEMENT') {
      return { date: u.date, pool, days: u.days, paid: u.days, lop: 0 };
    }
    const available = poolEntries
      .filter((e) => counts(e, u.date))
      .reduce((sum, e) => sum + cents(e.days), 0);
    const paidC = Math.min(daysC, Math.max(0, available - paidSoFar));
    paidSoFar += paidC;
    return {
      date: u.date,
      pool,
      days: u.days,
      paid: fromCents(paidC),
      lop: fromCents(daysC - paidC),
    };
  });
}

/** Balance of a pool at the end of `asOf`. Never below zero. */
export function leaveBalanceAt(
  entries: LedgerEntry[],
  usage: LeaveUsage[],
  pool: LeavePool,
  asOf: string,
): number {
  const allocations = allocateLeave(
    entries,
    usage.filter((u) => u.date <= asOf),
    pool,
  );
  const credits = entries
    .filter((e) => e.pool === pool && e.effectiveDate <= asOf)
    .reduce((sum, e) => sum + cents(e.days), 0);
  const paid = allocations.reduce((sum, a) => sum + cents(a.paid), 0);
  return fromCents(Math.max(0, credits - paid));
}

export interface LeavePreview {
  paid: number;
  lop: number;
}

/**
 * What would happen if `newUsage` were added: how much is paid and how much
 * becomes LOP. Used for the "N day(s) will be unpaid" warning before saving.
 */
export function previewLeave(
  entries: LedgerEntry[],
  existingUsage: LeaveUsage[],
  newUsage: LeaveUsage[],
  pool: LeavePool,
): LeavePreview {
  const lopOf = (u: LeaveUsage[]) =>
    allocateLeave(entries, u, pool).reduce((sum, a) => sum + cents(a.lop), 0);
  const newDays = newUsage.filter((u) => u.pool === pool).reduce((s, u) => s + cents(u.days), 0);
  const extraLop = lopOf([...existingUsage, ...newUsage]) - lopOf(existingUsage);
  return { paid: fromCents(newDays - extraLop), lop: fromCents(extraLop) };
}

/** Unpaid days per calendar month, 'YYYY-MM' -> days (R-32a). */
export function lopByMonth(allocations: LeaveAllocation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of allocations) {
    if (a.lop <= 0) continue;
    const key = a.date.slice(0, 7);
    out[key] = fromCents(cents(out[key] ?? 0) + cents(a.lop));
  }
  return out;
}

/** Days lost at year end (R-30): everything above the carry-forward cap. */
export function yearEndLapse(balance: number, carryForwardCap: number): number {
  return fromCents(Math.max(0, cents(balance) - cents(carryForwardCap)));
}

/**
 * Monthly accrual entries (on the 1st of each month) that should exist up to
 * `throughDate` but do not yet. Safe to call repeatedly (lazy, idempotent).
 */
export function missingMonthlyAccruals(
  existing: LedgerEntry[],
  year: number,
  perMonth: number,
  throughDate: string,
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (let month = 1; month <= 12; month++) {
    const date = `${year}-${String(month).padStart(2, '0')}-01`;
    if (date > throughDate) break;
    const exists = existing.some(
      (e) => e.pool === 'ANNUAL' && e.type === 'ACCRUAL' && e.effectiveDate === date,
    );
    if (!exists) out.push({ pool: 'ANNUAL', type: 'ACCRUAL', days: perMonth, effectiveDate: date });
  }
  return out;
}
