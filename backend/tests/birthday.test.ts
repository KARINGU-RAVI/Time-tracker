import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { checksumOf } from '../src/services/backup';
import { seedOwner } from '../prisma/seed-lib';

/**
 * Birthday half-day: half a day a year, always a half day, separate from the 21 annual days, and unpaid if taken twice in a year.
 */

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const emails: string[] = [];
let seq = 0;
const D = '2026-09-22'; // Tuesday, inside tracking
const NOW = istInstant('2026-09-23', '10:00');

type App = ReturnType<typeof createApp>;

/** A fresh account set up through the real wizard, with the birthday half-day NOT yet taken. */
async function fresh(now = NOW, birthdayTaken = false) {
  const email = `bday-${RUN}-${++seq}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  const clock = { now };
  const app = createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  const setup = await request(app).post('/api/setup/complete').send({
    acknowledged: true,
    profile: { name: 'Birthday Tester' },
    work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-01' },
    leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0, birthdayQuota: 0.5, birthdayTaken, creditsFromMonth: 1 },
    holidays: { source: 'none' },
  });
  expect(setup.status).toBe(201);
  return { app, clock, email, id: user.id };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const apply = (app: App, body: object) => request(app).post('/api/leave/apply').send(body);
const leave = async (app: App) => (await request(app).get('/api/leave')).body;

describe('taking a birthday half-day', () => {
  it('starts with half a day available and takes it without touching annual leave', async () => {
    const { app } = await fresh();
    const before = await leave(app);
    expect(before.birthday).toEqual({ quota: 0.5, used: 0, remaining: 0.5 });

    const res = await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applied: [D], paid: 0.5, lop: 0, warning: null });

    const after = await leave(app);
    expect(after.birthday).toEqual({ quota: 0.5, used: 0.5, remaining: 0 });
    expect(after.annual.balance).toBe(before.annual.balance); // the 21 days are untouched
    expect(after.annual.usedThisYear).toBe(before.annual.usedThisYear);
    expect(after.optional).toEqual(before.optional);
  });

  it('is stored as a half day whatever the form sends, and the day then needs 4 hours', async () => {
    const { app, id } = await fresh();
    expect((await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D, half: false })).status).toBe(201);
    const row = await prisma.attendance.findFirstOrThrow({ where: { userId: id } });
    expect(row.status).toBe('BIRTHDAY_LEAVE');
    expect(Number(row.dayFraction)).toBe(0.5);
    const day = await request(app).get(`/api/attendance/${D}`);
    expect(day.body.day.kind).toBe('BIRTHDAY_HALF_DAY');
    expect(day.body.day.requiredMinutes).toBe(240);
  });

  it('can also be set from the day screen, and a full-day fraction there is corrected to half', async () => {
    const { app, id } = await fresh();
    const res = await request(app).put(`/api/attendance/${D}`).send({ status: 'BIRTHDAY_LEAVE', dayFraction: 1 });
    expect(res.status).toBe(200);
    expect(Number((await prisma.attendance.findFirstOrThrow({ where: { userId: id } })).dayFraction)).toBe(0.5);
    // Changing it back to a normal day restores a full day.
    expect((await request(app).put(`/api/attendance/${D}`).send({ status: 'WORKING', dayFraction: 1 })).status).toBe(200);
    expect(Number((await prisma.attendance.findFirstOrThrow({ where: { userId: id } })).dayFraction)).toBe(1);
  });

  it('must be a single date, and is skipped on weekends and holidays', async () => {
    const { app } = await fresh();
    const range = await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: '2026-09-22', endDate: '2026-09-23' });
    expect(range.status).toBe(400);
    const sat = await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: '2026-09-19', endDate: '2026-09-19' });
    expect(sat.status).toBe(400);
    expect(sat.body.error.code).toBe('NO_WORKING_DAYS');
    expect((await leave(app)).birthday.used).toBe(0);
  });

  it('a second one in the same year is recorded but unpaid, and counts towards that month\'s salary cut', async () => {
    const { app } = await fresh();
    expect((await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: '2026-09-22', endDate: '2026-09-22' })).body.lop).toBe(0);
    const preview = await request(app).post('/api/leave/preview').send({ type: 'BIRTHDAY_LEAVE', startDate: '2026-09-23', endDate: '2026-09-23' });
    expect(preview.body).toMatchObject({ paid: 0, lop: 0.5 });
    expect(preview.body.warning).toMatch(/unpaid/);
    expect(preview.body.managerMessage).toMatch(/birthday half-day/);
    const second = await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: '2026-09-23', endDate: '2026-09-23' });
    expect(second.status).toBe(201); // saving is never blocked
    expect(second.body).toMatchObject({ paid: 0, lop: 0.5 });
    const summary = await leave(app);
    expect(summary.birthday.remaining).toBe(0);
    expect(summary.lopByMonth['2026-09']).toBe(0.5);
  });

  it('an account that already took it (the wizard says so) has none left', async () => {
    const { app } = await fresh(NOW, true);
    expect((await leave(app)).birthday).toEqual({ quota: 0.5, used: 0.5, remaining: 0 });
    const preview = await request(app).post('/api/leave/preview').send({ type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    expect(preview.body.lop).toBe(0.5);
  });

  it('removing the day gives the allowance back', async () => {
    const { app } = await fresh();
    await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    expect((await leave(app)).birthday.remaining).toBe(0);
    await request(app).put(`/api/attendance/${D}`).send({ status: 'WORKING', dayFraction: 1 });
    expect((await leave(app)).birthday.remaining).toBe(0.5);
  });
});

describe('each year has its own allowance', () => {
  it('a new year brings a fresh half day, and an unused one lapses', async () => {
    const { app, clock, id } = await fresh();
    clock.now = istInstant('2027-01-05', '10:00');
    const s = await leave(app);
    expect(s.year).toBe(2027);
    expect(s.birthday).toEqual({ quota: 0.5, used: 0, remaining: 0.5 }); // 2026's unused half day did not pile up to a full day
    const entries = await prisma.leaveLedgerEntry.findMany({ where: { userId: id, pool: 'BIRTHDAY' }, orderBy: [{ effectiveDate: 'asc' }, { type: 'asc' }] });
    expect(entries.map((e) => `${e.type} ${Number(e.days)} ${e.effectiveDate.toISOString().slice(0, 10)}`)).toEqual([
      'GRANT 0.5 2026-01-01',
      'LAPSE -0.5 2026-12-31',
      'GRANT 0.5 2027-01-01',
    ]);
    // Asking again changes nothing (the yearly step is safe to repeat).
    await leave(app);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id, pool: 'BIRTHDAY' } })).toBe(3);
  });

  it('one taken in 2026 does not use up 2027\'s', async () => {
    const { app, clock } = await fresh();
    await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    clock.now = istInstant('2027-02-01', '10:00');
    expect((await leave(app)).birthday).toEqual({ quota: 0.5, used: 0, remaining: 0.5 });
  });
});

describe('accounts made before the feature', () => {
  it('get the allowance the first time their leave is looked at', async () => {
    const { app, id } = await fresh();
    await prisma.leaveLedgerEntry.deleteMany({ where: { userId: id, pool: 'BIRTHDAY' } }); // as if created before the feature
    const s = await leave(app);
    expect(s.birthday).toEqual({ quota: 0.5, used: 0, remaining: 0.5 });
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id, pool: 'BIRTHDAY' } })).toBe(1);
  });

  it('no allowance is created when the policy says zero', async () => {
    const { app, id } = await fresh();
    await prisma.leaveLedgerEntry.deleteMany({ where: { userId: id, pool: 'BIRTHDAY' } });
    await prisma.leavePolicy.updateMany({ where: { userId: id }, data: { birthdayQuota: 0 } });
    expect((await leave(app)).birthday).toEqual({ quota: 0, used: 0, remaining: 0 });
  });
});

describe('database rules', () => {
  it('refuses a birthday leave that is not exactly half a day, and a full-day fraction on it', async () => {
    const { id } = await fresh();
    const date = new Date('2026-09-22T00:00:00Z');
    await expect(prisma.attendance.create({ data: { userId: id, date, status: 'BIRTHDAY_LEAVE', dayFraction: 1 } })).rejects.toThrow(/attendance_birthday_is_half_day|attendance_half_day/);
    const ok = await prisma.attendance.create({ data: { userId: id, date, status: 'BIRTHDAY_LEAVE', dayFraction: 0.5 } });
    expect(ok.status).toBe('BIRTHDAY_LEAVE');
    await expect(prisma.attendance.update({ where: { id: ok.id }, data: { dayFraction: 1 } })).rejects.toThrow(/attendance_birthday_is_half_day/);
  });

  it('other statuses still cannot be half days (only casual, sick and birthday)', async () => {
    const { id } = await fresh();
    await expect(prisma.attendance.create({ data: { userId: id, date: new Date('2026-09-23T00:00:00Z'), status: 'WFH', dayFraction: 0.5 } })).rejects.toThrow(/attendance_half_day_only/);
    await expect(prisma.attendance.create({ data: { userId: id, date: new Date('2026-09-24T00:00:00Z'), status: 'OPTIONAL_HOLIDAY', dayFraction: 0.5 } })).rejects.toThrow(/attendance_half_day_only/);
  });

  it('a person can hold only one birthday allowance grant per year', async () => {
    const { id } = await fresh();
    await expect(
      prisma.leaveLedgerEntry.create({ data: { userId: id, pool: 'BIRTHDAY', type: 'GRANT', days: 0.5, effectiveDate: new Date('2026-01-01T00:00:00Z'), leaveYear: 2026 } }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe('backup and restore', () => {
  it('a backup round-trips the birthday leave, its allowance and its policy', async () => {
    const { app } = await fresh();
    await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    const backup = (await request(app).get('/api/backup')).body;
    expect(backup.data.attendance.find((a: { status: string }) => a.status === 'BIRTHDAY_LEAVE').dayFraction).toBe(0.5);
    expect(backup.data.leavePolicies[0].birthdayQuota).toBe(0.5);
    expect(backup.data.ledger.some((l: { pool: string }) => l.pool === 'BIRTHDAY')).toBe(true);

    const other = await fresh();
    const res = await request(other.app).post('/api/backup/restore').send({ confirm: 'REPLACE', backup });
    expect(res.status).toBe(200);
    expect((await leave(other.app)).birthday).toEqual({ quota: 0.5, used: 0.5, remaining: 0 });
    expect((await request(other.app).get(`/api/attendance/${D}`)).body.day.kind).toBe('BIRTHDAY_HALF_DAY');
  });

  it('a backup made before this feature (no birthday fields) still restores, and gets the default allowance', async () => {
    const { app } = await fresh();
    const backup = (await request(app).get('/api/backup')).body;
    // Turn it into an old-format file: no birthday quota, no birthday ledger rows, and a valid checksum for that content.
    for (const p of backup.data.leavePolicies) delete p.birthdayQuota;
    backup.data.ledger = backup.data.ledger.filter((l: { pool: string }) => l.pool !== 'BIRTHDAY');
    backup.checksum = checksumOf(backup.data);

    const target = await fresh();
    const validate = await request(target.app).post('/api/backup/validate').send(backup);
    expect(validate.status).toBe(200);
    expect((await request(target.app).post('/api/backup/restore').send({ confirm: 'REPLACE', backup })).status).toBe(200);
    expect((await leave(target.app)).birthday).toEqual({ quota: 0.5, used: 0, remaining: 0.5 });
  });

  it('refuses a file that claims a full-day birthday leave', async () => {
    const { app } = await fresh();
    await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    const backup = (await request(app).get('/api/backup')).body;
    backup.data.attendance.find((a: { status: string }) => a.status === 'BIRTHDAY_LEAVE').dayFraction = 1;
    backup.checksum = checksumOf(backup.data);
    const res = await request(app).post('/api/backup/validate').send(backup);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/birthday leave is always a half day/);
  });

  it('the CSV export labels it', async () => {
    const { app } = await fresh();
    await apply(app, { type: 'BIRTHDAY_LEAVE', startDate: D, endDate: D });
    const csv = await request(app).get('/api/export/csv?startDate=2026-09-01&endDate=2026-09-30');
    expect(csv.text).toContain('Birthday half-day');
  });
});

describe('the owner\'s own account', () => {
  it('shows the half-day already taken on 14 Jul, with none left, and 12.75 annual days unchanged', async () => {
    const email = `bday-owner-${RUN}@example.test`;
    emails.push(email);
    await seedOwner(prisma, { email, trackingStart: '2026-09-21' });
    const app = createApp({ prisma, clock: () => istInstant('2026-09-19', '10:00'), authenticate: devAuthenticator(prisma, email) });
    const s = await leave(app);
    expect(s.birthday).toEqual({ quota: 0.5, used: 0.5, remaining: 0 });
    expect(s.annual.balance).toBe(12.75);
    expect(s.optional.remaining).toBe(1);
  });
});
