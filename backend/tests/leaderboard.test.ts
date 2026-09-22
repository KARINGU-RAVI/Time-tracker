import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const emails: string[] = [];
let seq = 0;

/** A new account, set up through the real wizard, Mon-Fri 8h/day, tracking from 14 Sep 2026. */
async function account(today: string) {
  const email = `lb-${RUN}-${++seq}@example.test`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  const clock = { now: istInstant(today, '18:00') };
  const app = createApp({ prisma, clock: () => clock.now, authenticate: devAuthenticator(prisma, email) });
  const res = await request(app).post('/api/setup/complete').send({
    acknowledged: true,
    profile: { name: 'Colleague' },
    work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-14' },
    leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0, birthdayQuota: 0.5, birthdayTaken: false, creditsFromMonth: 1 },
    holidays: { source: 'none' },
  });
  expect(res.status).toBe(201);
  return { app, clock, id: user.id, email };
}

async function workDay(app: ReturnType<typeof createApp>, date: string, minutes: number) {
  const outMinute = minutes % 60;
  const outHour = 9 + Math.floor(minutes / 60);
  const res = await request(app)
    .post(`/api/attendance/${date}/sessions`)
    .send({ inTime: `${date}T09:00`, outTime: `${date}T${String(outHour).padStart(2, '0')}:${String(outMinute).padStart(2, '0')}` });
  expect(res.status).toBe(201);
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe('leaderboard: opt-in ranking by % of weekly goal met', () => {
  it('never shows anyone who has not opted in, including yourself', async () => {
    const a = await account('2026-09-18');
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) await workDay(a.app, d, 480);

    const board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    expect(board.status).toBe(200);
    expect(board.body.entries).toEqual([]);
    expect(board.body.you.optedIn).toBe(false);
    expect(board.body.you.rank).toBeNull();
    expect(board.body.you.pct).toBeCloseTo(1.0);
  });

  it('reports your own opt-in flag even for a period before your tracking starts (pct is null, not excluded)', async () => {
    const a = await account('2026-09-18'); // tracking starts 2026-09-14; ask about the week before
    await request(a.app).put('/api/leaderboard/visibility').send({ optedIn: true });
    const board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-10' });
    expect(board.body.you).toMatchObject({ optedIn: true, pct: null, rank: null });
    expect(board.body.entries).toEqual([]);
    await request(a.app).put('/api/leaderboard/visibility').send({ optedIn: false });
  });

  it('ranks opted-in colleagues by % of goal met, not raw minutes, and drops you the moment you opt out', async () => {
    const a = await account('2026-09-18'); // will work all 5 days: 100%
    const b = await account('2026-09-18'); // will work 3 days: 60%
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) await workDay(a.app, d, 480);
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16']) await workDay(b.app, d, 480);

    // Nobody opted in yet.
    let board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    expect(board.body.entries).toEqual([]);

    await request(a.app).put('/api/leaderboard/visibility').send({ optedIn: true, displayName: 'Alex' });
    await request(b.app).put('/api/leaderboard/visibility').send({ optedIn: true, displayName: 'Blair' });

    board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    expect(board.body.entries).toHaveLength(2);
    expect(board.body.entries[0]).toMatchObject({ rank: 1, displayName: 'Alex', isYou: true });
    expect(board.body.entries[0].pct).toBeCloseTo(1.0);
    expect(board.body.entries[1]).toMatchObject({ rank: 2, displayName: 'Blair', isYou: false });
    expect(board.body.entries[1].pct).toBeCloseTo(0.6);
    expect(board.body.you).toMatchObject({ optedIn: true, rank: 1 });

    // B sees the same board, from their own side.
    const bBoard = await request(b.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    expect(bBoard.body.you).toMatchObject({ optedIn: true, rank: 2 });
    expect(bBoard.body.entries.find((e: { isYou: boolean }) => e.isYou)).toMatchObject({ displayName: 'Blair', rank: 2 });

    // Opting out removes B immediately, with no lingering state.
    await request(b.app).put('/api/leaderboard/visibility').send({ optedIn: false });
    board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    expect(board.body.entries).toHaveLength(1);
    expect(board.body.entries[0].displayName).toBe('Alex');
  });

  it('never leaks raw minutes, session times or leave detail in the response', async () => {
    const a = await account('2026-09-18');
    await workDay(a.app, '2026-09-15', 480);
    await request(a.app).put('/api/leaderboard/visibility').send({ optedIn: true });
    const board = await request(a.app).get('/api/leaderboard/week').query({ date: '2026-09-18' });
    const json = JSON.stringify(board.body);
    expect(json).not.toMatch(/workedMinutes|requiredMinutes|sessions|inTime|outTime/);
  });
});
