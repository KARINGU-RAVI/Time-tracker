import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { seedOwner } from '../prisma/seed-lib';

/** Personal data must not be stored by a shared cache (a proxy or CDN); the browser may keep it but must check each time. */

const prisma = new PrismaClient();
const email = `cache-${Date.now()}-${process.pid}@example.test`;
const NOW = istInstant('2026-09-23', '10:00');

const app = (async () => {
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  return createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) });
})();

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

describe('cache headers on the API', () => {
  it.each(['/api/health', '/api/dashboard', '/api/leave', '/api/holidays', '/api/rules', '/api/attendance/2026-09-22', '/api/summary/week?date=2026-09-22'])(
    '%s is private and always re-checked',
    async (path) => {
      const res = await request(await app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    },
  );

  it('error answers carry it too, so a failure is never stored and replayed', async () => {
    const res = await request(await app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const bad = await request(await app).get('/api/attendance/not-a-date');
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe('private, no-cache');
  });

  it('writes are not cacheable either', async () => {
    const res = await request(await app).put('/api/attendance/2026-09-22').send({ status: 'WORKING' });
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('an unchanged answer can be confirmed cheaply (ETag, then 304 with no body)', async () => {
    const first = await request(await app).get('/api/rules');
    const etag = first.headers['etag'];
    expect(etag).toBeTruthy();
    const again = await request(await app).get('/api/rules').set('If-None-Match', etag!);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    // A changed answer is sent in full.
    const other = await request(await app).get('/api/rules').set('If-None-Match', '"something-else"');
    expect(other.status).toBe(200);
    expect(other.body.rules).toBeDefined();
  });

  it('the picture route keeps the same private policy', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await request(await app).put('/api/holidays/image?width=1&height=1').set('Content-Type', 'image/png').send(png);
    const res = await request(await app).get('/api/holidays/image/file');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    await request(await app).delete('/api/holidays/image');
  });
});
