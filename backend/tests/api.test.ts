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

/** A fresh seeded owner with its own app and a controllable clock. */
async function setup(now: number) {
  const email = `api-${Date.now()}-${process.pid}-${++seq}@example.test`;
  emails.push(email);
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  const clock = { now };
  const app = createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  return { app, clock, email };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const addSession = (app: ReturnType<typeof createApp>, date: string, inn: string, out: string | null) =>
  request(app)
    .post(`/api/attendance/${date}/sessions`)
    .send({ inTime: `${date}T${inn}`, outTime: out ? `${date}T${out}` : null });

describe('a normal day: check in, out, in again', () => {
  it('tracks the day and answers the dashboard questions', async () => {
    const { app, clock } = await setup(at('2026-09-21', '08:02'));

    const inRes = await request(app).post('/api/attendance/check-in');
    expect(inRes.status).toBe(201);
    expect(inRes.body.day.isInside).toBe(true);

    const dup = await request(app).post('/api/attendance/check-in');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_CHECKED_IN');
    expect(dup.body.error.message).toBe('You are already checked in since 08:02.');

    clock.now = at('2026-09-21', '11:30');
    const out = await request(app).post('/api/attendance/check-out');
    expect(out.status).toBe(200);
    expect(out.body.day.workedMinutes).toBe(208);
    expect(out.body.day.isInside).toBe(false);

    const outAgain = await request(app).post('/api/attendance/check-out');
    expect(outAgain.status).toBe(409);
    expect(outAgain.body.error.message).toBe('No active session to check out.');

    clock.now = at('2026-09-21', '12:15');
    expect((await request(app).post('/api/attendance/check-in')).status).toBe(201);

    clock.now = at('2026-09-21', '15:42');
    const today = await request(app).get('/api/attendance/today');
    expect(today.body.day.workedMinutes).toBe(415);
    expect(today.body.day.outsideMinutes).toBe(45);
    expect(today.body.live.status).toBe('INSIDE');
    expect(today.body.live.remainingMinutes).toBe(65);
    expect(today.body.live.expectedOutClock).toBe('4:47 PM');
    expect(today.body.message).toBe('You need 1h 05m more.');

    const dash = await request(app).get('/api/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.today.workedMinutes).toBe(415);
    expect(dash.body.week.requiredMinutes).toBe(2400);
    expect(dash.body.leave.annualBalance).toBe(12.75);
    expect(dash.body.leave.optionalRemaining).toBe(1);
    expect(dash.body.leave.nextCredit).toEqual({ date: '2026-10-01', days: 1.75 });
    // 7-18 Sep working days with nothing recorded are flagged.
    expect(dash.body.alerts.unrecordedDates).toHaveLength(10);
  });

  it('lets exactly one of two simultaneous check-ins through', async () => {
    const { app } = await setup(at('2026-09-21', '09:00'));
    const [a, b] = await Promise.all([
      request(app).post('/api/attendance/check-in'),
      request(app).post('/api/attendance/check-in'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});

describe('fixing past days', () => {
  it('validates sessions with clear messages and repairs a forgotten OUT', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const D = '2026-09-17';

    expect((await addSession(app, D, '08:05', '12:35')).status).toBe(201);
    const second = await addSession(app, D, '13:20', '16:10');
    expect(second.status).toBe(201);
    expect(second.body.day.workedMinutes).toBe(440);
    expect(second.body.day.outsideMinutes).toBe(45);

    const overlap = await addSession(app, D, '12:00', '13:00');
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toBe('This overlaps your 08:05-12:35 session.');

    const backwards = await addSession(app, D, '10:00', '09:00');
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('OUT_BEFORE_IN');

    const wrongDate = await request(app)
      .post(`/api/attendance/${D}/sessions`)
      .send({ inTime: '2026-09-18T09:00', outTime: '2026-09-18T10:00' });
    expect(wrongDate.status).toBe(400);
    expect(wrongDate.body.error.code).toBe('IN_DATE_MISMATCH');

    const open = await addSession(app, D, '16:45', null);
    expect(open.status).toBe(201);
    expect(open.body.day.isIncomplete).toBe(true);
    expect(open.body.day.workedMinutes).toBe(440);
    expect(open.body.day.balanceMinutes).toBe(-40);

    // Checking out days later must not guess the OUT time.
    const checkOut = await request(app).post('/api/attendance/check-out');
    expect(checkOut.status).toBe(409);
    expect(checkOut.body.error.code).toBe('OPEN_SESSION_FROM_PAST');
    const sessionId = checkOut.body.error.details.sessionId as string;

    const fixed = await request(app).put(`/api/sessions/${sessionId}`).send({ outTime: `${D}T17:20` });
    expect(fixed.status).toBe(200);
    expect(fixed.body.day.isIncomplete).toBe(false);
    expect(fixed.body.day.workedMinutes).toBe(475);
    expect(fixed.body.day.balanceMinutes).toBe(-5);

    const audits = await prisma.auditLog.count({ where: { entity: 'AttendanceSession', entityId: sessionId } });
    expect(audits).toBeGreaterThanOrEqual(2);
  });

  it('removing the last session of a plain day makes it unrecorded again (no hidden shortfall)', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const created = await addSession(app, '2026-09-16', '09:00', '10:00');
    const id = created.body.sessions[0].id as string;
    const after = await request(app).delete(`/api/sessions/${id}`);
    expect(after.status).toBe(200);
    expect(after.body.day.isUnrecorded).toBe(true);
    expect(after.body.sessions).toEqual([]);
  });

  it("cannot touch another user's session", async () => {
    const a = await setup(at('2026-09-21', '10:00'));
    const b = await setup(at('2026-09-21', '10:00'));
    const created = await addSession(a.app, '2026-09-16', '09:00', '10:00');
    const res = await request(b.app).delete(`/api/sessions/${created.body.sessions[0].id}`);
    expect(res.status).toBe(404);
  });
});

describe('day status', () => {
  it('records leave and rejects invalid combinations', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));

    const leave = await request(app).put('/api/attendance/2026-09-16').send({ status: 'CASUAL_LEAVE' });
    expect(leave.status).toBe(200);
    expect(leave.body.day.kind).toBe('FULL_LEAVE');
    expect(leave.body.day.balanceMinutes).toBeNull();

    const half = await request(app).put('/api/attendance/2026-09-15').send({ status: 'SICK_LEAVE', dayFraction: 0.5 });
    expect(half.body.day.kind).toBe('HALF_DAY_LEAVE');
    expect(half.body.day.requiredMinutes).toBe(240);

    const weekend = await request(app).put('/api/attendance/2026-09-19').send({ status: 'CASUAL_LEAVE' });
    expect(weekend.status).toBe(400);
    expect(weekend.body.error.code).toBe('LEAVE_ON_NON_WORKING_DAY');

    const badHalf = await request(app).put('/api/attendance/2026-09-14').send({ status: 'WORKING', dayFraction: 0.5 });
    expect(badHalf.body.error.code).toBe('HALF_DAY_NOT_ALLOWED');

    const optional = await request(app).put('/api/attendance/2026-09-14').send({ status: 'OPTIONAL_HOLIDAY' });
    expect(optional.body.error.code).toBe('OPTIONAL_HOLIDAY_NOT_LISTED');

    const wfh = await request(app).put('/api/attendance/2026-09-10').send({ status: 'WFH', notes: 'Home' });
    expect(wfh.body.day.kind).toBe('WFH');
    expect(wfh.body.notes).toBe('Home');
  });
});

describe('weekly and monthly summaries', () => {
  it('reproduces the design example: 32h required, 30h 20m worked, -1h 40m', async () => {
    const { app, clock } = await setup(at('2026-09-18', '15:42'));
    await addSession(app, '2026-09-14', '08:00', '16:10');
    await addSession(app, '2026-09-15', '08:00', '16:00');
    await request(app).put('/api/attendance/2026-09-16').send({ status: 'CASUAL_LEAVE' });
    await addSession(app, '2026-09-17', '08:05', '12:35');
    await addSession(app, '2026-09-17', '13:20', '16:10');
    await addSession(app, '2026-09-18', '08:00', '14:50');

    const week = await request(app).get('/api/summary/week?date=2026-09-18');
    expect(week.status).toBe(200);
    expect(week.body.start).toBe('2026-09-14');
    expect(week.body.requiredMinutes).toBe(1920);
    expect(week.body.workedMinutes).toBe(1820);
    expect(week.body.balanceMinutes).toBe(-100);
    expect(week.body.counts.working).toBe(4);
    expect(week.body.counts.leaveDays).toBe(1);
    expect(week.body.counts.weeklyOffs).toBe(2);

    const month = await request(app).get('/api/summary/month?year=2026&month=9');
    expect(month.body.throughDate).toBe('2026-09-18');
    expect(month.body.workedMinutes).toBe(1820);

    const range = await request(app).get('/api/attendance?startDate=2026-09-14&endDate=2026-09-18');
    expect(range.body.days).toHaveLength(5);
    clock.now = at('2026-09-19', '10:00');
  });
});

describe('work rules are versioned', () => {
  it('closes the old rule and keeps history on the old one', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const created = await request(app).post('/api/rules').send({
      dailyRequiredMinutes: 450,
      weeklyRequiredMinutes: 2250,
      halfDayRequiredMinutes: 225,
      workingDays: [1, 2, 3, 4, 5],
      effectiveFrom: '2026-09-17',
    });
    expect(created.status).toBe(201);

    const rules = await request(app).get('/api/rules');
    expect(rules.body.rules).toHaveLength(2);
    expect(rules.body.rules[1].effectiveTo).toBe('2026-09-16');

    const before = await request(app).get('/api/attendance/2026-09-16');
    const after = await request(app).get('/api/attendance/2026-09-17');
    expect(before.body.day.requiredMinutes).toBe(480);
    expect(after.body.day.requiredMinutes).toBe(450);

    const stale = await request(app).post('/api/rules').send({
      dailyRequiredMinutes: 400,
      weeklyRequiredMinutes: 2000,
      halfDayRequiredMinutes: 200,
      workingDays: [1, 2, 3, 4, 5],
      effectiveFrom: '2026-09-10',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('RULE_DATE_INVALID');
  });
});

describe('holidays and import', () => {
  it('previews, commits and honours duplicates', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const csv = [
      'date,name,type,description',
      '2026-10-19,Diwali,COMPANY,',
      '2026-10-19,Dup,COMPANY,',
      '31-02-2026,Bad date,COMPANY,',
      '25-Dec-2026,Christmas,OPTIONAL,Optional',
      '2026-11-05,Wrong type,WRONG,',
    ].join('\n');

    const preview = await request(app).post('/api/holidays/import/preview').send({ csv });
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toEqual({ new: 2, duplicates: 0, errors: 3 });
    expect(preview.body.rows[2].error).toBe('Invalid date');
    expect(await prisma.holiday.count({ where: { user: { email: { in: emails } } } })).toBe(0);

    const commit = await request(app).post('/api/holidays/import/commit').send({ csv });
    expect(commit.body).toEqual({ imported: 2, overwritten: 0, skippedDuplicates: 0, errors: 3 });

    const again = await request(app).post('/api/holidays/import/commit').send({ csv });
    expect(again.body.imported).toBe(0);

    const overwrite = await request(app)
      .post('/api/holidays/import/commit')
      .send({ csv: 'date,name,type\n2026-10-19,Deepavali,COMPANY', duplicates: 'overwrite' });
    expect(overwrite.body.overwritten).toBe(1);

    const list = await request(app).get('/api/holidays?year=2026');
    expect(list.body.holidays.map((h: { name: string }) => h.name)).toEqual(['Deepavali', 'Christmas']);

    const preview2 = await request(app)
      .post('/leave-not-a-route')
      .send({});
    expect(preview2.status).toBe(404);

    const badHoliday = await request(app).post('/api/holidays').send({ date: '2026-02-30', name: 'x' });
    expect(badHoliday.status).toBe(400);
    expect(badHoliday.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('leave', () => {
  it('previews unpaid days before saving and records them by month', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));

    const small = await request(app)
      .post('/api/leave/preview')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-09-22', endDate: '2026-09-23' });
    expect(small.body).toMatchObject({ totalDays: 2, paid: 2, lop: 0, warning: null });

    const big = await request(app)
      .post('/api/leave/preview')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-10-01', endDate: '2026-10-30' });
    expect(big.body.totalDays).toBe(22);
    expect(big.body.paid).toBe(14.5);
    expect(big.body.lop).toBe(7.5);
    expect(big.body.warning).toBe('7.50 day(s) will be unpaid (salary cut).');
    expect(big.body.managerMessage).toContain('7.50 day(s) would be unpaid');

    const applied = await request(app)
      .post('/api/leave/apply')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-10-01', endDate: '2026-10-30', managerInformed: true });
    expect(applied.status).toBe(201);

    const summary = await request(app).get('/api/leave');
    expect(summary.body.lopByMonth).toEqual({ '2026-10': 7.5 });
    expect(summary.body.annual.balance).toBe(12.75); // future leave does not reduce today's balance
    expect(summary.body.annual.carriedIn).toBe(2);
    expect(summary.body.annual.accruedThisYear).toBe(15.75);
    expect(summary.body.annual.usedThisYear).toBe(5);
  });

  it('handles half days, weekends and holidays', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    await request(app).post('/api/holidays').send({ date: '2026-09-24', name: 'Test holiday' });

    const half = await request(app)
      .post('/api/leave/preview')
      .send({ type: 'SICK_LEAVE', startDate: '2026-09-22', endDate: '2026-09-22', half: true });
    expect(half.body.totalDays).toBe(0.5);

    const weekend = await request(app)
      .post('/api/leave/preview')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-09-26', endDate: '2026-09-27' });
    expect(weekend.body.workingDays).toEqual([]);
    expect(weekend.body.skipped).toHaveLength(2);
    const noApply = await request(app)
      .post('/api/leave/apply')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-09-26', endDate: '2026-09-27' });
    expect(noApply.status).toBe(400);
    expect(noApply.body.error.code).toBe('NO_WORKING_DAYS');

    const spanning = await request(app)
      .post('/api/leave/preview')
      .send({ type: 'CASUAL_LEAVE', startDate: '2026-09-23', endDate: '2026-09-25' });
    expect(spanning.body.workingDays).toEqual(['2026-09-23', '2026-09-25']);
    expect(spanning.body.skipped[0].reason).toBe('Company holiday');
  });

  it('limits bereavement leave to 5 days per event', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const noEvent = await request(app)
      .post('/api/leave/apply')
      .send({ type: 'BEREAVEMENT_LEAVE', startDate: '2026-09-22', endDate: '2026-09-24' });
    expect(noEvent.body.error.code).toBe('BEREAVEMENT_EVENT_REQUIRED');

    const event = await request(app)
      .post('/api/leave/bereavement-events')
      .send({ relation: 'Family member', startDate: '2026-09-22' });
    const id = event.body.id as string;

    const tooMany = await request(app)
      .post('/api/leave/apply')
      .send({ type: 'BEREAVEMENT_LEAVE', startDate: '2026-09-22', endDate: '2026-09-29', bereavementEventId: id });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('BEREAVEMENT_LIMIT');

    const ok = await request(app)
      .post('/api/leave/apply')
      .send({ type: 'BEREAVEMENT_LEAVE', startDate: '2026-09-22', endDate: '2026-09-28', bereavementEventId: id });
    expect(ok.status).toBe(201);
    const summary = await request(app).get('/api/leave');
    expect(summary.body.bereavement.events[0].daysUsed).toBe(5);
    expect(summary.body.annual.balance).toBe(12.75); // bereavement never touches the annual pool
  });
});

describe('year rollover (lazy ledger)', () => {
  it('lapses everything above 3 days, grants the new optional quota, and is idempotent', async () => {
    const { app, clock } = await setup(at('2027-01-05', '10:00'));
    clock.now = at('2027-01-05', '10:00');

    const first = await request(app).get('/api/leave');
    expect(first.status).toBe(200);
    // 12.75 + Oct/Nov/Dec credits (5.25) = 18.00 at year end; 15.00 lapses; 3.00 carries; + 1.75 in January.
    expect(first.body.annual.balance).toBe(4.75);
    expect(first.body.annual.carriedIn).toBe(3);
    expect(first.body.optional.remaining).toBe(2);
    const kinds = first.body.ledger.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain('LAPSE');

    const second = await request(app).get('/api/leave');
    expect(second.body.ledger).toEqual(first.body.ledger);
    expect(second.body.annual.balance).toBe(4.75);
  });
});

describe('access control and input handling', () => {
  it('rejects unauthenticated requests but keeps health public', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const anon = createApp({ prisma, clock: () => Date.now(), authenticate: async () => null });
    expect((await request(anon).get('/api/health')).status).toBe(200);
    const res = await request(anon).get('/api/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect((await request(app).get('/api/health')).body.ok).toBe(true);
  });

  it('returns clear validation errors and never leaks internals', async () => {
    const { app } = await setup(at('2026-09-21', '10:00'));
    const badDate = await request(app).get('/api/attendance/2026-13-40');
    expect(badDate.status).toBe(400);
    expect(badDate.body.error.code).toBe('VALIDATION_ERROR');

    const badJson = await request(app).post('/api/rules').set('Content-Type', 'application/json').send('{oops');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('INVALID_JSON');

    const unknown = await request(app).get('/api/nothing-here');
    expect(unknown.status).toBe(404);

    const range = await request(app).get('/api/attendance?startDate=2026-09-10&endDate=2026-09-01');
    expect(range.body.error.code).toBe('INVALID_RANGE');
  });
});

describe('before the tracking start date', () => {
  it('refuses to record anything, with a clear message', async () => {
    const { app } = await setup(at('2026-08-31', '09:00')); // tracking starts 2026-09-01
    const expected = 'Tracking starts on 1 Sep 2026. Nothing before that date is counted.';

    const checkIn = await request(app).post('/api/attendance/check-in');
    expect(checkIn.status).toBe(400);
    expect(checkIn.body.error).toMatchObject({ code: 'BEFORE_TRACKING_START', message: expected });

    expect((await addSession(app, '2026-08-30', '09:00', '10:00')).body.error.code).toBe('BEFORE_TRACKING_START');
    const status = await request(app).put('/api/attendance/2026-08-28').send({ status: 'WFH' });
    expect(status.body.error.code).toBe('BEFORE_TRACKING_START');

    // Nothing was stored, so the dashboard and "already checked in" can never disagree.
    const dash = await request(app).get('/api/dashboard');
    expect(dash.body.trackingStartDate).toBe('2026-09-01');
    expect(dash.body.today.kind).toBe('BEFORE_TRACKING');
    expect(dash.body.today.isInside).toBe(false);
  });
});
