import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryEmailSender } from '../src/email';
import { allowAllTurnstile } from '../src/turnstile';
import type { GoogleVerifier } from '../src/google';
import { sessionAuthenticator } from '../src/routes/auth';
import { signSession, verifySession } from '../src/session';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const ORIGIN = 'https://hours.example.test';

const email = `auth-${Date.now()}-${process.pid}@example.test`;
let userId: string;

// A fake Google: the credential string decides who "signed in".
const verifyGoogle: GoogleVerifier = async (credential) => {
  if (credential.startsWith('good-owner')) return { sub: 'sub-owner', email, emailVerified: true };
  if (credential.startsWith('good-stranger')) return { sub: 'sub-stranger', email: 'stranger@example.test', emailVerified: true };
  if (credential.startsWith('unverified')) return { sub: 'sub-owner', email, emailVerified: false };
  if (credential.startsWith('other-sub')) return { sub: 'sub-someone-else', email, emailVerified: true };
  throw new Error('bad token');
};

function makeApp(secure = false) {
  return createApp({
    prisma,
    clock: () => istInstant('2026-09-21', '10:00'),
    authenticate: sessionAuthenticator(prisma, SECRET),
    auth: {
      verifyGoogle,
      sessionSecret: SECRET,
      secureCookies: secure,
      appOrigin: ORIGIN,
      email: new MemoryEmailSender(),
      verifyTurnstile: allowAllTurnstile,
      maxAccounts: 100000,
    },
  });
}

beforeAll(async () => {
  userId = (await seedOwner(prisma, { email, trackingStart: '2026-09-01' })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const cookieOf = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw?.[0] ?? '').split(';')[0]!;
};

describe('Google sign-in', () => {
  it('signs the owner in with an HttpOnly cookie that unlocks the API', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/auth/google').send({ credential: 'good-owner-token-123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // only in production

    const cookie = cookieOf(res);
    expect((await request(app).get('/api/dashboard')).status).toBe(401); // no cookie
    expect((await request(app).get('/api/dashboard').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.email).toBe(email);

    // The Google account is now bound to the user.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.googleSub).toBe('sub-owner');
  });

  it('marks the cookie Secure in production', async () => {
    const res = await request(makeApp(true)).post('/api/auth/google').send({ credential: 'good-owner-token-123' });
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Secure');
  });

  it('creates a new account for an unknown verified Google user, which must finish setup', async () => {
    const stranger = 'stranger@example.test';
    await prisma.user.deleteMany({ where: { email: stranger } });
    const res = await request(makeApp()).post('/api/auth/google').send({ credential: 'good-stranger-token' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: stranger, setupComplete: false, isAdmin: false });
    const created = await prisma.user.findUniqueOrThrow({ where: { email: stranger } });
    expect(created.emailVerifiedAt).not.toBeNull();
    expect(created.id).not.toBe(userId); // never the owner's account
    await prisma.user.delete({ where: { id: created.id } });
  });

  it('refuses an unverified email', async () => {
    const res = await request(makeApp()).post('/api/auth/google').send({ credential: 'unverified-token-1234' });
    expect(res.status).toBe(403);
  });

  it('refuses a different Google identity that claims the owner email', async () => {
    await prisma.user.update({ where: { id: userId }, data: { googleSub: 'sub-owner' } });
    const res = await request(makeApp()).post('/api/auth/google').send({ credential: 'other-sub-token-1234' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ALLOWED');
  });

  it('rejects an invalid Google credential', async () => {
    const res = await request(makeApp()).post('/api/auth/google').send({ credential: 'garbage-garbage-garbage' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIAL');
    expect((await request(makeApp()).post('/api/auth/google').send({})).status).toBe(400);
  });

  it('signs out by clearing the cookie', async () => {
    const res = await request(makeApp()).post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
  });
});

describe('session cookie security', () => {
  it('rejects a tampered cookie', async () => {
    const good = await signSession({ userId, email, version: 0 }, SECRET);
    const tampered = good.slice(0, -3) + (good.endsWith('AAA') ? 'BBB' : 'AAA');
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', `oht_session=${tampered}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await signSession({ userId, email, version: 0 }, 'a-completely-different-secret-value-32chars');
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', `oht_session=${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const expired = await signSession({ userId, email, version: 0 }, SECRET, -60);
    expect(await verifySession(expired, SECRET)).toBeNull();
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', `oht_session=${expired}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: userId, email, exp: 9999999999 })).toString('base64url');
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', `oht_session=${header}.${body}.`);
    expect(res.status).toBe(401);
  });

  it('rejects a valid session for a user that no longer exists', async () => {
    const ghost = await signSession({ userId: '00000000-0000-4000-8000-000000000000', email, version: 0 }, SECRET);
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', `oht_session=${ghost}`);
    expect(res.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('blocks writes that come from another site, even with a valid cookie', async () => {
    const cookie = `oht_session=${await signSession({ userId, email, version: 0 }, SECRET)}`;
    const app = makeApp();
    const evil = await request(app).post('/api/attendance/check-in').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('BAD_ORIGIN');

    const mine = await request(app).post('/api/attendance/check-in').set('Cookie', cookie).set('Origin', ORIGIN);
    expect(mine.status).toBe(201);
  });

  it('does not block reads', async () => {
    const cookie = `oht_session=${await signSession({ userId, email, version: 0 }, SECRET)}`;
    const res = await request(makeApp()).get('/api/dashboard').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });
});

describe('configuration safety', () => {
  const base = { ALLOWED_EMAIL: 'me@example.test' };

  it('refuses to start with dev auth in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/not allowed/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/not allowed/);
  });

  it('requires Google settings and a long secret in google mode', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'google' })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadConfig({ ...base, AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'x', SESSION_SECRET: 'short' })).toThrow(/32/);
    expect(() =>
      loadConfig({ ...base, AUTH_MODE: 'google', NODE_ENV: 'production', GOOGLE_CLIENT_ID: 'x', SESSION_SECRET: 's'.repeat(40) }),
    ).toThrow(/APP_ORIGIN/);
    const ok = loadConfig({
      ...base,
      AUTH_MODE: 'google',
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'x',
      SESSION_SECRET: 's'.repeat(40),
      APP_ORIGIN: 'https://a.example',
    });
    expect(ok.secureCookies).toBe(true);
  });

  it('requires ALLOWED_EMAIL', () => {
    expect(() => loadConfig({})).toThrow(/ALLOWED_EMAIL/);
  });
});
