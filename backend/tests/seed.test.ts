import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { leaveBalanceAt, resolveRule, type LedgerEntry, type WorkRule } from '@oht/engine';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const email = `seed-${Date.now()}-${process.pid}@example.test`;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const iso = (dt: Date): string => dt.toISOString().slice(0, 10);

describe('seed + engine contract', () => {
  it("seeds the owner's real position and the engine reads it back as 12.75 and 1", async () => {
    const user = await seedOwner(prisma, { email, trackingStart: '2026-09-21' });

    const rows = await prisma.leaveLedgerEntry.findMany({ where: { userId: user.id } });
    const entries: LedgerEntry[] = rows.map((r) => ({
      pool: r.pool,
      type: r.type,
      days: Number(r.days),
      effectiveDate: iso(r.effectiveDate),
    }));

    expect(leaveBalanceAt(entries, [], 'ANNUAL', '2026-09-19')).toBe(12.75);
    expect(leaveBalanceAt(entries, [], 'OPTIONAL', '2026-09-19')).toBe(1);
  });

  it('seeds a work rule the engine can resolve', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const r = await prisma.workRule.findFirstOrThrow({ where: { userId: user.id } });
    const rule: WorkRule = {
      dailyRequiredMinutes: r.dailyRequiredMinutes,
      weeklyRequiredMinutes: r.weeklyRequiredMinutes,
      halfDayRequiredMinutes: r.halfDayRequiredMinutes,
      workingDays: r.workingDays,
      weekStartsOn: r.weekStartsOn,
      effectiveFrom: iso(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null,
    };
    expect(resolveRule([rule], '2026-09-21').dailyRequiredMinutes).toBe(480);
    expect(rule.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('is idempotent', async () => {
    await seedOwner(prisma, { email, trackingStart: '2026-09-21' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: user.id } })).toBe(13);
    expect(await prisma.workRule.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.leavePolicy.count({ where: { userId: user.id } })).toBe(1);
  });
});
