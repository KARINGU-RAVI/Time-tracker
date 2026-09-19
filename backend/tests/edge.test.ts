import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const at = (date: string, hhmm: string) => istInstant(date, hhmm);
const emails: string[] = [];
let seq = 0;

async function setup(now: number) {
  const email = `edge-${Date.now()}-${process.pid}-${++seq}@example.test`;
  emails.push(email);
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  const clock = { now };
  const build = () => createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  return { app: build(), build, clock, email };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

type App = ReturnType<typeof createApp>;
const session = (app: App, date: string, inn: string, out: string | null) =>
  request(app).post(`/api/attendance/${date}/sessions`).send({ inTime: `${date}T${inn}`, outTime: out ? `${date}T${out}` : null });

describe('spec edge cases at API level', () => {
  it('#5 midnight crossing: belongs to the IN date, blocks the next day\'s early hours', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const night = await request(app)
      .post('/api/attendance/2026-09-16/sessions')
      .send({ inTime: '2026-09-16T22:00', outTime: '2026-09-17T02:00' });
    expect(night.status).toBe(201);
    expect(night.body.day.workedMinutes).toBe(240);
    expect(night.body.day.date).toBe('2026-09-16');

    const clash = await session(app, '2026-09-17', '01:00', '03:00');
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toBe('This overlaps your 22:00-02:00 session.');
    expect((await session(app, '2026-09-17', '03:00', '05:00')).status).toBe(201);
  });

  it('#18/#22 refresh and accidental close: the open session survives a brand new server instance', async () => {
    const { build, clock } = await setup(at('2026-09-21', '09:00'));
    const first = build();
    expect((await request(first).post('/api/attendance/check-in')).status).toBe(201);
    clock.now = at('2026-09-21', '11:00');
    const afterRestart = await request(build()).get('/api/attendance/today');
    expect(afterRestart.body.day.isInside).toBe(true);
    expect(afterRestart.body.day.workedMinutes).toBe(120);
  });

  it('#21 duplicate requests: two identical sessions at once, exactly one is stored', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const [a, b] = await Promise.all([session(app, '2026-09-16', '09:00', '10:00'), session(app, '2026-09-16', '09:00', '10:00')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const day = await request(app).get('/api/attendance/2026-09-16');
    expect(day.body.sessions).toHaveLength(1);
  });

  it('#10 duplicate OUT and checking out within the same minute', async () => {
    const { app, clock } = await setup(at('2026-09-21', '09:00') + 5_000);
    await request(app).post('/api/attendance/check-in');
    clock.now = at('2026-09-21', '09:00') + 50_000;
    const tooSoon = await request(app).post('/api/attendance/check-out');
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error).toMatchObject({ code: 'TOO_SHORT', message: 'OUT must be after IN.' });

    clock.now = at('2026-09-21', '10:00');
    expect((await request(app).post('/api/attendance/check-out')).status).toBe(200);
    expect((await request(app).post('/api/attendance/check-out')).body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('#6 editing a session into an overlap is refused, and a valid edit recalculates the day', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    await session(app, '2026-09-16', '08:00', '10:00');
    const second = await session(app, '2026-09-16', '11:00', '12:00');
    const id = second.body.sessions[1].id as string;

    const clash = await request(app).put(`/api/sessions/${id}`).send({ inTime: '2026-09-16T09:30' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toBe('This overlaps your 08:00-10:00 session.');

    const ok = await request(app).put(`/api/sessions/${id}`).send({ inTime: '2026-09-16T10:30', outTime: '2026-09-16T12:30' });
    expect(ok.status).toBe(200);
    expect(ok.body.day.workedMinutes).toBe(120 + 120);
  });

  it('accepts times with an explicit offset and rejects unreadable ones', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const ok = await request(app)
      .post('/api/attendance/2026-09-16/sessions')
      .send({ inTime: '2026-09-16T03:30:00Z', outTime: '2026-09-16T10:30:00+05:30' }); // 09:00 to 10:30 IST
    expect(ok.status).toBe(201);
    expect(ok.body.day.workedMinutes).toBe(90);

    const bad = await request(app).post('/api/attendance/2026-09-16/sessions').send({ inTime: 'yesterday' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TIME');
  });
});

describe('deleting a day', () => {
  it('removes it, then reports not found, and never touches another user', async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    await request(a.app).put('/api/attendance/2026-09-10').send({ status: 'WFH' });
    await request(b.app).put('/api/attendance/2026-09-10').send({ status: 'WFH' });

    expect((await request(a.app).delete('/api/attendance/2026-09-10')).status).toBe(204);
    expect((await request(a.app).delete('/api/attendance/2026-09-10')).status).toBe(404);
    expect((await request(b.app).get('/api/attendance/2026-09-10')).body.status).toBe('WFH');
  });
});

describe('bereavement on a day status', () => {
  it('needs an event of your own and respects the 5-day limit', async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    const put = (app: App, date: string, body: object) => request(app).put(`/api/attendance/${date}`).send(body);

    expect((await put(a.app, '2026-09-22', { status: 'BEREAVEMENT_LEAVE' })).body.error.code).toBe('BEREAVEMENT_EVENT_REQUIRED');

    const mine = (await request(a.app).post('/api/leave/bereavement-events').send({ relation: 'Family', startDate: '2026-09-22' })).body.id as string;
    const theirs = (await request(b.app).post('/api/leave/bereavement-events').send({ relation: 'Other', startDate: '2026-09-22' })).body.id as string;

    expect((await put(a.app, '2026-09-22', { status: 'BEREAVEMENT_LEAVE', bereavementEventId: theirs })).status).toBe(404);
    expect((await put(a.app, '2026-09-22', { status: 'WORKING', bereavementEventId: mine })).body.error.code).toBe('BEREAVEMENT_EVENT_NOT_ALLOWED');

    for (const d of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28']) {
      expect((await put(a.app, d, { status: 'BEREAVEMENT_LEAVE', bereavementEventId: mine })).status).toBe(200);
    }
    const sixth = await put(a.app, '2026-09-29', { status: 'BEREAVEMENT_LEAVE', bereavementEventId: mine });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('BEREAVEMENT_LIMIT');
    // Re-saving one of the five is not a sixth day.
    expect((await put(a.app, '2026-09-28', { status: 'BEREAVEMENT_LEAVE', bereavementEventId: mine, notes: 'again' })).status).toBe(200);
  });
});

describe('dashboard reminders', () => {
  it('nudges on Thursday and Friday when behind for the week, not on Wednesday', async () => {
    const { app, clock } = await setup(at('2026-09-17', '15:00')); // Thursday
    const thu = await request(app).get('/api/dashboard');
    expect(thu.body.week.nudge).toBe("40h 00m left to reach this week's target.");

    clock.now = at('2026-09-16', '15:00'); // Wednesday
    expect((await request(app).get('/api/dashboard')).body.week.nudge).toBeNull();
  });

  it('warns about lapsing leave from November', async () => {
    const { app, clock } = await setup(at('2026-09-21', '10:00'));
    expect((await request(app).get('/api/dashboard')).body.leave.yearEnd).toBeNull();

    clock.now = at('2026-11-10', '10:00');
    const nov = await request(app).get('/api/dashboard');
    expect(nov.body.leave.yearEnd).toEqual({ balance: 16.25, carryForward: 3, willLapse: 13.25 });
  });
});

describe('leave edge cases', () => {
  it('uses the optional pool for an optional holiday listed on the date', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    await request(app).post('/api/holidays').send({ date: '2026-09-21', name: 'Optional day', type: 'OPTIONAL' });
    const applied = await request(app).post('/api/leave/apply').send({ type: 'OPTIONAL_HOLIDAY', startDate: '2026-09-21', endDate: '2026-09-21' });
    expect(applied.status).toBe(201);
    const leave = await request(app).get('/api/leave');
    expect(leave.body.optional).toMatchObject({ quota: 2, used: 2, remaining: 0 });
    expect(leave.body.annual.balance).toBe(12.75); // the annual pool is untouched
  });

  it('applying the same leave day twice counts it once', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const body = { type: 'CASUAL_LEAVE', startDate: '2026-09-16', endDate: '2026-09-16' };
    await request(app).post('/api/leave/apply').send(body);
    await request(app).post('/api/leave/apply').send(body);
    const leave = await request(app).get('/api/leave');
    expect(leave.body.annual.balance).toBe(11.75);
    expect(leave.body.annual.usedThisYear).toBe(6);
  });

  it('rejects unreasonable requests with clear codes', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const post = (body: object) => request(app).post('/api/leave/preview').send(body);
    expect((await post({ type: 'CASUAL_LEAVE', startDate: '2026-09-01', endDate: '2026-12-31' })).body.error.code).toBe('RANGE_TOO_LARGE');
    expect((await post({ type: 'CASUAL_LEAVE', startDate: '2027-01-04', endDate: '2027-01-05' })).body.error.code).toBe('LEAVE_TOO_FAR');
    expect((await post({ type: 'CASUAL_LEAVE', startDate: '2026-09-22', endDate: '2026-09-23', half: true })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ type: 'CASUAL_LEAVE', startDate: '2026-09-23', endDate: '2026-09-22' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ type: 'BEREAVEMENT_LEAVE', startDate: '2026-09-22', endDate: '2026-09-22', half: true })).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('skips days before the tracking start when previewing', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const res = await request(app).post('/api/leave/preview').send({ type: 'CASUAL_LEAVE', startDate: '2026-08-31', endDate: '2026-09-01' });
    expect(res.body.workingDays).toEqual(['2026-09-01']);
    expect(res.body.skipped[0]).toEqual({ date: '2026-08-31', reason: 'Before your tracking start date' });
  });
});

describe('work rule validation', () => {
  it('rejects nonsense rules', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const base = { dailyRequiredMinutes: 450, weeklyRequiredMinutes: 2250, halfDayRequiredMinutes: 225, workingDays: [1, 2, 3, 4, 5], effectiveFrom: '2026-10-01' };
    const post = (over: object) => request(app).post('/api/rules').send({ ...base, ...over });
    for (const bad of [{ workingDays: [1, 1, 2] }, { workingDays: [] }, { workingDays: [1, 8] }, { halfDayRequiredMinutes: 999 }, { weekStartsOn: 9 }, { dailyRequiredMinutes: 0 }, { effectiveFrom: '2026-02-30' }]) {
      expect((await post(bad)).body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await post({})).status).toBe(201);
  });
});

describe('holidays over the API', () => {
  it('edits and deletes, and users cannot touch each other\'s holidays', async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    const created = await request(a.app).post('/api/holidays').send({ date: '2026-10-19', name: 'Diwali' });
    expect(created.status).toBe(201);
    expect(created.body.affectsPastDays).toBe(false);
    const id = created.body.id as string;

    expect((await request(a.app).post('/api/holidays').send({ date: '2026-10-19', name: 'Again' })).body.error.code).toBe('DUPLICATE');
    expect((await request(a.app).post('/api/holidays').send({ date: '2026-09-07', name: 'Past' })).body.affectsPastDays).toBe(true);

    expect((await request(b.app).put(`/api/holidays/${id}`).send({ date: '2026-10-19', name: 'Hijack' })).status).toBe(404);
    expect((await request(b.app).delete(`/api/holidays/${id}`)).status).toBe(404);

    const edited = await request(a.app).put(`/api/holidays/${id}`).send({ date: '2026-10-20', name: 'Deepavali', type: 'COMPANY' });
    expect(edited.body).toMatchObject({ date: '2026-10-20', name: 'Deepavali' });
    expect((await request(a.app).delete(`/api/holidays/${id}`)).status).toBe(204);
    expect((await request(a.app).get('/api/holidays?year=2026')).body.holidays.map((h: { name: string }) => h.name)).toEqual(['Past']);
  });

  it('a company holiday changes only the owner\'s calendar', async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    await request(a.app).post('/api/holidays').send({ date: '2026-09-16', name: 'Mine' });
    expect((await request(a.app).get('/api/attendance/2026-09-16')).body.day.kind).toBe('HOLIDAY');
    expect((await request(b.app).get('/api/attendance/2026-09-16')).body.day.kind).toBe('WORKING');
  });
});

describe('users are isolated from each other', () => {
  it('never shows one user\'s sessions, leave, events or holidays to another', async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    await session(a.app, '2026-09-16', '09:00', '17:00');
    await request(a.app).post('/api/leave/apply').send({ type: 'CASUAL_LEAVE', startDate: '2026-09-15', endDate: '2026-09-15' });
    await request(a.app).post('/api/leave/bereavement-events').send({ relation: 'Family', startDate: '2026-09-22' });

    const day = await request(b.app).get('/api/attendance/2026-09-16');
    expect(day.body.sessions).toEqual([]);
    expect(day.body.day.isUnrecorded).toBe(true);
    expect((await request(b.app).get('/api/attendance/2026-09-15')).body.status).toBeNull();

    const leave = await request(b.app).get('/api/leave');
    expect(leave.body.annual.balance).toBe(12.75);
    expect(leave.body.bereavement.events).toEqual([]);

    const week = await request(b.app).get('/api/summary/week?date=2026-09-16');
    expect(week.body.workedMinutes).toBe(0);
    const range = await request(b.app).get('/api/attendance?startDate=2026-09-14&endDate=2026-09-18');
    expect(range.body.days.every((d: { workedMinutes: number }) => d.workedMinutes === 0)).toBe(true);
  });

  it('one user\'s open session never blocks another user\'s check-in', async () => {
    const a = await setup(at('2026-09-21', '09:00'));
    const b = await setup(at('2026-09-21', '09:00'));
    expect((await request(a.app).post('/api/attendance/check-in')).status).toBe(201);
    expect((await request(b.app).post('/api/attendance/check-in')).status).toBe(201);
  });
});

describe('limits', () => {
  it('refuses to return more than a year of days at once', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const res = await request(app).get('/api/attendance?startDate=2025-01-01&endDate=2026-12-31');
    expect(res.body.error.code).toBe('RANGE_TOO_LARGE');
  });
});
