import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { seedOwner } from '../prisma/seed-lib';

/**
 * Two real users share one database. Whatever user B does, by id, by date, by restore or by export,
 * user A's data must never be visible, changeable or removable. 404 (not 403) is expected for foreign ids,
 * so an id cannot even be confirmed to exist.
 */

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const NOW = istInstant('2026-09-23', '18:00');
const D = '2026-09-22'; // a Tuesday inside tracking
const emailA = `iso-a-${RUN}@example.test`;
const emailB = `iso-b-${RUN}@example.test`;

type App = ReturnType<typeof createApp>;
let A: App;
let B: App;
let idA: string;
let idB: string;
let sessionA: string;
let holidayA: string;

const mk = (email: string) => createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) });

/** Everything that belongs to a user, as one comparable snapshot. */
async function snapshot(userId: string) {
  const [attendance, sessions, holidays, rules, policies, ledger, audits, settings] = await Promise.all([
    prisma.attendance.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
    prisma.attendanceSession.findMany({ where: { userId }, orderBy: { inTime: 'asc' } }),
    prisma.holiday.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
    prisma.workRule.findMany({ where: { userId } }),
    prisma.leavePolicy.findMany({ where: { userId } }),
    prisma.leaveLedgerEntry.findMany({ where: { userId }, orderBy: [{ effectiveDate: 'asc' }, { type: 'asc' }] }),
    prisma.auditLog.count({ where: { userId } }),
    prisma.userSettings.findUnique({ where: { userId } }),
  ]);
  return JSON.stringify({ attendance, sessions, holidays, rules, policies, ledger, audits, settings });
}

beforeAll(async () => {
  idA = (await seedOwner(prisma, { email: emailA, trackingStart: '2026-09-01' })).id;
  idB = (await seedOwner(prisma, { email: emailB, trackingStart: '2026-09-01' })).id;
  A = mk(emailA);
  B = mk(emailB);
  const s = await request(A).post(`/api/attendance/${D}/sessions`).send({ inTime: `${D}T09:00`, outTime: `${D}T17:30` });
  expect(s.status).toBe(201);
  sessionA = (await prisma.attendanceSession.findFirstOrThrow({ where: { userId: idA } })).id;
  const h = await request(A).post('/api/holidays').send({ date: '2026-10-02', name: 'Only A has this', type: 'COMPANY' });
  expect(h.status).toBe(201);
  holidayA = h.body.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  await prisma.$disconnect();
});

describe('reading', () => {
  it("B never sees A's day, sessions, holidays or leave", async () => {
    const day = await request(B).get(`/api/attendance/${D}`);
    expect(JSON.stringify(day.body)).not.toContain(sessionA);
    expect(day.body.sessions ?? []).toHaveLength(0);

    const holidays = await request(B).get('/api/holidays');
    expect(JSON.stringify(holidays.body)).not.toContain('Only A has this');
    expect(JSON.stringify(holidays.body)).not.toContain(holidayA);

    const range = await request(B).get('/api/attendance?startDate=2026-09-01&endDate=2026-09-30');
    expect(JSON.stringify(range.body)).not.toContain(sessionA);

    const week = await request(B).get(`/api/summary/week?date=${D}`);
    expect(week.body.workedMinutes).toBe(0);
    const month = await request(B).get('/api/summary/month?year=2026&month=9');
    expect(month.status).toBe(200);
    expect(month.body.workedMinutes).toBe(0);
    // ...while A's own view has the data, so the test above is meaningful.
    expect((await request(A).get(`/api/summary/week?date=${D}`)).body.workedMinutes).toBeGreaterThan(0);
  });

  it("B's export contains none of A's data", async () => {
    const backup = await request(B).get('/api/backup');
    expect(backup.status).toBe(200);
    expect(JSON.stringify(backup.body)).not.toContain(sessionA);
    expect(JSON.stringify(backup.body)).not.toContain('Only A has this');
    expect(JSON.stringify(backup.body)).not.toContain(emailA);
    const csv = await request(B).get('/api/export/csv?startDate=2026-09-01&endDate=2026-09-30');
    expect(csv.text).not.toMatch(/09:00|17:30/); // A's times (B's own row for that date is empty)
    expect(csv.text).not.toContain(sessionA);
    expect((await request(A).get('/api/export/csv?startDate=2026-09-01&endDate=2026-09-30')).text).toMatch(/09:00/); // ...and A's export does have them
  });
});

describe('changing or deleting by id', () => {
  it("B cannot edit, move or delete A's session", async () => {
    const before = await snapshot(idA);
    for (const res of [
      await request(B).put(`/api/sessions/${sessionA}`).send({ outTime: `${D}T23:00` }),
      await request(B).put(`/api/sessions/${sessionA}`).send({ inTime: `${D}T01:00` }),
      await request(B).delete(`/api/sessions/${sessionA}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect(await snapshot(idA)).toBe(before);
  });

  it("B cannot edit or delete A's holiday", async () => {
    const before = await snapshot(idA);
    const put = await request(B).put(`/api/holidays/${holidayA}`).send({ date: '2026-10-05', name: 'Hijacked', type: 'COMPANY' });
    expect(put.status).toBe(404);
    expect((await request(B).delete(`/api/holidays/${holidayA}`)).status).toBe(404);
    expect(await snapshot(idA)).toBe(before);
  });

  it('a made-up or malformed id gets the same answer as a real foreign id', async () => {
    const real = await request(B).delete(`/api/sessions/${sessionA}`);
    const madeUp = await request(B).delete('/api/sessions/00000000-0000-4000-8000-000000000000');
    expect(madeUp.status).toBe(real.status);
    expect(madeUp.body).toEqual(real.body); // no way to tell "exists but not yours" from "does not exist"
    expect((await request(B).delete('/api/sessions/not-a-uuid')).status).toBe(400);
    expect((await request(B).delete("/api/sessions/' OR 1=1 --")).status).toBe(400);
  });

  it("B's own writes on the same dates never touch A's rows", async () => {
    const before = await snapshot(idA);
    expect((await request(B).post(`/api/attendance/${D}/sessions`).send({ inTime: `${D}T09:00`, outTime: `${D}T17:30` })).status).toBe(201);
    expect((await request(B).put(`/api/attendance/${D}`).send({ status: 'CASUAL_LEAVE', dayFraction: 1 })).status).toBeLessThan(500);
    expect((await request(B).delete(`/api/attendance/${D}`)).status).toBeLessThan(500);
    expect((await request(B).post('/api/holidays').send({ date: '2026-10-02', name: 'B has the same date', type: 'COMPANY' })).status).toBe(201); // dates are unique per user, not globally
    expect(await snapshot(idA)).toBe(before);
    await request(B).delete(`/api/holidays/${(await prisma.holiday.findFirstOrThrow({ where: { userId: idB } })).id}`);
  });

  it("B's rule and leave changes do not reach A", async () => {
    const before = await snapshot(idA);
    await request(B).post('/api/rules').send({ dailyRequiredMinutes: 300, weeklyRequiredMinutes: 1500, halfDayRequiredMinutes: 150, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, effectiveFrom: '2026-10-01' });
    await request(B).post('/api/leave/apply').send({ startDate: '2026-10-05', endDate: '2026-10-05', type: 'CASUAL_LEAVE', dayFraction: 1 });
    expect(await snapshot(idA)).toBe(before);
    expect((await request(A).get('/api/rules')).body.current?.dailyRequiredMinutes ?? 480).toBe(480);
  });
});

describe('restoring a backup', () => {
  it("B restoring A's backup file replaces only B's data and leaves A untouched", async () => {
    const backupA = (await request(A).get('/api/backup')).body;
    const beforeA = await snapshot(idA);
    const res = await request(B).post('/api/backup/restore').send({ confirm: 'REPLACE', backup: backupA });
    // Whether or not the file is accepted, A must be exactly as before.
    expect(res.status).toBeLessThan(500);
    expect(await snapshot(idA)).toBe(beforeA);
    if (res.status === 200) {
      // The restored rows belong to B, not to A: a copy, never a move.
      expect(await prisma.attendanceSession.count({ where: { userId: idB } })).toBeGreaterThan(0);
      expect(await prisma.attendanceSession.count({ where: { userId: idA } })).toBe(1);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: idB } }).then((u) => u.email)).toBe(emailB); // identity is never taken from the file
    }
  });

  it("a backup that names A's email or id inside it cannot make B write into A", async () => {
    const backupA = (await request(A).get('/api/backup')).body as { data: Record<string, unknown> };
    const beforeA = await snapshot(idA);
    const forged = JSON.parse(JSON.stringify(backupA));
    forged.userId = idA;
    forged.data.userId = idA;
    forged.data.user = { id: idA, email: emailA };
    await request(B).post('/api/backup/restore').send({ confirm: 'REPLACE', backup: forged });
    expect(await snapshot(idA)).toBe(beforeA);
  });
});

describe('deleting an account', () => {
  it('removes everything of that user and nothing of anyone else', async () => {
    const emailC = `iso-c-${RUN}@example.test`;
    const idC = (await seedOwner(prisma, { email: emailC, trackingStart: '2026-09-01' })).id;
    const C = mk(emailC);
    await request(C).post(`/api/attendance/${D}/sessions`).send({ inTime: `${D}T09:00`, outTime: `${D}T17:30` });
    const beforeA = await snapshot(idA);
    const beforeB = await snapshot(idB);
    await prisma.user.delete({ where: { id: idC } });
    for (const model of ['attendance', 'attendanceSession', 'holiday', 'workRule', 'leavePolicy', 'leaveLedgerEntry', 'auditLog', 'userSettings'] as const) {
      expect(await (prisma[model] as unknown as { count: (a: object) => Promise<number> }).count({ where: { userId: idC } }), model).toBe(0);
    }
    expect(await snapshot(idA)).toBe(beforeA);
    expect(await snapshot(idB)).toBe(beforeB);
  });
});
