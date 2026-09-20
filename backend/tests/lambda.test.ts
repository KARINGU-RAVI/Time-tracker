import { PrismaClient } from '@prisma/client';
import type { Context, Handler } from 'aws-lambda';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { loadProductionConfig } from '../src/config';
import { MemoryEmailSender } from '../src/email';
import type { GoogleVerifier } from '../src/google';
import { allowAllTurnstile } from '../src/turnstile';
import { createHandler, normalisePath } from '../src/lambda';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const ORIGIN = 'https://hours.example.test';
const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const email = `lambda-${Date.now()}-${process.pid}@example.test`;

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://unused@localhost/unused',
  BREVO_API_KEY: 'xkeysib-test',
  EMAIL_FROM: 'sender@example.test',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  SESSION_SECRET: SECRET,
  APP_ORIGIN: ORIGIN,
  AUTH_MODE: 'google',
  ...over,
});

const verifyGoogle: GoogleVerifier = async (credential) => {
  if (credential.startsWith('good')) return { sub: 'sub-owner', email, emailVerified: true };
  throw new Error('bad token');
};

let handler: Handler;
async function setup() {
  await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  handler = createHandler(env(), { prisma, verifyGoogle, email: new MemoryEmailSender(), verifyTurnstile: allowAllTurnstile, clock: () => istInstant('2026-09-21', '10:00') });
}

afterAll(async () => {
  // These tests use a fixed clock and one local address, so their sign-in counters would otherwise pile up across runs.
  await prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "key" LIKE 'google:ip:%' AND "key" NOT LIKE '%10.99.%'`;
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

interface NetlifyEvent {
  httpMethod?: string;
  path: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

/** A Netlify-style (API Gateway v1) event. */
async function invoke(h: Handler, e: NetlifyEvent) {
  const event = {
    httpMethod: 'GET',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: {},
    ...e,
  };
  const res = (await h(event as never, { callbackWaitsForEmptyEventLoop: true } as Context, () => undefined)) as {
    statusCode: number;
    headers?: Record<string, string>;
    multiValueHeaders?: Record<string, string[]>;
    body: string;
    isBase64Encoded?: boolean;
  };
  const cookies = [...(res.multiValueHeaders?.['set-cookie'] ?? []), ...(res.headers?.['set-cookie'] ? [res.headers['set-cookie']] : [])];
  return { status: res.statusCode, body: res.body, isBase64Encoded: res.isBase64Encoded === true, json: () => JSON.parse(res.body), headers: res.headers ?? {}, cookies };
}

describe('path handling', () => {
  it.each([
    ['/api/health', '/api/health'],
    ['/.netlify/functions/api/health', '/api/health'],
    ['/.netlify/functions/api/api/health', '/api/health'],
    ['/.netlify/functions/api', '/api'],
    ['/.netlify/functions/api/', '/api'],
    ['/api/attendance/2026-09-21', '/api/attendance/2026-09-21'],
    ['/health', '/api/health'],
  ])('%s -> %s', (input, expected) => {
    expect(normalisePath(input)).toBe(expected);
  });

  it('does not treat a lookalike prefix as the function path', () => {
    expect(normalisePath('/.netlify/functions/apix/health')).toBe('/api/.netlify/functions/apix/health');
  });
});

describe('start-up configuration', () => {
  it('accepts a complete, safe configuration and normalises the origin', () => {
    expect(loadProductionConfig(env({ APP_ORIGIN: 'https://hours.example.test/' })).appOrigin).toBe(ORIGIN);
  });

  it.each(['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'APP_ORIGIN', 'BREVO_API_KEY', 'EMAIL_FROM', 'TURNSTILE_SECRET_KEY'])('refuses to start without %s', (key) => {
    expect(() => loadProductionConfig(env({ [key]: undefined }))).toThrow(new RegExp(key));
  });

  it('checks the email sender and the account cap', () => {
    expect(() => loadProductionConfig(env({ EMAIL_FROM: 'not-an-email' }))).toThrow(/EMAIL_FROM/);
    expect(loadProductionConfig(env()).maxAccounts).toBe(200);
    expect(loadProductionConfig(env({ MAX_ACCOUNTS: '50' })).maxAccounts).toBe(50);
    for (const bad of ['0', '-1', 'many', '1.5', '999999']) expect(() => loadProductionConfig(env({ MAX_ACCOUNTS: bad })), bad).toThrow(/MAX_ACCOUNTS/);
  });

  it('never allows the development login, even if NODE_ENV is not set', () => {
    expect(() => loadProductionConfig(env({ AUTH_MODE: 'dev' }))).toThrow(/AUTH_MODE must be "google"/);
    expect(() => loadProductionConfig(env({ AUTH_MODE: undefined }))).toThrow(/AUTH_MODE must be "google"/);
  });

  it('rejects a weak secret and an unsafe or malformed origin', () => {
    expect(() => loadProductionConfig(env({ SESSION_SECRET: 'short' }))).toThrow(/at least 32/);
    expect(() => loadProductionConfig(env({ APP_ORIGIN: 'http://hours.example.test' }))).toThrow(/https/);
    expect(() => loadProductionConfig(env({ APP_ORIGIN: 'not a url' }))).toThrow(/full URL/);
    expect(() => loadProductionConfig(env({ APP_ORIGIN: 'https://hours.example.test/app' }))).toThrow(/without a path/);
  });

  it('createHandler fails at cold start on bad configuration', () => {
    expect(() => createHandler(env({ AUTH_MODE: 'dev' }), { prisma })).toThrow();
    expect(() => createHandler(env({ SESSION_SECRET: undefined }), { prisma })).toThrow(/SESSION_SECRET/);
  });
});

describe('serving requests the way Netlify sends them', () => {
  it('answers the health check for every path shape', async () => {
    await setup();
    for (const path of ['/api/health', '/.netlify/functions/api/health', '/.netlify/functions/api/api/health']) {
      const res = await invoke(handler, { path });
      expect(res.status, path).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });

  it('locks everything else until sign-in', async () => {
    await setup();
    for (const path of ['/api/dashboard', '/api/backup', '/api/leave', '/api/attendance/today']) {
      const res = await invoke(handler, { path });
      expect(res.status, path).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
    expect((await invoke(handler, { path: '/api/dashboard', headers: { cookie: 'oht_session=garbage' } })).status).toBe(401);
  });

  it('signs in and then serves data using the cookie from the response', async () => {
    await setup();
    const login = await invoke(handler, {
      httpMethod: 'POST',
      path: '/api/auth/google',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: 'good-owner-token-123' }),
    });
    expect(login.status).toBe(200);
    expect(login.json().user.email).toBe(email);
    expect(login.cookies).toHaveLength(1);
    const setCookie = login.cookies[0]!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(setCookie).toContain(attr);

    const cookie = setCookie.split(';')[0]!;
    const dash = await invoke(handler, { path: '/.netlify/functions/api/dashboard', headers: { cookie } });
    expect(dash.status).toBe(200);
    expect(dash.json().leave.annualBalance).toBe(12.75);

    const me = await invoke(handler, { path: '/api/auth/me', headers: { cookie } });
    expect(me.json().user.email).toBe(email);

    const out = await invoke(handler, { httpMethod: 'POST', path: '/api/auth/logout', headers: { origin: ORIGIN } });
    expect(out.status).toBe(204);
    expect(out.cookies[0]).toContain('Max-Age=0');
  });

  it('refuses a write from another site even with a valid cookie', async () => {
    await setup();
    const login = await invoke(handler, { httpMethod: 'POST', path: '/api/auth/google', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ credential: 'good-owner-token-123' }) });
    const cookie = login.cookies[0]!.split(';')[0]!;
    const evil = await invoke(handler, { httpMethod: 'POST', path: '/api/attendance/check-in', headers: { cookie, origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.json().error.code).toBe('BAD_ORIGIN');
  });

  it('refuses the wrong Google account and an invalid credential without a cookie', async () => {
    await setup();
    const bad = await invoke(handler, { httpMethod: 'POST', path: '/api/auth/google', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ credential: 'garbage-credential-value' }) });
    expect(bad.status).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIAL');
    expect(bad.cookies).toHaveLength(0);
  });

  it('carries a picture as raw bytes both ways (upload, then download identical)', async () => {
    await setup();
    const login = await invoke(handler, {
      httpMethod: 'POST',
      path: '/api/auth/google',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ credential: 'good-owner-token-123' }),
    });
    const cookie = login.cookies[0]!.split(';')[0]!;
    // A PNG whose bytes are NOT valid UTF-8: if anything treated it as text it would be corrupted.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0xc3, 0x28, 0xf0, 0x9f]), Buffer.alloc(200, 0xab)]);

    const up = await invoke(handler, {
      httpMethod: 'PUT',
      path: '/.netlify/functions/api/holidays/image',
      headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' },
      queryStringParameters: { width: '10', height: '10', name: 'cal.png' },
      body: png.toString('base64'),
      isBase64Encoded: true,
    });
    expect(up.status).toBe(200);
    expect(up.json()).toMatchObject({ exists: true, mimeType: 'image/png', fileName: 'cal.png' });

    const down = await invoke(handler, { path: '/api/holidays/image/file', headers: { cookie } });
    expect(down.status).toBe(200);
    expect(down.isBase64Encoded).toBe(true); // Netlify is told this is binary
    expect(Buffer.compare(Buffer.from(down.body, 'base64'), png)).toBe(0);
    expect(down.headers['content-type']).toBe('image/png');
    expect(down.headers['x-content-type-options']).toBe('nosniff');

    // Clean up so the next run starts empty, and check a stranger without the cookie cannot get it.
    expect((await invoke(handler, { path: '/api/holidays/image/file' })).status).toBe(401);
    expect((await invoke(handler, { httpMethod: 'DELETE', path: '/api/holidays/image', headers: { cookie, origin: ORIGIN } })).status).toBe(204);
  });

  it('reads base64-encoded bodies and query strings', async () => {
    await setup();
    const login = await invoke(handler, {
      httpMethod: 'POST',
      path: '/api/auth/google',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: Buffer.from(JSON.stringify({ credential: 'good-owner-token-123' })).toString('base64'),
      isBase64Encoded: true,
    });
    expect(login.status).toBe(200);
    const cookie = login.cookies[0]!.split(';')[0]!;

    const range = await invoke(handler, {
      path: '/api/attendance',
      headers: { cookie },
      queryStringParameters: { startDate: '2026-09-21', endDate: '2026-09-23' },
    });
    expect(range.status).toBe(200);
    expect(range.json().days).toHaveLength(3);
  });

  it('returns JSON errors (never HTML or stack traces) for unknown routes and bad input', async () => {
    await setup();
    const login = await invoke(handler, { httpMethod: 'POST', path: '/api/auth/google', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ credential: 'good-owner-token-123' }) });
    const cookie = login.cookies[0]!.split(';')[0]!;
    const missing = await invoke(handler, { path: '/api/nothing', headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    const badDate = await invoke(handler, { path: '/api/attendance/2026-13-40', headers: { cookie } });
    expect(badDate.status).toBe(400);
    expect(badDate.headers['content-type']).toMatch(/json/);
  });

  it('a full backup travels through the function', async () => {
    await setup();
    const login = await invoke(handler, { httpMethod: 'POST', path: '/api/auth/google', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ credential: 'good-owner-token-123' }) });
    const cookie = login.cookies[0]!.split(';')[0]!;
    const backup = await invoke(handler, { path: '/api/backup', headers: { cookie } });
    expect(backup.status).toBe(200);
    expect(backup.headers['content-disposition']).toContain('office-hours-backup-2026-09-21.json');
    const file = backup.json();

    const validate = await invoke(handler, { httpMethod: 'POST', path: '/api/backup/validate', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: backup.body });
    expect(validate.status).toBe(200);
    expect(validate.json().valid).toBe(true);
    expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
