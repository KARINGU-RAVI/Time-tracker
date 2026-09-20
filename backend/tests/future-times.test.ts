import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { seedOwner } from '../prisma/seed-lib';

/** Time that has not happened yet cannot be recorded as worked time. */

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const emails: string[] = [];
let seq = 0;
const NOW = istInstant('2026-09-23', '10:00'); // Wednesday 10:00 in India
const TODAY = '2026-09-23';

async function account() {
  const email = `future-${RUN}-${++seq}@example.test`;
  emails.push(email);
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  return createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const add = (app: ReturnType<typeof createApp>, date: string, inn: string, out: string | null) =>
  request(app).post(`/api/attendance/${date}/sessions`).send({ inTime: `${date}T${inn}`, ...(out ? { outTime: `${date}T${out}` } : {}) });

describe('no time from the future', () => {
  it('refuses an entry that ends later than now, and saves nothing', async () => {
    const app = await account();
    const res = await add(app, TODAY, '08:00', '15:00');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'IN_THE_FUTURE', message: 'You cannot record a time that has not happened yet.' });
    expect((await request(app).get(`/api/attendance/${TODAY}`)).body.sessions).toHaveLength(0);
  });

  it('refuses an entry that starts later than now, today or on a later day', async () => {
    const app = await account();
    expect((await add(app, TODAY, '14:00', '15:00')).body.error.code).toBe('IN_THE_FUTURE');
    expect((await add(app, TODAY, '14:00', null)).body.error.code).toBe('IN_THE_FUTURE'); // an open entry too
    expect((await add(app, '2026-09-24', '09:00', '17:00')).body.error.code).toBe('IN_THE_FUTURE'); // tomorrow
  });

  it('accepts entries up to now (with a minute of slack), and any time in the past', async () => {
    const app = await account();
    expect((await add(app, TODAY, '08:00', '10:00')).status).toBe(201); // ends exactly now
    expect((await add(app, TODAY, '10:00', '10:01')).status).toBe(201); // one minute of slack
    expect((await add(app, '2026-09-22', '08:00', '17:00')).status).toBe(201);
    expect((await add(app, '2026-09-01', '08:00', '17:00')).status).toBe(201);
  });

  it('refuses to edit an entry so that it reaches into the future, and leaves it as it was', async () => {
    const app = await account();
    await add(app, TODAY, '08:00', '09:00');
    const id = (await request(app).get(`/api/attendance/${TODAY}`)).body.sessions[0].id;
    const res = await request(app).put(`/api/sessions/${id}`).send({ outTime: `${TODAY}T18:00` });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IN_THE_FUTURE');
    expect((await request(app).get(`/api/attendance/${TODAY}`)).body.sessions[0].outClock).toBe('09:00');
    expect((await request(app).put(`/api/sessions/${id}`).send({ outTime: `${TODAY}T09:45` })).status).toBe(200);
  });

  it('checking in and out still works (they use the real clock)', async () => {
    const app = await account();
    expect((await request(app).post('/api/attendance/check-in')).status).toBe(201);
  });
});
