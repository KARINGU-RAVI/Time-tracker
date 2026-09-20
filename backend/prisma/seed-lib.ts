import type { PrismaClient } from '@prisma/client';

const d = (date: string): Date => new Date(`${date}T00:00:00Z`);

export interface SeedOptions {
  email: string;
  /** First day hours are tracked from (YYYY-MM-DD). */
  trackingStart: string;
  /** Rule effective date (default 2026-09-01). */
  ruleFrom?: string;
}

/**
 * Seeds the single owner with the confirmed rules and opening leave position
 * (as of 19 Sep 2026): 2.00 carried, 9 x 1.75 accrued, 5.00 used before tracking
 * = 12.75 annual; optional 2 granted, 1 used = 1 left. Idempotent.
 */
export async function seedOwner(prisma: PrismaClient, opts: SeedOptions) {
  const ruleFrom = opts.ruleFrom ?? '2026-09-01';

  const user = await prisma.user.upsert({
    where: { email: opts.email },
    update: {},
    create: { email: opts.email, setupCompletedAt: new Date(), emailVerifiedAt: new Date(), isAdmin: true },
  });

  await prisma.userSettings.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, trackingStartDate: d(opts.trackingStart) },
  });

  if ((await prisma.workRule.count({ where: { userId: user.id } })) === 0) {
    await prisma.workRule.create({
      data: {
        userId: user.id,
        dailyRequiredMinutes: 480,
        weeklyRequiredMinutes: 2400,
        halfDayRequiredMinutes: 240,
        workingDays: [1, 2, 3, 4, 5],
        weekStartsOn: 1,
        effectiveFrom: d(ruleFrom),
      },
    });
  }

  if ((await prisma.leavePolicy.count({ where: { userId: user.id } })) === 0) {
    await prisma.leavePolicy.create({
      data: {
        userId: user.id,
        annualEntitlement: 21,
        accrualPerMonth: 1.75,
        carryForwardCap: 3,
        optionalQuota: 2,
        birthdayQuota: 0.5,
        bereavementDaysPerEvent: 5,
        effectiveFrom: d('2026-01-01'),
      },
    });
  }

  if ((await prisma.leaveLedgerEntry.count({ where: { userId: user.id } })) === 0) {
    const entry = (
      pool: 'ANNUAL' | 'OPTIONAL',
      type: 'OPENING' | 'ACCRUAL' | 'GRANT' | 'ADJUSTMENT',
      days: number,
      date: string,
      note?: string,
    ) => ({ userId: user.id, pool, type, days, effectiveDate: d(date), leaveYear: 2026, note });

    const rows = [
      entry('ANNUAL', 'OPENING', 2, '2026-01-01', 'Left over from 2025'),
      ...Array.from({ length: 9 }, (_, i) =>
        entry('ANNUAL', 'ACCRUAL', 1.75, `2026-${String(i + 1).padStart(2, '0')}-01`),
      ),
      entry('ANNUAL', 'ADJUSTMENT', -5, '2026-09-19', 'Leave taken before counting began'),
      entry('OPTIONAL', 'GRANT', 2, '2026-01-01', 'Optional holidays for 2026'),
      entry('OPTIONAL', 'ADJUSTMENT', -1, '2026-09-19', 'Optional holidays used before counting began'),
      // Birthday half-day: 0.5 a year, separate from annual leave; already taken on 14 Jul 2026.
      { userId: user.id, pool: 'BIRTHDAY' as const, type: 'GRANT' as const, days: 0.5, effectiveDate: d('2026-01-01'), leaveYear: 2026, note: 'Birthday half-day for 2026' },
      { userId: user.id, pool: 'BIRTHDAY' as const, type: 'ADJUSTMENT' as const, days: -0.5, effectiveDate: d('2026-09-19'), leaveYear: 2026, note: 'Birthday half-day taken before counting began' },
    ];
    await prisma.leaveLedgerEntry.createMany({ data: rows });
  }

  return user;
}
