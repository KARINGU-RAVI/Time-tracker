import type { Prisma, PrismaClient } from '@prisma/client';
import {
  allocateLeave,
  calculateDailyAttendance,
  leaveBalanceAt,
  lopByMonth,
  missingMonthlyAccruals,
  yearEndLapse,
  type LeaveAllocation,
  type LeavePool,
  type LeaveUsage,
  type LedgerEntry,
  type LedgerEntryType,
} from '@oht/engine';
import { fromDbDate, toDbDate } from '../http';
import { loadRecords, type UserConfig } from './engineData';

type Db = PrismaClient | Prisma.TransactionClient;

const LEAVE_STATUSES = ['CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY', 'BIRTHDAY_LEAVE'] as const;

export interface StoredLedgerEntry extends LedgerEntry {
  id?: string;
  note?: string | null;
}

export async function loadLedger(db: Db, userId: string): Promise<StoredLedgerEntry[]> {
  const rows = await db.leaveLedgerEntry.findMany({
    where: { userId },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    pool: r.pool,
    type: r.type,
    days: Number(r.days),
    effectiveDate: fromDbDate(r.effectiveDate),
    note: r.note,
  }));
}

/** Leave usage derived from attendance rows via the engine (holiday/weekend leave counts as nothing). */
export async function loadLeaveUsage(
  db: Db,
  userId: string,
  cfg: UserConfig,
  from: string,
  to: string,
): Promise<LeaveUsage[]> {
  const rows = await db.attendance.findMany({
    where: {
      userId,
      status: { in: [...LEAVE_STATUSES] },
      date: { gte: toDbDate(from), lte: toDbDate(to) },
    },
    orderBy: { date: 'asc' },
  });
  const usage: LeaveUsage[] = [];
  for (const r of rows) {
    const date = fromDbDate(r.date);
    const day = calculateDailyAttendance(
      { date, status: r.status, dayFraction: Number(r.dayFraction) === 0.5 ? 0.5 : 1, sessions: [] },
      date,
      cfg.ctx,
    );
    if (day.leaveUse) usage.push({ date, days: day.leaveUse.days, pool: day.leaveUse.pool });
  }
  return usage;
}

/** Monthly credits that are due but not yet stored. The first ledger year only continues after what exists. */
function accrualsDue(
  entries: LedgerEntry[],
  year: number,
  firstYear: number,
  perMonth: number,
  through: string,
): LedgerEntry[] {
  let due = missingMonthlyAccruals(entries, year, perMonth, through);
  if (year === firstYear) {
    const systemDates = entries
      .filter((e) => e.pool === 'ANNUAL' && e.effectiveDate.startsWith(String(year)))
      .filter((e) => e.type === 'ACCRUAL' || e.type === 'OPENING')
      .map((e) => e.effectiveDate);
    const last = systemDates.sort().at(-1);
    if (last) due = due.filter((e) => e.effectiveDate > last);
  }
  return due;
}

async function savePolicyEntries(
  db: Db,
  userId: string,
  entries: Array<{ pool: LeavePool; type: LedgerEntryType; days: number; effectiveDate: string; note?: string }>,
) {
  if (entries.length === 0) return;
  await db.leaveLedgerEntry.createMany({
    data: entries.map((e) => ({
      userId,
      pool: e.pool,
      type: e.type,
      days: e.days,
      effectiveDate: toDbDate(e.effectiveDate),
      leaveYear: Number(e.effectiveDate.slice(0, 4)),
      note: e.note,
    })),
    // The unique index on accrual, grant and lapse makes this safe to run any number of times.
    skipDuplicates: true,
  });
}

/**
 * Lazy, idempotent ledger maintenance (design section 3.3): creates due monthly credits,
 * and on a new year the year-end lapse (annual above the carry-forward cap, all unused
 * optional leave) and the new optional grant. Safe to call on every request.
 */
export async function ensureLedger(db: Db, userId: string, cfg: UserConfig, asOf: string): Promise<void> {
  const policy = await db.leavePolicy.findFirst({ where: { userId }, orderBy: { effectiveFrom: 'desc' } });
  let entries = await loadLedger(db, userId);
  if (!policy || entries.length === 0) return;

  const perMonth = Number(policy.accrualPerMonth);
  const cap = Number(policy.carryForwardCap);
  const quota = Number(policy.optionalQuota);
  const birthdayQuota = Number(policy.birthdayQuota);
  const firstYear = Math.min(...entries.map((e) => Number(e.effectiveDate.slice(0, 4))));
  const currentYear = Number(asOf.slice(0, 4));

  // An account that has never had a birthday allowance (made before the feature, or restored from an older backup) gets one.
  if (birthdayQuota > 0 && !entries.some((e) => e.pool === 'BIRTHDAY')) {
    await savePolicyEntries(db, userId, [
      { pool: 'BIRTHDAY', type: 'GRANT', days: birthdayQuota, effectiveDate: `${firstYear}-01-01`, note: `Birthday half-day allowance for ${firstYear}` },
    ]);
    entries = await loadLedger(db, userId);
  }

  for (let y = firstYear; y <= currentYear; y++) {
    const through = y < currentYear ? `${y}-12-31` : asOf;
    await savePolicyEntries(db, userId, accrualsDue(entries, y, firstYear, perMonth, through).map((e) => ({ ...e })));
    entries = await loadLedger(db, userId);

    if (y < currentYear) {
      const usage = await loadLeaveUsage(db, userId, cfg, `${firstYear}-01-01`, `${y}-12-31`);
      const yearEnd = `${y}-12-31`;
      const annual = leaveBalanceAt(entries, usage, 'ANNUAL', yearEnd);
      const optional = leaveBalanceAt(entries, usage, 'OPTIONAL', yearEnd);
      const birthday = leaveBalanceAt(entries, usage, 'BIRTHDAY', yearEnd);
      const lapse = yearEndLapse(annual, cap);
      await savePolicyEntries(db, userId, [
        ...(lapse > 0
          ? [{ pool: 'ANNUAL' as const, type: 'LAPSE' as const, days: -lapse, effectiveDate: yearEnd, note: `Above the ${cap}-day carry-forward cap` }]
          : []),
        ...(optional > 0
          ? [{ pool: 'OPTIONAL' as const, type: 'LAPSE' as const, days: -optional, effectiveDate: yearEnd, note: 'Unused optional leave lapses' }]
          : []),
        ...(quota > 0
          ? [{ pool: 'OPTIONAL' as const, type: 'GRANT' as const, days: quota, effectiveDate: `${y + 1}-01-01`, note: `Optional leave quota for ${y + 1}` }]
          : []),
        ...(birthday > 0
          ? [{ pool: 'BIRTHDAY' as const, type: 'LAPSE' as const, days: -birthday, effectiveDate: yearEnd, note: 'Unused birthday half-day lapses' }]
          : []),
        ...(birthdayQuota > 0
          ? [{ pool: 'BIRTHDAY' as const, type: 'GRANT' as const, days: birthdayQuota, effectiveDate: `${y + 1}-01-01`, note: `Birthday half-day allowance for ${y + 1}` }]
          : []),
      ]);
      entries = await loadLedger(db, userId);
    }
  }
}

/** Ledger plus not-yet-stored monthly credits, so leave planned for later this year is judged fairly. */
export async function projectedLedger(
  db: Db,
  userId: string,
  asOf: string,
  throughDate: string,
): Promise<StoredLedgerEntry[]> {
  const policy = await db.leavePolicy.findFirst({ where: { userId }, orderBy: { effectiveFrom: 'desc' } });
  const entries = await loadLedger(db, userId);
  if (!policy || entries.length === 0) return entries;
  const year = Number(asOf.slice(0, 4));
  const firstYear = Math.min(...entries.map((e) => Number(e.effectiveDate.slice(0, 4))));
  const through = throughDate.startsWith(String(year)) ? throughDate : `${year}-12-31`;
  return [...entries, ...accrualsDue(entries, year, firstYear, Number(policy.accrualPerMonth), through)];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LeaveSummary {
  asOf: string;
  year: number;
  annual: {
    balance: number;
    carriedIn: number;
    accruedThisYear: number;
    usedThisYear: number;
    nextCredit: { date: string; days: number } | null;
  };
  optional: { quota: number; used: number; remaining: number };
  /** Birthday half-day: separate from annual leave, one allowance per year. */
  birthday: { quota: number; used: number; remaining: number };
  lopByMonth: Record<string, number>;
  allocations: LeaveAllocation[];
  ledger: Array<{ date: string; kind: string; note: string | null; days: number; running: number }>;
  yearEnd: { balance: number; carryForward: number; willLapse: number } | null;
}

export async function leaveSummary(db: Db, userId: string, cfg: UserConfig, asOf: string): Promise<LeaveSummary> {
  await ensureLedger(db, userId, cfg, asOf);
  const policy = await db.leavePolicy.findFirst({ where: { userId }, orderBy: { effectiveFrom: 'desc' } });
  const year = Number(asOf.slice(0, 4));
  const yearEnd = `${year}-12-31`;

  const ledger = await projectedLedger(db, userId, asOf, yearEnd);
  const stored = ledger.filter((e) => e.effectiveDate <= asOf || e.id);
  const firstYear = ledger.length ? Math.min(...ledger.map((e) => Number(e.effectiveDate.slice(0, 4)))) : year;
  const usage = ledger.length ? await loadLeaveUsage(db, userId, cfg, `${firstYear}-01-01`, yearEnd) : [];

  const annualAlloc = allocateLeave(ledger, usage, 'ANNUAL');
  const optionalAlloc = allocateLeave(ledger, usage, 'OPTIONAL');
  const birthdayAlloc = allocateLeave(ledger, usage, 'BIRTHDAY');
  const allocations = [...annualAlloc, ...optionalAlloc, ...birthdayAlloc, ...allocateLeave(ledger, usage, 'BEREAVEMENT')];

  const inYear = (d: string) => d.startsWith(String(year));
  const balance = leaveBalanceAt(stored, usage, 'ANNUAL', asOf);
  const paidThisYear = (a: LeaveAllocation[]) =>
    a.filter((x) => inYear(x.date) && x.date <= asOf).reduce((s, x) => s + x.paid, 0);
  const adjustments = (pool: LeavePool) =>
    -stored
      .filter((e) => e.pool === pool && e.type === 'ADJUSTMENT' && e.days < 0 && inYear(e.effectiveDate))
      .reduce((s, e) => s + e.days, 0);

  const carriedIn =
    year === firstYear
      ? stored.filter((e) => e.pool === 'ANNUAL' && e.type === 'OPENING' && inYear(e.effectiveDate)).reduce((s, e) => s + e.days, 0)
      : leaveBalanceAt(stored, usage, 'ANNUAL', `${year - 1}-12-31`);
  const accrued = stored
    .filter((e) => e.pool === 'ANNUAL' && e.type === 'ACCRUAL' && inYear(e.effectiveDate) && e.effectiveDate <= asOf)
    .reduce((s, e) => s + e.days, 0);

  const nextMonthDate = (() => {
    const m = Number(asOf.slice(5, 7));
    return m >= 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
  })();

  const quota = stored
    .filter((e) => e.pool === 'OPTIONAL' && e.type === 'GRANT' && inYear(e.effectiveDate))
    .reduce((s, e) => s + e.days, 0);
  const optionalUsed = paidThisYear(optionalAlloc) + adjustments('OPTIONAL');
  const optionalRemaining = leaveBalanceAt(stored, usage, 'OPTIONAL', asOf);

  const birthdayQuota = stored
    .filter((e) => e.pool === 'BIRTHDAY' && e.type === 'GRANT' && inYear(e.effectiveDate))
    .reduce((s, e) => s + e.days, 0);
  const birthdayUsed = paidThisYear(birthdayAlloc) + adjustments('BIRTHDAY');
  const birthdayRemaining = leaveBalanceAt(stored, usage, 'BIRTHDAY', asOf);

  const cap = policy ? Number(policy.carryForwardCap) : 0;
  const month = Number(asOf.slice(5, 7));

  // Ledger rows with a running balance: entries plus paid usage.
  const rows = [
    ...stored.map((e) => ({ date: e.effectiveDate, kind: e.type as string, note: e.note ?? null, days: e.days, pool: e.pool })),
    ...annualAlloc.filter((a) => a.paid > 0 && a.date <= asOf).map((a) => ({ date: a.date, kind: 'USAGE', note: null as string | null, days: -a.paid, pool: 'ANNUAL' as LeavePool })),
  ]
    .filter((r) => r.pool === 'ANNUAL')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = 0;
  const ledgerRows = rows.map((r) => {
    running = round2(running + r.days);
    return { date: r.date, kind: r.kind, note: r.note, days: r.days, running };
  });

  return {
    asOf,
    year,
    annual: {
      balance,
      carriedIn: round2(carriedIn),
      accruedThisYear: round2(accrued),
      usedThisYear: round2(paidThisYear(annualAlloc) + adjustments('ANNUAL')),
      nextCredit: policy ? { date: nextMonthDate, days: Number(policy.accrualPerMonth) } : null,
    },
    optional: { quota, used: round2(optionalUsed), remaining: optionalRemaining },
    birthday: { quota: round2(birthdayQuota), used: round2(birthdayUsed), remaining: birthdayRemaining },
    // A second birthday half-day in a year is unpaid, so it counts towards the month's salary cut like annual leave beyond balance.
    lopByMonth: lopByMonth([...annualAlloc, ...birthdayAlloc]),
    allocations,
    ledger: ledgerRows,
    yearEnd: month >= 11 ? { balance, carryForward: Math.min(balance, cap), willLapse: yearEndLapse(balance, cap) } : null,
  };
}

/** Used by the loader shortcut in routes. */
export { loadRecords };
