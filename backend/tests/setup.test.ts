import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { nextMonday, planSetup, setupSchema, type SetupInput } from '../src/services/setup';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const TODAY = '2026-09-19'; // a Saturday, the day of the owner's opening position
const NOW = istInstant(TODAY, '10:00');
const emails: string[] = [];
let seq = 0;

/** The wizard answers that reproduce the owner's own position: 2 carried, 5 used, 1 optional used, from 21 Sep. */
function ownerAnswers(over: Partial<SetupInput['leave']> = {}, work: Partial<SetupInput['work']> = {}): SetupInput {
  return {
    profile: { name: 'Test Person', employeeId: 'E-1', designation: 'Engineer' },
    work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-21', ...work },
    leave: {
      annualEntitlement: 21,
      accrualPerMonth: 1.75,
      carryForwardCap: 3,
      optionalQuota: 2,
      bereavementDaysPerEvent: 5,
      carriedForward: 2,
      annualUsedSoFar: 5,
      optionalUsedSoFar: 1,
      creditsFromMonth: 1,
      ...over,
    },
    holidays: { source: 'none' },
  };
}

/** A new account that has signed in but not finished setup. */
async function newcomer() {
  const email = `setup-${RUN}-${++seq}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  const app = createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) });
  return { app, email, id: user.id };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const complete = (app: ReturnType<typeof createApp>, body: object) => request(app).post('/api/setup/complete').send({ ...body, acknowledged: true });

describe('the setup gate', () => {
  it('locks every app route until setup is finished, but leaves the wizard and health open', async () => {
    const { app } = await newcomer();
    for (const path of ['/api/dashboard', '/api/attendance/today', '/api/leave', '/api/holidays', '/api/rules', '/api/backup/export']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe('SETUP_REQUIRED');
    }
    for (const path of ['/api/attendance/check-in', '/api/backup/restore']) {
      expect((await request(app).post(path).send({})).body.error.code, path).toBe('SETUP_REQUIRED');
    }
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/setup/defaults')).status).toBe(200);
  });

  it('opens everything once setup is complete', async () => {
    const { app } = await newcomer();
    expect((await complete(app, ownerAnswers())).status).toBe(201);
    for (const path of ['/api/dashboard', '/api/attendance/today', '/api/leave', '/api/holidays']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
  });
});

describe('defaults', () => {
  it('pre-fills the company rules and suggests the next Monday', async () => {
    const { app } = await newcomer();
    const res = await request(app).get('/api/setup/defaults');
    expect(res.body).toMatchObject({
      alreadyComplete: false,
      today: TODAY,
      work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-21' },
      leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0 },
    });
  });

  it('nextMonday is the Monday on or after the given day', () => {
    expect(nextMonday('2026-09-21')).toBe('2026-09-21'); // already Monday
    expect(nextMonday('2026-09-22')).toBe('2026-09-28');
    expect(nextMonday('2026-09-27')).toBe('2026-09-28'); // Sunday
    expect(nextMonday('2026-12-30')).toBe('2027-01-04'); // across a year
  });
});

describe('completing setup', () => {
  it('produces the same records as the owner seed, for the same answers', async () => {
    const seeded = await seedOwner(prisma, { email: `seeded-${RUN}@example.test`, trackingStart: '2026-09-21' });
    emails.push(`seeded-${RUN}@example.test`);
    const { app, id } = await newcomer();
    const res = await complete(app, ownerAnswers());
    expect(res.status).toBe(201);
    expect(res.body.preview.annual).toEqual({ carriedIn: 2, credited: 15.75, used: 5, balance: 12.75 });
    expect(res.body.preview.optional).toEqual({ quota: 2, used: 1, remaining: 1 });

    const shape = async (userId: string) => {
      const rows = await prisma.leaveLedgerEntry.findMany({ where: { userId }, orderBy: [{ effectiveDate: 'asc' }, { type: 'asc' }] });
      return rows.map((r) => `${r.pool} ${r.type} ${Number(r.days)} ${r.effectiveDate.toISOString().slice(0, 10)}`).sort();
    };
    expect(await shape(id)).toEqual(await shape(seeded.id));

    const [rule, seedRule] = await Promise.all([prisma.workRule.findFirstOrThrow({ where: { userId: id } }), prisma.workRule.findFirstOrThrow({ where: { userId: seeded.id } })]);
    expect({ ...rule, id: '', userId: '', effectiveFrom: null, createdAt: null, updatedAt: null }).toEqual({ ...seedRule, id: '', userId: '', effectiveFrom: null, createdAt: null, updatedAt: null });
    const [policy, seedPolicy] = await Promise.all([prisma.leavePolicy.findFirstOrThrow({ where: { userId: id } }), prisma.leavePolicy.findFirstOrThrow({ where: { userId: seeded.id } })]);
    expect({ ...policy, id: '', userId: '' }).toEqual({ ...seedPolicy, id: '', userId: '' });

    // And the app itself reports the same balance.
    const leave = await request(app).get('/api/leave');
    expect(leave.body.annual.balance).toBe(12.75);
    expect(leave.body.optional).toMatchObject({ used: 1, remaining: 1 });
  });

  it('stores the profile and marks the account set up', async () => {
    const { app, id } = await newcomer();
    await complete(app, ownerAnswers());
    const user = await prisma.user.findUniqueOrThrow({ where: { id }, include: { settings: true } });
    expect(user.setupCompletedAt).not.toBeNull();
    expect(user.name).toBe('Test Person');
    expect(user.settings).toMatchObject({ employeeId: 'E-1', designation: 'Engineer', businessUnit: null });
    expect(user.settings!.trackingStartDate.toISOString().slice(0, 10)).toBe('2026-09-21');
  });

  it('works only once: a second call is refused and changes nothing', async () => {
    const { app, id } = await newcomer();
    expect((await complete(app, ownerAnswers())).status).toBe(201);
    const again = await complete(app, ownerAnswers({ carriedForward: 3 }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SET_UP');
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id, type: 'OPENING' } })).toBe(1);
    expect((await request(app).get('/api/setup/defaults')).body.alreadyComplete).toBe(true);
  });

  it('two simultaneous submissions create the records exactly once', async () => {
    const { app, id } = await newcomer();
    const results = await Promise.all([complete(app, ownerAnswers()), complete(app, ownerAnswers()), complete(app, ownerAnswers())]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.workRule.count({ where: { userId: id } })).toBe(1);
    expect(await prisma.leavePolicy.count({ where: { userId: id } })).toBe(1);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id, pool: 'ANNUAL', type: 'ACCRUAL' } })).toBe(9);
  });

  it('is all-or-nothing: a failure part-way leaves the account untouched and able to retry', async () => {
    const { app, id } = await newcomer();
    // A leftover settings row makes the transaction fail after the account was already claimed inside it.
    await prisma.userSettings.create({ data: { userId: id, trackingStartDate: new Date('2026-01-05T00:00:00Z') } });
    const res = await complete(app, ownerAnswers());
    expect(res.status).toBeGreaterThanOrEqual(400);
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.setupCompletedAt).toBeNull();
    expect(user.name).toBeNull();
    expect(await prisma.workRule.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id } })).toBe(0);
    // Still gated, and a retry works once the cause is gone.
    expect((await request(app).get('/api/dashboard')).status).toBe(403);
    await prisma.userSettings.delete({ where: { userId: id } });
    expect((await complete(app, ownerAnswers())).status).toBe(201);
  });

  it('does not touch anyone else', async () => {
    const a = await newcomer();
    const b = await newcomer();
    await complete(a.app, ownerAnswers());
    expect(await prisma.workRule.count({ where: { userId: b.id } })).toBe(0);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: b.id } })).toBe(0);
    expect((await request(b.app).get('/api/dashboard')).status).toBe(403);
  });

  it('needs the acknowledgement', async () => {
    const { app, id } = await newcomer();
    const res = await request(app).post('/api/setup/complete').send(ownerAnswers());
    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).setupCompletedAt).toBeNull();
  });

  it('previewing writes nothing', async () => {
    const { app, id } = await newcomer();
    const { profile: _profile, ...rest } = ownerAnswers();
    const res = await request(app).post('/api/setup/preview').send(rest);
    expect(res.status).toBe(200);
    expect(res.body.preview.annual.balance).toBe(12.75);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).setupCompletedAt).toBeNull();
  });

  it('saves a holiday list, and a Sunday week start', async () => {
    const { app, id } = await newcomer();
    const body = {
      ...ownerAnswers({}, { weekStartsOn: 7 }),
      holidays: { source: 'list', list: [{ date: '2026-10-02', name: 'Gandhi Jayanti', type: 'COMPANY' }, { date: '2026-11-08', name: 'Optional day', type: 'OPTIONAL' }] },
    };
    expect((await complete(app, body)).status).toBe(201);
    expect(await prisma.holiday.count({ where: { userId: id } })).toBe(2);
    expect((await prisma.workRule.findFirstOrThrow({ where: { userId: id } })).weekStartsOn).toBe(7);
  });
});

describe('what the plan calculates', () => {
  const plan = (leave: Partial<SetupInput['leave']> = {}, work: Partial<SetupInput['work']> = {}, today = TODAY) => planSetup(ownerAnswers(leave, work), today);

  it('credits monthly leave up to the tracking start month, and keeps later months for later', () => {
    const p = plan();
    expect(p.ledger.filter((r) => r.type === 'ACCRUAL').map((r) => r.effectiveDate)).toEqual(
      Array.from({ length: 9 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`),
    );
    expect(plan({}, { trackingStartDate: '2026-10-05' }).ledger.filter((r) => r.type === 'ACCRUAL')).toHaveLength(10); // October's credit is on file, dated in the future
    expect(plan({}, { trackingStartDate: '2026-10-05' }).preview.annual.balance).toBe(12.75); // ...but not counted today
  });

  it('handles someone who joined mid-year', () => {
    const p = plan({ carriedForward: 0, annualUsedSoFar: 1, creditsFromMonth: 6 });
    expect(p.ledger.filter((r) => r.type === 'ACCRUAL')).toHaveLength(4); // Jun, Jul, Aug, Sep
    expect(p.preview.annual).toEqual({ carriedIn: 0, credited: 7, used: 1, balance: 6 });
    expect(p.ledger.some((r) => r.type === 'OPENING')).toBe(false);
  });

  it('counts leave taken before tracking from today at the latest, never from a future date', () => {
    const adj = (today: string, start: string) => plan({}, { trackingStartDate: start }, today).ledger.find((r) => r.type === 'ADJUSTMENT')!.effectiveDate;
    expect(adj('2026-09-19', '2026-09-21')).toBe('2026-09-19'); // the day before the start is still in the future
    expect(adj('2026-09-25', '2026-09-21')).toBe('2026-09-20'); // tracking already began: the day before it
    expect(adj('2026-09-21', '2026-09-21')).toBe('2026-09-20');
  });

  it('half a day of leave and decimal credits stay exact', () => {
    expect(plan({ annualUsedSoFar: 4.5 }).preview.annual.balance).toBe(13.25);
    expect(plan({ accrualPerMonth: 1.25, annualEntitlement: 15, carriedForward: 0, annualUsedSoFar: 0 }).preview.annual.credited).toBe(11.25);
  });

  it('a person with nothing carried or used gets a clean start', () => {
    const p = plan({ carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0 });
    expect(p.ledger.map((r) => r.type)).not.toContain('ADJUSTMENT');
    expect(p.preview.optional).toEqual({ quota: 2, used: 0, remaining: 2 });
  });

  it('sets half-day hours to half the daily hours and orders the working days', () => {
    const p = plan({}, { dailyMinutes: 450, weeklyMinutes: 2250, workingDays: [5, 1, 3, 2, 4] });
    expect(p.workRule.halfDayRequiredMinutes).toBe(225);
    expect(p.workRule.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([
    ['carry-forward above the cap', { carriedForward: 3.5 }, {}, 'CARRY_TOO_HIGH'],
    ['more optional leave used than exists', { optionalUsedSoFar: 3 }, {}, 'OPTIONAL_TOO_HIGH'],
    ['more leave used than was available', { annualUsedSoFar: 30 }, {}, 'USED_MORE_THAN_AVAILABLE'],
    ['a start date in another year', {}, { trackingStartDate: '2027-01-04' }, 'INVALID_TRACKING_START'],
    ['weekly hours above daily x days', {}, { weeklyMinutes: 3000 }, 'WEEKLY_TOO_HIGH'],
    ['a repeated working day', {}, { workingDays: [1, 1, 2] }, 'INVALID_WORKING_DAYS'],
  ])('refuses %s', (_name, leave, work, code) => {
    expect(() => plan(leave as never, work as never)).toThrowError(expect.objectContaining({ code }));
  });

  it('refuses a duplicate or out-of-range holiday', () => {
    const base = ownerAnswers();
    const dup = { ...base, holidays: { source: 'list' as const, list: [{ date: '2026-10-02', name: 'A', type: 'COMPANY' as const }, { date: '2026-10-02', name: 'B', type: 'COMPANY' as const }] } };
    expect(() => planSetup(dup, TODAY)).toThrowError(expect.objectContaining({ code: 'DUPLICATE_HOLIDAY' }));
    const far = { ...base, holidays: { source: 'list' as const, list: [{ date: '2030-01-01', name: 'A', type: 'COMPANY' as const }] } };
    expect(() => planSetup(far, TODAY)).toThrowError(expect.objectContaining({ code: 'HOLIDAY_OUT_OF_RANGE' }));
  });
});

describe('input validation', () => {
  it.each([
    ['an impossible date', { work: { trackingStartDate: '2026-02-30' } }],
    ['a malformed date', { work: { trackingStartDate: '21/09/2026' } }],
    ['no working days', { work: { workingDays: [] } }],
    ['a working day 8', { work: { workingDays: [1, 8] } }],
    ['week start on Wednesday', { work: { weekStartsOn: 3 } }],
    ['a 24-hour day', { work: { dailyMinutes: 1440 } }],
    ['a fractional minute count', { work: { dailyMinutes: 480.5 } }],
    ['negative leave', { leave: { annualUsedSoFar: -1 } }],
    ['an empty name', { profile: { name: '   ' } }],
    ['a very long name', { profile: { name: 'x'.repeat(81) } }],
    ['a text number', { leave: { carriedForward: '2' } }],
  ])('rejects %s', async (_name, patch) => {
    const { app, id } = await newcomer();
    const base = ownerAnswers() as unknown as Record<string, Record<string, unknown>>;
    const body = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v, ...((patch as Record<string, object>)[k] ?? {}) }]));
    const res = await complete(app, body);
    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).setupCompletedAt).toBeNull();
  });

  it('the schema itself accepts the defaults and drops nothing surprising', () => {
    expect(setupSchema.safeParse(ownerAnswers()).success).toBe(true);
    expect(setupSchema.safeParse({ ...ownerAnswers(), extra: 1 }).success).toBe(true); // unknown keys are ignored, not stored
  });
});
