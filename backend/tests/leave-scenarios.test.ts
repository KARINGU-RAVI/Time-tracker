import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { checksumOf } from '../src/services/backup';

/**
 * Leave, in every situation a person can be in: any dates (not only a run), bereavement over several separate days,
 * the first or second half of a day, leave from before they started using the app, and leave they forgot to add.
 */

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const emails: string[] = [];
let seq = 0;

type App = ReturnType<typeof createApp>;

/** A new account, set up through the real wizard, that started counting on `start`; "today" is `today`. */
async function account(start = '2026-09-21', today = '2026-09-23') {
  const email = `scen-${RUN}-${++seq}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  const clock = { now: istInstant(today, '10:00') };
  const app = createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  const res = await request(app).post('/api/setup/complete').send({
    acknowledged: true,
    profile: { name: 'Scenario Tester' },
    work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: start },
    leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0, birthdayQuota: 0.5, birthdayTaken: false, creditsFromMonth: 1 },
    holidays: { source: 'none' },
  });
  expect(res.status).toBe(201);
  return { app, clock, id: user.id, email };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const preview = (app: App, body: object) => request(app).post('/api/leave/preview').send(body);
const apply = (app: App, body: object) => request(app).post('/api/leave/apply').send(body);
const leave = async (app: App) => (await request(app).get('/api/leave')).body;
const rowsOf = (id: string) => prisma.attendance.findMany({ where: { userId: id }, orderBy: { date: 'asc' } });
const day = (d: string) => d;

describe('leave on any dates, not only a run of days', () => {
  it('takes exactly the dates chosen and nothing in between', async () => {
    const { app, id } = await account();
    const dates = ['2026-09-24', '2026-09-22']; // deliberately out of order
    const p = await preview(app, { type: 'CASUAL_LEAVE', dates });
    expect(p.status).toBe(200);
    expect(p.body.workingDays).toEqual(['2026-09-22', '2026-09-24']);
    expect(p.body.totalDays).toBe(2);
    expect(await apply(app, { type: 'CASUAL_LEAVE', dates })).toMatchObject({ status: 201, body: { applied: ['2026-09-22', '2026-09-24'] } });
    expect((await rowsOf(id)).map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-09-22', '2026-09-24']); // 23 Sep untouched
  });

  it('skips weekends and holidays inside a chosen list, and says why', async () => {
    const { app } = await account();
    await request(app).post('/api/holidays').send({ date: '2026-09-25', name: 'Company day', type: 'COMPANY' });
    const p = await preview(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22', '2026-09-25', '2026-09-26'] });
    expect(p.body.workingDays).toEqual(['2026-09-22']);
    expect(p.body.skipped).toEqual([
      { date: '2026-09-25', reason: 'Company holiday' },
      { date: '2026-09-26', reason: 'Weekly off' },
    ]);
  });

  it('describes chosen dates by name when a message to the manager is needed', async () => {
    const { app } = await account();
    // Use up the optional holidays so the request would be unpaid, which produces the manager message.
    await request(app).post('/api/holidays').send({ date: '2026-09-22', name: 'Opt 1', type: 'OPTIONAL' });
    await request(app).post('/api/holidays').send({ date: '2026-09-24', name: 'Opt 2', type: 'OPTIONAL' });
    await request(app).post('/api/holidays').send({ date: '2026-09-28', name: 'Opt 3', type: 'OPTIONAL' });
    const p = await preview(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-22'] });
    expect(p.body.managerMessage).toBeNull(); // paid, so no message
    await apply(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-22'] });
    const second = await preview(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-24'] });
    expect(second.body.managerMessage).toContain('on 24 Sep 2026');
  });

  it('refuses a repeated date, an empty list, a list that is too long, and no dates at all', async () => {
    const { app } = await account();
    expect((await preview(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22', '2026-09-22'] })).status).toBe(400);
    expect((await preview(app, { type: 'CASUAL_LEAVE', dates: [] })).status).toBe(400);
    const many = Array.from({ length: 32 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}-x`);
    expect((await preview(app, { type: 'CASUAL_LEAVE', dates: many })).status).toBe(400);
    expect((await preview(app, { type: 'CASUAL_LEAVE' })).status).toBe(400);
    expect((await preview(app, { type: 'CASUAL_LEAVE', dates: ['not-a-date'] })).status).toBe(400);
    expect((await preview(app, { type: 'CASUAL_LEAVE', startDate: '2026-09-25', endDate: '2026-09-22' })).status).toBe(400);
  });

  it('a run of days still works exactly as before, and a next-year date is refused either way', async () => {
    const { app } = await account();
    expect((await preview(app, { type: 'CASUAL_LEAVE', startDate: '2026-09-22', endDate: '2026-09-25' })).body.workingDays).toHaveLength(4);
    expect((await preview(app, { type: 'CASUAL_LEAVE', dates: ['2027-01-05'] })).body.error.code).toBe('LEAVE_TOO_FAR');
    expect((await preview(app, { type: 'CASUAL_LEAVE', startDate: '2026-12-28', endDate: '2027-01-02' })).body.error.code).toBe('LEAVE_TOO_FAR');
    expect((await preview(app, { type: 'CASUAL_LEAVE', startDate: '2026-09-01', endDate: '2026-12-31' })).body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('paid or unpaid is worked out for the chosen days together', async () => {
    const { app } = await account();
    // 15.75 credited by now: take 15 days, then 3 more chosen days go past the balance.
    const days = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 8, 21 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(d).getUTCDay())).slice(0, 15);
    expect((await apply(app, { type: 'CASUAL_LEAVE', dates: days })).body.lop).toBe(0);
    const more = await preview(app, { type: 'CASUAL_LEAVE', dates: ['2026-10-14', '2026-10-15', '2026-10-16'] });
    expect(more.body.lop).toBeGreaterThan(0);
    expect(more.body.warning).toMatch(/unpaid/);
  });
});

describe('bereavement leave does not have to be taken in one block', () => {
  async function withEvent(app: App) {
    const e = await request(app).post('/api/leave/bereavement-events').send({ relation: 'Grandfather', startDate: '2026-09-21' });
    expect(e.status).toBe(201);
    return e.body.id as string;
  }

  it('can be taken on separate days, across several requests and months, up to 5 in total', async () => {
    const { app, id } = await account();
    const eventId = await withEvent(app);
    const take = (dates: string[]) => apply(app, { type: 'BEREAVEMENT_LEAVE', dates, bereavementEventId: eventId });
    expect((await take(['2026-09-22'])).status).toBe(201);
    expect((await take(['2026-09-24', '2026-09-28'])).status).toBe(201); // not next to the first, or to each other
    expect((await take(['2026-10-06', '2026-10-15'])).status).toBe(201); // and in another month
    const days = (await rowsOf(id)).filter((r) => r.status === 'BEREAVEMENT_LEAVE');
    expect(days.map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-09-22', '2026-09-24', '2026-09-28', '2026-10-06', '2026-10-15']);
    const shown = (await leave(app)).bereavement.events[0];
    expect(shown.daysUsed).toBe(5);
    // A sixth day, wherever it falls, is refused.
    const sixth = await take(['2026-10-20']);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('BEREAVEMENT_LIMIT');
    expect((await rowsOf(id)).filter((r) => r.status === 'BEREAVEMENT_LEAVE')).toHaveLength(5);
  });

  it('one request may hold up to the limit, but not more', async () => {
    const { app } = await account();
    const eventId = await withEvent(app);
    const six = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'];
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: six, bereavementEventId: eventId })).body.error.code).toBe('BEREAVEMENT_LIMIT');
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: six.slice(0, 5), bereavementEventId: eventId })).status).toBe(201);
  });

  it('taking fewer than five days is perfectly fine, and the rest stay available for later', async () => {
    const { app } = await account();
    const eventId = await withEvent(app);
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22', '2026-09-30'], bereavementEventId: eventId })).status).toBe(201);
    expect((await leave(app)).bereavement.events[0].daysUsed).toBe(2);
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-10-08'], bereavementEventId: eventId })).status).toBe(201);
  });

  it('moving a day (choosing it again) does not count it twice', async () => {
    const { app } = await account();
    const eventId = await withEvent(app);
    await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'], bereavementEventId: eventId });
    // Re-applying one of the same dates is a replacement, not a sixth day.
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-24'], bereavementEventId: eventId })).status).toBe(201);
    expect((await leave(app)).bereavement.events[0].daysUsed).toBe(5);
  });

  it('two different events each have their own five days', async () => {
    const { app } = await account();
    const a = await withEvent(app);
    const b = (await request(app).post('/api/leave/bereavement-events').send({ relation: 'Uncle', startDate: '2026-10-01' })).body.id;
    await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'], bereavementEventId: a });
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-10-05', '2026-10-06'], bereavementEventId: b })).status).toBe(201);
  });

  it('needs an event, and never touches the yearly leave balance', async () => {
    const { app } = await account();
    const before = (await leave(app)).annual.balance;
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22'] })).body.error.code).toBe('BEREAVEMENT_EVENT_REQUIRED');
    const eventId = await withEvent(app);
    await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22', '2026-09-24'], bereavementEventId: eventId });
    expect((await leave(app)).annual.balance).toBe(before);
  });

  it('a day before the person started counting is not needed (it changes no balance)', async () => {
    const { app, id } = await account();
    const eventId = await withEvent(app);
    const p = await preview(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-07-15', '2026-07-16'], bereavementEventId: eventId });
    expect(p.body.earlierDates).toEqual([]);
    expect(p.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(Array(2).fill('Bereavement days before you started counting do not change any balance'));
    expect((await apply(app, { type: 'BEREAVEMENT_LEAVE', dates: ['2026-07-15'], bereavementEventId: eventId })).body.error.code).toBe('NO_WORKING_DAYS');
    expect(await rowsOf(id)).toHaveLength(0);
  });
});

describe('the first or the second half of a day', () => {
  it.each([['FIRST'], ['SECOND']] as const)('casual leave for the %s half is stored and shown', async (part) => {
    const { app, id } = await account();
    const res = await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22'], half: true, halfPart: part });
    expect(res.status).toBe(201);
    const row = (await rowsOf(id))[0]!;
    expect(Number(row.dayFraction)).toBe(0.5);
    expect(row.halfDayPart).toBe(part);
    const shown = await request(app).get('/api/attendance/2026-09-22');
    expect(shown.body).toMatchObject({ status: 'CASUAL_LEAVE', dayFraction: 0.5, halfDayPart: part });
  });

  it('sick leave and birthday half-days take a half as well', async () => {
    const { app, id } = await account();
    await apply(app, { type: 'SICK_LEAVE', dates: ['2026-09-22'], half: true, halfPart: 'SECOND' });
    await apply(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-23'], halfPart: 'FIRST' });
    const rows = await rowsOf(id);
    expect(rows.map((r) => [r.status, r.halfDayPart])).toEqual([['SICK_LEAVE', 'SECOND'], ['BIRTHDAY_LEAVE', 'FIRST']]);
  });

  it('the message to the manager says which half', async () => {
    const { app } = await account();
    await apply(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-22'], halfPart: 'FIRST' });
    const second = await preview(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-24'], halfPart: 'SECOND' });
    expect(second.body.halfPart).toBe('SECOND');
    expect(second.body.managerMessage).toContain('on 24 Sep 2026 (second half)');
  });

  it('a full day has no half, and a half cannot be chosen for a full day', async () => {
    const { app, id } = await account();
    expect((await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22'], halfPart: 'FIRST' })).status).toBe(400); // half not ticked
    expect((await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22'] })).status).toBe(201);
    expect((await rowsOf(id))[0]!.halfDayPart).toBeNull();
    expect((await apply(app, { type: 'OPTIONAL_HOLIDAY', dates: ['2026-09-23'], halfPart: 'FIRST' })).status).toBe(400);
  });

  it('a half day is one date only', async () => {
    const { app } = await account();
    expect((await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22', '2026-09-23'], half: true, halfPart: 'FIRST' })).status).toBe(400);
    expect((await apply(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-22', '2026-09-23'], halfPart: 'FIRST' })).status).toBe(400);
  });

  it('half days still need only the half-day hours, whichever half is taken', async () => {
    const { app } = await account();
    for (const part of ['FIRST', 'SECOND'] as const) {
      await apply(app, { type: 'CASUAL_LEAVE', dates: [part === 'FIRST' ? '2026-09-22' : '2026-09-24'], half: true, halfPart: part });
    }
    for (const d of ['2026-09-22', '2026-09-24']) expect((await request(app).get(`/api/attendance/${d}`)).body.day.requiredMinutes).toBe(240);
  });

  it('can be set, changed and cleared from the day screen', async () => {
    const { app, id } = await account();
    const put = (body: object) => request(app).put('/api/attendance/2026-09-22').send(body);
    expect((await put({ status: 'CASUAL_LEAVE', dayFraction: 0.5, halfDayPart: 'FIRST' })).body.halfDayPart).toBe('FIRST');
    expect((await put({ status: 'CASUAL_LEAVE', dayFraction: 0.5, halfDayPart: 'SECOND' })).body.halfDayPart).toBe('SECOND');
    expect((await put({ status: 'CASUAL_LEAVE', dayFraction: 0.5 })).body.halfDayPart).toBeNull(); // not chosen (allowed for older records)
    const bad = await put({ status: 'CASUAL_LEAVE', dayFraction: 1, halfDayPart: 'FIRST' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('HALF_PART_NOT_ALLOWED');
    await put({ status: 'CASUAL_LEAVE', dayFraction: 0.5, halfDayPart: 'FIRST' });
    await put({ status: 'WORKING', dayFraction: 1 }); // back to a normal day: the half is cleared
    expect((await rowsOf(id))[0]!.halfDayPart).toBeNull();
    expect((await put({ status: 'BIRTHDAY_LEAVE', dayFraction: 1, halfDayPart: 'SECOND' })).body.halfDayPart).toBe('SECOND'); // always a half day
  });

  it('the database refuses a half chosen on a full day', async () => {
    const { id } = await account();
    await expect(
      prisma.attendance.create({ data: { userId: id, date: new Date('2026-09-22T00:00:00Z'), status: 'CASUAL_LEAVE', dayFraction: 1, halfDayPart: 'FIRST' } }),
    ).rejects.toThrow(/attendance_half_part_only_on_half_days/);
  });

  it('survives a backup and restore, and an older backup without it still restores', async () => {
    const { app } = await account();
    await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-22'], half: true, halfPart: 'SECOND' });
    const backup = (await request(app).get('/api/backup')).body;
    expect(backup.data.attendance[0]).toMatchObject({ dayFraction: 0.5, halfDayPart: 'SECOND' });

    const other = await account();
    expect((await request(other.app).post('/api/backup/restore').send({ confirm: 'REPLACE', backup })).status).toBe(200);
    expect((await request(other.app).get('/api/attendance/2026-09-22')).body.halfDayPart).toBe('SECOND');

    const old = JSON.parse(JSON.stringify(backup));
    for (const a of old.data.attendance) delete a.halfDayPart;
    old.checksum = checksumOf(old.data);
    const third = await account();
    expect((await request(third.app).post('/api/backup/restore').send({ confirm: 'REPLACE', backup: old })).status).toBe(200);
    expect((await request(third.app).get('/api/attendance/2026-09-22')).body).toMatchObject({ dayFraction: 0.5, halfDayPart: null });

    const forged = JSON.parse(JSON.stringify(backup));
    forged.data.attendance[0].dayFraction = 1;
    forged.checksum = checksumOf(forged.data);
    const refused = await request(app).post('/api/backup/validate').send(forged);
    expect(refused.status).toBe(400);
  });
});

describe('leave from earlier in the year (before the person started counting)', () => {
  const EARLY = ['2026-09-14', '2026-09-15']; // Monday and Tuesday, a week before counting began on 21 Sep

  it('is recorded as earlier leave: no day record is made, but the balance goes down', async () => {
    const { app, id } = await account();
    const before = await leave(app);
    const p = await preview(app, { type: 'SICK_LEAVE', dates: EARLY });
    expect(p.body).toMatchObject({ workingDays: [], earlierDates: EARLY, totalDays: 2, paid: 2, lop: 0 });
    expect(p.body.summary).toContain('2 date(s) fall before you started counting');

    const res = await apply(app, { type: 'SICK_LEAVE', dates: EARLY });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applied: [], earlier: EARLY });
    expect(await rowsOf(id)).toHaveLength(0);

    const after = await leave(app);
    expect(after.annual.balance).toBe(before.annual.balance - 2);
    expect(after.annual.usedThisYear).toBe(before.annual.usedThisYear + 2);
    expect(after.earlier).toHaveLength(2);
    expect(after.earlier[0]).toMatchObject({ date: '2026-09-15', pool: 'ANNUAL', days: 1 });
    expect(after.earlier.map((e: { note: string }) => e.note)).toContain('Earlier leave: Sick leave on 14 Sep 2026');
  });

  it('cannot be added twice for the same day (no double deduction)', async () => {
    const { app } = await account();
    await apply(app, { type: 'SICK_LEAVE', dates: EARLY });
    const bal = (await leave(app)).annual.balance;
    const again = await preview(app, { type: 'SICK_LEAVE', dates: EARLY });
    expect(again.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(Array(2).fill('Already added as earlier leave'));
    expect((await apply(app, { type: 'SICK_LEAVE', dates: EARLY })).body.error.code).toBe('NO_WORKING_DAYS');
    expect((await leave(app)).annual.balance).toBe(bal);
  });

  it('can be removed again, restoring the balance', async () => {
    const { app } = await account();
    const start = (await leave(app)).annual.balance;
    await apply(app, { type: 'CASUAL_LEAVE', dates: EARLY });
    const list = (await leave(app)).earlier;
    expect((await request(app).delete(`/api/leave/earlier/${list[0].id}`)).status).toBe(204);
    expect((await leave(app)).annual.balance).toBe(start - 1);
    expect((await request(app).delete(`/api/leave/earlier/${list[1].id}`)).status).toBe(204);
    expect((await leave(app)).annual.balance).toBe(start);
    expect((await leave(app)).earlier).toEqual([]);
    expect((await request(app).delete(`/api/leave/earlier/${list[1].id}`)).status).toBe(404); // already gone
  });

  it('only entries added this way can be removed, and only your own', async () => {
    const a = await account();
    const b = await account();
    await apply(a.app, { type: 'CASUAL_LEAVE', dates: ['2026-09-14'] });
    const mine = (await leave(a.app)).earlier[0];
    expect((await request(b.app).delete(`/api/leave/earlier/${mine.id}`)).status).toBe(404); // someone else's
    expect((await leave(a.app)).earlier).toHaveLength(1);
    const setupRow = await prisma.leaveLedgerEntry.findFirstOrThrow({ where: { userId: a.id, type: 'ACCRUAL' } });
    expect((await request(a.app).delete(`/api/leave/earlier/${setupRow.id}`)).status).toBe(404); // a credit, not earlier leave
    expect((await request(a.app).delete('/api/leave/earlier/not-a-uuid')).status).toBe(400);
    expect((await leave(b.app)).earlier).toEqual([]);
  });

  it('works for optional holidays and birthday half-days too, from the right allowance', async () => {
    const { app } = await account();
    const before = await leave(app);
    await apply(app, { type: 'OPTIONAL_HOLIDAY', dates: ['2026-09-14'] });
    await apply(app, { type: 'BIRTHDAY_LEAVE', dates: ['2026-09-15'], halfPart: 'SECOND' });
    const after = await leave(app);
    expect(after.optional.remaining).toBe(before.optional.remaining - 1);
    expect(after.birthday.remaining).toBe(before.birthday.remaining - 0.5);
    expect(after.annual.balance).toBe(before.annual.balance); // the yearly leave is untouched
    const notes = after.earlier.map((e: { note: string }) => e.note);
    expect(notes).toContain('Earlier leave: Birthday half-day on 15 Sep 2026 (second half)');
    expect(notes).toContain('Earlier leave: Optional holiday on 14 Sep 2026');
  });

  it('a half day of casual leave from earlier takes half a day', async () => {
    const { app } = await account();
    const before = (await leave(app)).annual.balance;
    await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-14'], half: true, halfPart: 'FIRST' });
    expect((await leave(app)).annual.balance).toBe(before - 0.5);
  });

  it('a run that crosses the start date is split: earlier days are recorded, later days are normal leave', async () => {
    const { app, id } = await account();
    const p = await preview(app, { type: 'CASUAL_LEAVE', startDate: '2026-09-18', endDate: '2026-09-22' });
    expect(p.body.earlierDates).toEqual(['2026-09-18']);
    expect(p.body.workingDays).toEqual(['2026-09-21', '2026-09-22']);
    expect(p.body.skipped).toEqual([
      { date: '2026-09-19', reason: 'Weekly off' },
      { date: '2026-09-20', reason: 'Weekly off' },
    ]);
    expect(p.body.totalDays).toBe(3);
    await apply(app, { type: 'CASUAL_LEAVE', startDate: '2026-09-18', endDate: '2026-09-22' });
    expect((await rowsOf(id)).map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-09-21', '2026-09-22']);
    expect((await leave(app)).earlier).toHaveLength(1);
  });

  it('skips company holidays and days off, and dates in earlier years or still to come', async () => {
    const { app } = await account('2026-09-22', '2026-09-19');
    await request(app).post('/api/holidays').send({ date: '2026-09-15', name: 'Company day', type: 'COMPANY' });
    const p = await preview(app, { type: 'SICK_LEAVE', dates: ['2025-12-01', '2026-09-15', '2026-09-13', '2026-09-21'] });
    expect(p.body.earlierDates).toEqual([]);
    expect(p.body.skipped).toEqual([
      { date: '2025-12-01', reason: 'Only earlier dates in the current year can be added' },
      { date: '2026-09-13', reason: 'Weekly off' },
      { date: '2026-09-15', reason: 'Company holiday' },
      { date: '2026-09-21', reason: 'Before your start date' }, // still in the future: today is 19 Sep
    ]);
  });

  it('the yearly leave balance stays right when leave is added after the fact (no negative surprise)', async () => {
    const { app } = await account();
    const first = (await leave(app)).annual;
    await apply(app, { type: 'SICK_LEAVE', dates: EARLY });
    const second = (await leave(app)).annual;
    expect(second.accruedThisYear).toBe(first.accruedThisYear); // credits are unchanged
    expect(second.balance).toBe(round(first.balance - 2));
    expect((await leave(app)).lopByMonth).toEqual({});
  });

  it('survives a backup and restore', async () => {
    const { app } = await account();
    await apply(app, { type: 'SICK_LEAVE', dates: EARLY });
    const backup = (await request(app).get('/api/backup')).body;
    const other = await account();
    expect((await request(other.app).post('/api/backup/restore').send({ confirm: 'REPLACE', backup })).status).toBe(200);
    const restored = await leave(other.app);
    expect(restored.earlier).toHaveLength(2);
    expect(restored.annual.balance).toBe((await leave(app)).annual.balance);
  });
});

describe('leave forgotten for a recent day (after the person started counting)', () => {
  it('a past date since the start is normal leave with a day record, and can be changed on the day screen', async () => {
    const { app, id } = await account('2026-09-21', '2026-09-25');
    expect((await apply(app, { type: 'SICK_LEAVE', dates: ['2026-09-22'] })).body).toMatchObject({ applied: ['2026-09-22'], earlier: [] });
    const row = (await rowsOf(id))[0]!;
    expect(row.status).toBe('SICK_LEAVE');
    expect((await request(app).put('/api/attendance/2026-09-22').send({ status: 'CASUAL_LEAVE' })).status).toBe(200);
    expect((await leave(app)).earlier).toEqual([]);
  });

  it('a leave day with work on it still needs the hours worked', async () => {
    const { app } = await account('2026-09-21', '2026-09-25');
    await apply(app, { type: 'CASUAL_LEAVE', dates: ['2026-09-23'], half: true, halfPart: 'FIRST' });
    const d = await request(app).get('/api/attendance/2026-09-23');
    expect(d.body.day).toMatchObject({ requiredMinutes: 240, isUnrecorded: false });
  });
});

const round = (n: number) => Math.round(n * 100) / 100;
void day;
