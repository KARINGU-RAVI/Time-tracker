import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { checksumOf, type Backup, type BackupData } from '../src/services/backup';
import { parseCsv } from '../src/routes/holidays';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const at = (date: string, hhmm: string) => istInstant(date, hhmm);
const emails: string[] = [];
let seq = 0;

type App = ReturnType<typeof createApp>;

async function setup() {
  const email = `backup-${Date.now()}-${process.pid}-${++seq}@example.test`;
  emails.push(email);
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  const clock = { now: at('2026-09-21', '10:00') };
  const app = createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  return { app, email };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const session = (app: App, date: string, inn: string, out: string, outDate = date) =>
  request(app).post(`/api/attendance/${date}/sessions`).send({ inTime: `${date}T${inn}`, outTime: `${outDate}T${out}` });

/** A user with every kind of data: two rule versions, holidays, sessions, midnight shift, leave, WFH, half day, bereavement, notes. */
async function richUser() {
  const u = await setup();
  const a = u.app;
  await request(a).post('/api/rules').send({ dailyRequiredMinutes: 450, weeklyRequiredMinutes: 2250, halfDayRequiredMinutes: 225, workingDays: [1, 2, 3, 4, 5], effectiveFrom: '2026-09-17' });
  await request(a).post('/api/holidays').send({ date: '2026-09-07', name: 'Company holiday' });
  await request(a).post('/api/holidays').send({ date: '2026-09-21', name: 'Optional day', type: 'OPTIONAL' });
  await session(a, '2026-09-14', '08:00', '16:10');
  await session(a, '2026-09-15', '08:00', '12:00');
  await session(a, '2026-09-15', '13:00', '16:00');
  await session(a, '2026-09-16', '22:00', '02:00', '2026-09-17'); // midnight-crossing shift
  await session(a, '2026-09-17', '08:05', '12:35').then(() => undefined);
  await request(a).put('/api/attendance/2026-09-10').send({ status: 'WFH', notes: 'Home, "quiet" day' });
  await request(a).put('/api/attendance/2026-09-11').send({ status: 'SICK_LEAVE', dayFraction: 0.5, managerInformed: true });
  await request(a).post('/api/leave/apply').send({ type: 'CASUAL_LEAVE', startDate: '2026-09-22', endDate: '2026-09-23' });
  await request(a).post('/api/leave/apply').send({ type: 'OPTIONAL_HOLIDAY', startDate: '2026-09-21', endDate: '2026-09-21' });
  const ev = (await request(a).post('/api/leave/bereavement-events').send({ relation: 'Family member', startDate: '2026-09-24', note: 'note' })).body.id as string;
  await request(a).put('/api/attendance/2026-09-24').send({ status: 'BEREAVEMENT_LEAVE', bereavementEventId: ev });
  await request(a).put('/api/attendance/2026-09-25').send({ status: 'BEREAVEMENT_LEAVE', bereavementEventId: ev });
  return u;
}

const download = async (app: App): Promise<Backup> => JSON.parse((await request(app).get('/api/backup')).text) as Backup;

/** Signs modified data so it carries a VALID checksum: the file is internally consistent, only its content is bad. */
const sign = (b: Backup, mutate: (d: BackupData) => void): Backup => {
  const data = structuredClone(b.data);
  mutate(data);
  return { ...b, data, checksum: checksumOf(data) };
};

/** Ids differ after a restore (new UUIDs), so compare with event ids replaced by their position. */
function normalise(data: BackupData) {
  const idx = new Map(data.bereavementEvents.map((e, i) => [e.id, `event-${i}`]));
  return {
    ...data,
    bereavementEvents: data.bereavementEvents.map((e) => ({ ...e, id: idx.get(e.id) })),
    attendance: data.attendance.map((a) => ({ ...a, bereavementEventId: a.bereavementEventId ? idx.get(a.bereavementEventId) : null })),
    ledger: [...data.ledger].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  };
}

const restore = (app: App, backup: unknown, confirm: unknown = 'REPLACE') => request(app).post('/api/backup/restore').send({ confirm, backup });

describe('exporting a backup', () => {
  it('produces a portable, checksummed file with everything and nothing personal', async () => {
    const { app, email } = await richUser();
    const res = await request(app).get('/api/backup');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="office-hours-backup-2026-09-21.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    const b = JSON.parse(res.text) as Backup;
    expect(b).toMatchObject({ app: 'office-hours-tracker', version: 1, exportedAt: new Date(at('2026-09-21', '10:00')).toISOString() });
    expect(b.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(b.checksum).toBe(checksumOf(b.data));

    expect(b.data.workRules).toHaveLength(2);
    expect(b.data.holidays.map((h) => h.date)).toEqual(['2026-09-07', '2026-09-21']);
    expect(b.data.bereavementEvents).toHaveLength(1);
    expect(b.data.ledger.length).toBeGreaterThan(10);
    const day15 = b.data.attendance.find((a) => a.date === '2026-09-15')!;
    expect(day15.sessions).toHaveLength(2);
    expect(b.data.attendance.find((a) => a.date === '2026-09-10')!.notes).toBe('Home, "quiet" day');
    expect(b.data.attendance.find((a) => a.date === '2026-09-11')).toMatchObject({ status: 'SICK_LEAVE', dayFraction: 0.5, managerInformed: true });

    // No identity: neither the email nor a user id is in the file.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(res.text).not.toContain(email);
    expect(res.text).not.toContain(user.id);
  });

  it('is canonical: the same data gives the same file whatever order rows were stored in', async () => {
    const [x, y] = [await setup(), await setup()];
    const users = await prisma.user.findMany({ where: { email: { in: [x.email, y.email] } } });
    const idOf = (email: string) => users.find((u) => u.email === email)!.id;
    const row = (userId: string, days: number, note: string) => ({ userId, pool: 'ANNUAL' as const, type: 'ADJUSTMENT' as const, days, effectiveDate: new Date('2026-09-19T00:00:00Z'), leaveYear: 2026, note });
    const notes = [['a', -1], ['b', -1], ['c', 2], ['d', -0.5]] as const;
    await prisma.leaveLedgerEntry.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    // Same rows, same date, inserted in opposite orders.
    await prisma.leaveLedgerEntry.createMany({ data: notes.map(([n, d]) => row(idOf(x.email), d, n)) });
    await prisma.leaveLedgerEntry.createMany({ data: [...notes].reverse().map(([n, d]) => row(idOf(y.email), d, n)) });
    const [bx, by] = [await download(x.app), await download(y.app)];
    expect(bx.data.ledger).toEqual(by.data.ledger);
    expect(bx.checksum).toBe(by.checksum);
  });

  it('is repeatable: the same data always gives the same checksum', async () => {
    const { app } = await richUser();
    const [a, b] = [await download(app), await download(app)];
    expect(a.checksum).toBe(b.checksum);
  });
});

describe('restoring a backup', () => {
  it('reproduces everything exactly in another account (full round trip)', async () => {
    const source = await richUser();
    const backup = await download(source.app);

    const target = await setup(); // has different, seeded data
    const res = await restore(target.app, backup);
    expect(res.status).toBe(200);
    expect(res.body.restored.attendanceDays).toBe(backup.data.attendance.length);
    expect(res.body.restored.sessions).toBe(backup.data.attendance.reduce((n, a) => n + a.sessions.length, 0));

    const restored = await download(target.app);
    expect(normalise(restored.data)).toEqual(normalise(backup.data));

    // Derived numbers match too, which is what actually matters.
    for (const path of ['/api/summary/week?date=2026-09-16', '/api/summary/month?year=2026&month=9', '/api/attendance?startDate=2026-09-01&endDate=2026-09-30']) {
      expect((await request(target.app).get(path)).body).toEqual((await request(source.app).get(path)).body);
    }
    const [leaveA, leaveB] = [(await request(source.app).get('/api/leave')).body, (await request(target.app).get('/api/leave')).body];
    expect(leaveB.annual).toEqual(leaveA.annual);
    expect(leaveB.optional).toEqual(leaveA.optional);
    expect(leaveB.lopByMonth).toEqual(leaveA.lopByMonth);
  });

  it('puts an account back exactly as it was after later changes', async () => {
    const { app } = await richUser();
    const before = await download(app);
    await session(app, '2026-09-18', '09:00', '17:00');
    await request(app).delete('/api/attendance/2026-09-10');
    expect((await download(app)).checksum).not.toBe(before.checksum);

    expect((await restore(app, before)).status).toBe(200);
    expect(normalise((await download(app)).data)).toEqual(normalise(before.data));
  });

  it('never touches another user', async () => {
    const a = await richUser();
    const b = await setup();
    await session(b.app, '2026-09-18', '09:00', '17:00');
    const bBefore = await download(b.app);
    await restore(a.app, await download(a.app));
    expect((await download(b.app)).checksum).toBe(bBefore.checksum);
  });

  it('is written to the audit log', async () => {
    const { app, email } = await richUser();
    await restore(app, await download(app));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await prisma.auditLog.count({ where: { userId: user.id, entity: 'Backup', action: 'RESTORE' } })).toBe(1);
  });

  it('refuses without the explicit confirmation word, and changes nothing', async () => {
    const { app } = await richUser();
    const backup = await download(app);
    await session(app, '2026-09-18', '09:00', '17:00');
    const changed = (await download(app)).checksum;

    for (const confirm of [null, 'yes', 'replace', true, '']) {
      const res = await restore(app, backup, confirm);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    }
    const omitted = await request(app).post('/api/backup/restore').send({ backup });
    expect(omitted.status).toBe(400);
    expect(omitted.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await download(app)).checksum).toBe(changed);
  });
});

describe('validating before restoring', () => {
  it('reports what the file holds and what would be lost, without saving anything', async () => {
    const { app } = await richUser();
    const backup = await download(app);
    await session(app, '2026-09-18', '09:00', '17:00'); // a day the backup does not have
    const before = (await download(app)).checksum;

    const res = await request(app).post('/api/backup/validate').send(backup);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, daysThatWouldBeLost: 1 });
    expect(res.body.backup.attendanceDays).toBe(backup.data.attendance.length);
    expect(res.body.current.attendanceDays).toBe(backup.data.attendance.length + 1);
    expect((await download(app)).checksum).toBe(before);
  });
});

describe('refusing bad files (nothing is changed)', () => {
  async function expectRefused(app: App, bad: unknown, message: RegExp) {
    const before = (await download(app)).checksum;
    for (const call of [() => request(app).post('/api/backup/validate').send(bad as object), () => restore(app, bad)]) {
      const res = await call();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_BACKUP');
      expect(res.body.error.message).toMatch(message);
    }
    expect((await download(app)).checksum).toBe(before);
  }

  it('a file that is not a backup, or the wrong version', async () => {
    const { app } = await richUser();
    const good = await download(app);
    await expectRefused(app, { hello: 'world' }, /not an Office Hours backup/);
    await expectRefused(app, [], /not an Office Hours backup/);
    await expectRefused(app, { ...good, version: 2 }, /version 2/);
  });

  it('a damaged or incomplete file', async () => {
    const { app } = await richUser();
    const good = await download(app);
    await expectRefused(app, { ...good, data: { ...good.data, attendance: 'nope' } }, /damaged or incomplete/);
    await expectRefused(app, { ...good, checksum: 'abc' }, /damaged or incomplete/);
    const { checksum: _c, ...noChecksum } = good;
    await expectRefused(app, noChecksum, /damaged or incomplete/);
    await expectRefused(app, { ...good, data: { ...good.data, extra: 1 } }, /damaged or incomplete/);
  });

  it('a file that was edited by hand (checksum mismatch)', async () => {
    const { app } = await richUser();
    const good = await download(app);
    const edited = structuredClone(good);
    edited.data.attendance[0]!.notes = 'I changed this';
    await expectRefused(app, edited, /checksum does not match/);
  });

  it('a truncated file', async () => {
    const { app } = await richUser();
    const good = await download(app);
    const res = await request(app).post('/api/backup/validate').set('Content-Type', 'application/json').send(JSON.stringify(good).slice(0, 500));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('consistent files whose content breaks the rules', async () => {
    const { app } = await richUser();
    const good = await download(app);
    const D = '2026-09-15';
    const dayOf = (d: BackupData, date = D) => d.attendance.find((a) => a.date === date)!;

    const cases: Array<[string, (d: BackupData) => void, RegExp]> = [
      ['duplicate day', (d) => { d.attendance.push({ ...d.attendance[0]! }); }, /more than once/],
      ['duplicate holiday', (d) => { d.holidays.push({ ...d.holidays[0]! }); }, /holiday .* more than once/],
      ['overlapping sessions', (d) => { dayOf(d).sessions[1]!.inTime = dayOf(d).sessions[0]!.inTime; }, /overlaps|OUT must be after IN/],
      ['zero-length session', (d) => { dayOf(d).sessions[0]!.outTime = dayOf(d).sessions[0]!.inTime; }, /OUT must be after IN/],
      ['IN on the wrong date', (d) => { dayOf(d).sessions[0]!.inTime = '2026-09-16T03:00:00.000Z'; }, /must fall on the selected date|overlaps/],
      ['bereavement without an event', (d) => { d.attendance.find((a) => a.status === 'BEREAVEMENT_LEAVE')!.bereavementEventId = null; }, /bereavement days must be linked/],
      ['bereavement with a missing event', (d) => { d.attendance.find((a) => a.status === 'BEREAVEMENT_LEAVE')!.bereavementEventId = 'missing'; }, /not in the file/],
      ['half day on WFH', (d) => { dayOf(d, '2026-09-10').dayFraction = 0.5; }, /only casual or sick leave can be a half day/],
      ['overlapping rules', (d) => { d.workRules[0]!.effectiveTo = null; }, /cover the same dates/],
      ['half day longer than a day', (d) => { d.workRules[0]!.halfDayRequiredMinutes = 9999; }, /damaged or incomplete|half day longer/],
      ['leave year out of range', (d) => { d.ledger[0]!.leaveYear = 1999; }, /damaged or incomplete/],
      ['leave year mismatch', (d) => { d.ledger[0]!.leaveYear = 2030; }, /wrong leave year/],
      ['two unclosed sessions', (d) => { d.attendance.push({ date: '2026-12-01', status: 'WORKING', dayFraction: 1, notes: null, managerInformed: false, bereavementEventId: null, sessions: [{ inTime: '2026-11-30T20:00:00.000Z', outTime: null }] }); d.attendance.push({ date: '2026-12-02', status: 'WORKING', dayFraction: 1, notes: null, managerInformed: false, bereavementEventId: null, sessions: [{ inTime: '2026-12-01T20:00:00.000Z', outTime: null }] }); }, /more than one unclosed/],
    ];
    for (const [label, mutate, message] of cases) {
      const before = (await download(app)).checksum;
      const bad = sign(good, mutate);
      for (const [via, call] of [
        ['validate', () => request(app).post('/api/backup/validate').send(bad)],
        ['restore', () => restore(app, bad)],
      ] as const) {
        const res = await call();
        expect(res.status, `${label} via ${via}: status`).toBe(400);
        expect(res.body.error.code, `${label} via ${via}: code`).toBe('INVALID_BACKUP');
        expect(res.body.error.message, `${label} via ${via}: message`).toMatch(message);
      }
      expect((await download(app)).checksum, `${label}: data must be unchanged`).toBe(before);
    }
  });

  it('a file that looks fine but conflicts across days is rolled back completely', async () => {
    const { app } = await richUser();
    const good = await download(app);
    const before = (await download(app)).checksum;
    // A shift that runs past midnight into a day that also has a session: valid per day, impossible together.
    const bad = sign(good, (d) => {
      d.attendance.push(
        { date: '2026-10-05', status: 'WORKING', dayFraction: 1, notes: null, managerInformed: false, bereavementEventId: null, sessions: [{ inTime: '2026-10-05T16:30:00.000Z', outTime: '2026-10-06T02:30:00.000Z' }] },
        { date: '2026-10-06', status: 'WORKING', dayFraction: 1, notes: null, managerInformed: false, bereavementEventId: null, sessions: [{ inTime: '2026-10-06T01:00:00.000Z', outTime: '2026-10-06T05:00:00.000Z' }] },
      );
    });
    const res = await restore(app, bad);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/overlap each other across days.*Nothing was restored/);
    expect((await download(app)).checksum).toBe(before); // the transaction rolled back
  });
});

describe('access and size limits', () => {
  it('needs sign-in for every backup endpoint, before reading any upload', async () => {
    const anon = createApp({ prisma, clock: () => Date.now(), authenticate: async () => null });
    expect((await request(anon).get('/api/backup')).status).toBe(401);
    expect((await request(anon).get('/api/export/csv?startDate=2026-09-01&endDate=2026-09-30')).status).toBe(401);
    // A 5 MB body would be accepted if it were read. The server must answer 401 WITHOUT reading it, so the
    // client either gets the 401 or sees the connection close while still uploading. Both are correct.
    const big = { pad: 'x'.repeat(5 * 1024 * 1024) };
    for (const path of ['/api/backup/validate', '/api/backup/restore']) {
      const outcome = await request(anon).post(path).send(big).then(
        (r) => r.status,
        (e: NodeJS.ErrnoException) => e.code,
      );
      expect([401, 'ECONNRESET', 'EPIPE']).toContain(outcome);
    }
    // And a small unauthenticated request gets the proper 401.
    expect((await request(anon).post('/api/backup/restore').send({ confirm: 'REPLACE', backup: {} })).status).toBe(401);
  });

  it('refuses an upload over 6 MB with a clear message', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/backup/validate').send({ pad: 'x'.repeat(7 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('restores years of data fast enough for a 10-second serverless limit', async () => {
    const { app } = await setup();
    const good = await download(app);
    const big = sign(good, (d) => {
      d.attendance = [];
      for (let i = 0; i < 1500; i++) {
        const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
        const day = (h: number, m: number) => new Date(istInstant(date, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)).toISOString();
        d.attendance.push({ date, status: 'WORKING', dayFraction: 1, notes: null, managerInformed: false, bereavementEventId: null, sessions: [{ inTime: day(8, 0), outTime: day(12, 0) }, { inTime: day(13, 0), outTime: day(17, 0) }] });
      }
    });
    const started = Date.now();
    const res = await restore(app, big);
    const seconds = (Date.now() - started) / 1000;
    expect(res.status).toBe(200);
    expect(res.body.restored).toMatchObject({ attendanceDays: 1500, sessions: 3000 });
    expect(seconds).toBeLessThan(10);
  });
});

describe('CSV report', () => {
  async function week() {
    const u = await setup();
    const a = u.app;
    await session(a, '2026-09-14', '08:00', '16:10');
    await session(a, '2026-09-15', '08:00', '16:00');
    await request(a).put('/api/attendance/2026-09-16').send({ status: 'CASUAL_LEAVE', notes: '=HYPERLINK("http://evil.example","click")' });
    await session(a, '2026-09-17', '08:05', '12:35');
    await session(a, '2026-09-17', '13:20', '16:10');
    await request(a).post('/api/attendance/2026-09-18/sessions').send({ inTime: '2026-09-18T08:00', outTime: '2026-09-18T14:50' });
    return u;
  }
  const HEADER = 'Date,Weekday,Status,First IN,Last OUT,Worked (min),Worked,Required (min),Required,Balance (min),Balance,Overtime (min),Notes';

  it('has one row per day with worked, required and balance', async () => {
    const { app } = await week();
    const res = await request(app).get('/api/export/csv?startDate=2026-09-14&endDate=2026-09-20');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="office-hours-daily-2026-09-14_to_2026-09-20.csv"');
    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text).toContain('\r\n');
    const rows = parseCsv(res.text);
    expect(rows[0]!.join(',')).toBe(HEADER);
    expect(rows).toHaveLength(8); // header + 7 days
    expect(rows[1]).toEqual(['2026-09-14', 'Mon', 'Working', '08:00', '16:10', '490', '8h 10m', '480', '8h 00m', '10', '+10m', '10', '']);
    expect(rows[4]).toEqual(['2026-09-17', 'Thu', 'Working', '08:05', '16:10', '440', '7h 20m', '480', '8h 00m', '-40', '-40m', '0', '']);
    expect(rows[6]?.slice(0, 3)).toEqual(['2026-09-19', 'Sat', 'Weekly off']);
    expect(rows[6]?.slice(7, 11)).toEqual(['0', '0m', '', '']); // no balance on a day off
  });

  it('leaves a leave day without a balance and never shows a negative balance with a stray quote', async () => {
    const { app } = await week();
    const rows = parseCsv((await request(app).get('/api/export/csv?startDate=2026-09-16&endDate=2026-09-16')).text);
    expect(rows[1]?.slice(0, 3)).toEqual(['2026-09-16', 'Wed', 'Casual leave']);
    expect(rows[1]?.slice(9, 11)).toEqual(['', '']);
    const thu = parseCsv((await request(app).get('/api/export/csv?startDate=2026-09-17&endDate=2026-09-17')).text);
    expect(thu[1]?.[10]).toBe('-40m'); // durations such as -40m are NOT treated as formulas
  });

  it('defuses spreadsheet formulas typed into notes', async () => {
    const { app } = await week();
    const res = await request(app).get('/api/export/csv?startDate=2026-09-16&endDate=2026-09-16');
    const notes = parseCsv(res.text)[1]!.at(-1)!;
    expect(notes.startsWith("'=HYPERLINK")).toBe(true);
    expect(notes).not.toMatch(/^=/);
  });

  it('quotes notes that contain commas, quotes and line breaks', async () => {
    const { app } = await setup();
    await request(app).put('/api/attendance/2026-09-10').send({ status: 'WFH', notes: 'a, "b"\nc' });
    const rows = parseCsv((await request(app).get('/api/export/csv?startDate=2026-09-10&endDate=2026-09-10')).text);
    expect(rows[1]!.at(-1)).toBe('a, "b"\nc');
  });

  it('lists sessions when asked', async () => {
    const { app } = await week();
    const res = await request(app).get('/api/export/csv?startDate=2026-09-14&endDate=2026-09-18&type=sessions');
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(['Date', 'IN', 'OUT', 'Minutes']);
    expect(rows).toContainEqual(['2026-09-17', '13:20', '16:10', '170']);
    expect(rows).toHaveLength(1 + 5); // one session on 14, 15, 18 and two on 17
  });

  it('skips days before tracking started, flags gaps, and only exports your own data', async () => {
    const a = await week();
    const b = await setup();
    const early = parseCsv((await request(a.app).get('/api/export/csv?startDate=2026-08-25&endDate=2026-09-02')).text);
    expect(early.slice(1).map((r) => r[0])).toEqual(['2026-09-01', '2026-09-02']);
    expect(early[1]?.[2]).toBe('No record');

    const other = parseCsv((await request(b.app).get('/api/export/csv?startDate=2026-09-14&endDate=2026-09-14')).text);
    expect(other[1]?.[2]).toBe('No record');
    expect(other[1]?.[5]).toBe('0');
  });

  it('rejects bad ranges', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/export/csv?startDate=2026-09-10&endDate=2026-09-01')).body.error.code).toBe('INVALID_RANGE');
    expect((await request(app).get('/api/export/csv?startDate=2025-01-01&endDate=2026-12-31')).body.error.code).toBe('RANGE_TOO_LARGE');
    expect((await request(app).get('/api/export/csv?startDate=2026-09-01')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get('/api/export/csv?startDate=2026-09-01&endDate=2026-09-02&type=xml')).status).toBe(400);
  });
});
