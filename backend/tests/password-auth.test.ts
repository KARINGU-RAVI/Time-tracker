import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { MemoryEmailSender, type OutgoingEmail } from '../src/email';
import type { GoogleVerifier } from '../src/google';
import { hashPassword, passwordProblems, verifyPassword } from '../src/password';
import { sessionAuthenticator } from '../src/routes/auth';
import { TOKEN_TTL_MS } from '../src/tokens';

const prisma = new PrismaClient();
const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const ORIGIN = 'https://hours.example.test';
const RUN = `${Date.now()}-${process.pid}`;
const STRONG = 'correct horse battery';
const HOUR = 3_600_000;

let now = Date.UTC(2026, 8, 21, 4, 30);
let mail: MemoryEmailSender;
let maxAccounts = 100000;
let humanOk = true;
let failEmail = false;
let ipCounter = 0;
let emailCounter = 0;

const freshEmail = (tag = 'u') => `${tag}-${RUN}-${++emailCounter}@example.test`;
const freshIp = () => `10.99.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

const verifyGoogle: GoogleVerifier = async (credential) => {
  // credential looks like "google|<sub>|<email>|<verified>"
  const [kind, sub, email, verified] = credential.split('|');
  if (kind !== 'google') throw new Error('bad token');
  return { sub: sub!, email: email!, emailVerified: verified === 'true', name: 'Some Person' };
};

function makeApp() {
  mail = new MemoryEmailSender();
  const sender = {
    send: async (m: OutgoingEmail) => {
      if (failEmail) throw new Error('provider down');
      return mail.send(m);
    },
  };
  return createApp({
    prisma,
    clock: () => now,
    authenticate: sessionAuthenticator(prisma, SECRET),
    auth: {
      verifyGoogle,
      sessionSecret: SECRET,
      secureCookies: false,
      appOrigin: ORIGIN,
      email: sender,
      verifyTurnstile: async (token) => humanOk && token === 'human',
      maxAccounts,
    },
  });
}

let app = makeApp();
beforeEach(() => {
  now = Date.UTC(2026, 8, 21, 4, 30);
  maxAccounts = 100000;
  humanOk = true;
  failEmail = false;
  app = makeApp();
});

// The fake client IPs repeat on every run, so counters left behind by an earlier run must not leak into this one.
const clearCounters = () => prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "key" LIKE '%:ip:10.99.%'`;
beforeAll(async () => {
  await clearCounters();
});

afterAll(async () => {
  await clearCounters();
  await prisma.user.deleteMany({ where: { email: { contains: RUN } } });
  await prisma.$disconnect();
});

const post = (path: string, body: object, ip = freshIp()) =>
  request(app).post(`/api/auth/${path}`).set('x-nf-client-connection-ip', ip).send(body);

const register = (email: string, password = STRONG, ip?: string) => post('register', { email, password, turnstileToken: 'human' }, ip);
const login = (email: string, password: string, ip?: string) => post('login', { email, password }, ip);
const tokenIn = (m: OutgoingEmail | undefined) => /token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1] ?? '';
const cookieOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '').split(';')[0]!;

async function verifiedAccount(password = STRONG) {
  const email = freshEmail('acct');
  await register(email, password);
  const res = await post('verify-email', { token: tokenIn(mail.last(email)) });
  expect(res.status).toBe(200);
  return { email, cookie: cookieOf(res) };
}

describe('password policy and hashing', () => {
  it('hashes with scrypt, salts every hash, and verifies in constant time', async () => {
    const a = await hashPassword('a-long-enough-password');
    const b = await hashPassword('a-long-enough-password');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b); // random salt
    expect(a).not.toContain('a-long-enough-password');
    expect(await verifyPassword('a-long-enough-password', a)).toBe(true);
    expect(await verifyPassword('a-long-enough-passwore', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false); // malformed stored value never throws
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(false); // absurd cost is refused
  });

  it('refuses short, common, repeated and email-like passwords, and accepts a good one', () => {
    expect(passwordProblems('short')).toContain('TOO_SHORT');
    expect(passwordProblems('password123')).toContain('TOO_COMMON');
    expect(passwordProblems('PASSWORD123')).toContain('TOO_COMMON'); // case-insensitive
    expect(passwordProblems('aaaaaaaaaaaa')).toContain('ONE_CHARACTER_REPEATED');
    expect(passwordProblems('x'.repeat(129))).toContain('TOO_LONG');
    expect(passwordProblems('someone@example.test', 'someone@example.test')).toContain('SAME_AS_EMAIL');
    expect(passwordProblems('someonehere', 'someonehere@example.test')).toContain('SAME_AS_EMAIL');
    expect(passwordProblems(STRONG, 'a@b.test')).toEqual([]);
    expect(passwordProblems('a passphrase with spaces')).toEqual([]);
  });
});

describe('registration', () => {
  it('creates an unverified account, stores only a hash, and emails a verification link', async () => {
    const email = freshEmail();
    const res = await register(email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    expect(res.headers['set-cookie']).toBeUndefined(); // not signed in until the email is verified

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.setupCompletedAt).toBeNull();
    expect(user.isAdmin).toBe(false);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(STRONG);

    const m = mail.last(email)!;
    expect(m.text).toContain(`${ORIGIN}/verify-email?token=`);
    const raw = tokenIn(m);
    expect(raw.length).toBeGreaterThan(30);
    // Only a hash of the token is stored, never the token itself.
    const stored = await prisma.authToken.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(raw);
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it('stores the email in lower case, so differently-cased addresses are one account', async () => {
    const email = freshEmail('mixed');
    await register(email.toUpperCase());
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
    await register(email); // same address again: no second account
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('rejects weak passwords with a checklist, and creates nothing', async () => {
    const email = freshEmail();
    const res = await register(email, 'short');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details.problems.map((p: { code: string }) => p.code)).toContain('TOO_SHORT');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect((await register(email, email)).body.error.code).toBe('WEAK_PASSWORD');
  });

  it('rejects malformed input', async () => {
    expect((await post('register', { email: 'not-an-email', password: STRONG, turnstileToken: 'human' })).status).toBe(400);
    expect((await post('register', { password: STRONG })).status).toBe(400);
    expect((await post('register', { email: freshEmail(), password: 12345 })).status).toBe(400);
  });

  it('needs the human check, and creates nothing when it fails', async () => {
    const email = freshEmail();
    const res = await post('register', { email, password: STRONG }); // no token
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BOT_CHECK_FAILED');
    humanOk = false;
    expect((await register(email)).body.error.code).toBe('BOT_CHECK_FAILED');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(mail.sent).toHaveLength(0);
  });

  it('answers identically for an address that is already registered, and never changes that account', async () => {
    const { email } = await verifiedAccount();
    const before = await prisma.user.findUniqueOrThrow({ where: { email } });
    const fresh = await register(freshEmail());
    const again = await register(email, 'a-different-password-9');
    expect(again.status).toBe(fresh.status);
    expect(again.body).toEqual(fresh.body); // nothing reveals that the account exists
    const after = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    // The real owner is told by email instead.
    expect(mail.last(email)!.subject).toMatch(/already have/i);
    expect(mail.last(email)!.text).not.toContain('token=');
  });

  it('stops new sign-ups at the account cap, but does not disturb existing addresses', async () => {
    const { email } = await verifiedAccount();
    maxAccounts = await prisma.user.count();
    app = makeApp();
    const full = await register(freshEmail());
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe('SIGNUPS_FULL');
    expect((await register(email)).status).toBe(202);
  });

  it('reports an email-provider failure instead of pretending it worked', async () => {
    failEmail = true;
    const res = await register(freshEmail());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EMAIL_FAILED');
  });

  it('limits sign-ups per address and per IP, and the limit resets with the window', async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) expect((await register(email)).status).toBe(202);
    const blocked = await register(email);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    now += HOUR + 1000;
    expect((await register(email)).status).toBe(202);

    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await register(freshEmail(), STRONG, ip)).status).toBe(202);
    expect((await register(freshEmail(), STRONG, ip)).status).toBe(429);
    expect((await register(freshEmail(), STRONG, freshIp())).status).toBe(202); // another IP is unaffected
  });

  it('removes accounts that never verified after three days', async () => {
    const stale = freshEmail('stale');
    await register(stale);
    now += 3 * 24 * HOUR + 1000;
    await register(freshEmail()); // any later sign-up triggers the cleanup
    expect(await prisma.user.findUnique({ where: { email: stale } })).toBeNull();
  });
});

describe('email verification', () => {
  it('verifies, signs the user in, and the link works only once', async () => {
    const email = freshEmail();
    await register(email);
    const token = tokenIn(mail.last(email));
    const ok = await post('verify-email', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ email, setupComplete: false, isAdmin: false });
    const cookie = cookieOf(ok);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.email).toBe(email);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();

    const reuse = await post('verify-email', { token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('two simultaneous uses of one link: exactly one succeeds', async () => {
    const email = freshEmail();
    await register(email);
    const token = tokenIn(mail.last(email));
    const results = await Promise.all([post('verify-email', { token }), post('verify-email', { token }), post('verify-email', { token })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
  });

  it('refuses expired, garbage, and wrong-kind tokens', async () => {
    const email = freshEmail();
    await register(email);
    const token = tokenIn(mail.last(email));
    for (const bad of ['', 'x', 'a'.repeat(60), "' OR 1=1 --", '../../etc/passwd']) {
      expect((await post('verify-email', { token: bad })).status, bad).toBe(400);
    }
    // A password-reset token cannot verify an email.
    await post('forgot-password', { email, turnstileToken: 'human' });
    const resetToken = tokenIn(mail.last(email));
    expect((await post('verify-email', { token: resetToken })).status).toBe(400);
    // Expired.
    now += TOKEN_TTL_MS.VERIFY_EMAIL + 1000;
    const late = await post('verify-email', { token });
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('INVALID_TOKEN');
  });

  it('resending revokes the older link, and unknown addresses get the same quiet answer', async () => {
    const email = freshEmail();
    await register(email);
    const first = tokenIn(mail.last(email));
    const res = await post('resend-verification', { email, turnstileToken: 'human' });
    expect(res.status).toBe(202);
    const second = tokenIn(mail.last(email));
    expect(second).not.toBe(first);
    expect((await post('verify-email', { token: first })).status).toBe(400);
    expect((await post('verify-email', { token: second })).status).toBe(200);

    const before = mail.sent.length;
    const unknown = await post('resend-verification', { email: freshEmail(), turnstileToken: 'human' });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(res.body);
    expect(mail.sent.length).toBe(before); // nothing sent to an address with no account
    // An already verified account gets nothing either.
    await post('resend-verification', { email, turnstileToken: 'human' });
    expect(mail.sent.length).toBe(before);
  });
});

describe('password sign-in', () => {
  it('signs in a verified account and sets a strict cookie', async () => {
    const { email } = await verifiedAccount();
    const res = await login(email.toUpperCase(), STRONG);
    expect(res.status).toBe(200);
    const raw = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(res.body.user).toMatchObject({ email, setupComplete: false, hasPassword: true });
  });

  it('refuses an unverified account, but only after the right password (so it says nothing to a guesser)', async () => {
    const email = freshEmail();
    await register(email);
    const wrong = await login(email, 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_LOGIN');
    const right = await login(email, STRONG);
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(right.headers['set-cookie']).toBeUndefined();
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { email } = await verifiedAccount();
    const wrong = await login(email, 'definitely-wrong');
    const unknown = await login(freshEmail(), 'definitely-wrong');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('locks the account after 5 wrong passwords, even for the right password, then unlocks', async () => {
    const { email } = await verifiedAccount();
    for (let i = 0; i < 5; i++) expect((await login(email, 'wrong-password-x')).status).toBe(401);
    const locked = await login(email, STRONG);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(locked.headers['set-cookie']).toBeUndefined();
    now += 15 * 60_000 + 1000;
    expect((await login(email, STRONG)).status).toBe(200);
    // The failure counter starts again after a success.
    for (let i = 0; i < 4; i++) await login(email, 'wrong-password-x');
    expect((await login(email, STRONG)).status).toBe(200);
  });

  it('limits sign-in attempts per IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await login(freshEmail(), 'whatever-password', ip)).status).toBe(401);
    expect((await login(freshEmail(), 'whatever-password', ip)).status).toBe(429);
  });

  it('a Google-only account cannot be signed into with a password', async () => {
    const email = freshEmail('goog');
    await post('google', { credential: `google|sub-${RUN}-1|${email}|true` });
    const res = await login(email, STRONG);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_LOGIN');
  });
});

describe('forgot and reset password', () => {
  it('answers the same for known and unknown addresses, and only emails real accounts', async () => {
    const { email } = await verifiedAccount();
    const known = await post('forgot-password', { email, turnstileToken: 'human' });
    const before = mail.sent.length;
    const unknown = await post('forgot-password', { email: freshEmail(), turnstileToken: 'human' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(mail.sent.length).toBe(before);
    expect(mail.last(email)!.text).toContain(`${ORIGIN}/reset-password?token=`);
  });

  it('needs the human check', async () => {
    const { email } = await verifiedAccount();
    const before = mail.sent.length;
    expect((await post('forgot-password', { email })).status).toBe(400);
    expect(mail.sent.length).toBe(before);
  });

  it('sets a new password, retires the old one and every older session, and works once', async () => {
    const { email, cookie: oldCookie } = await verifiedAccount();
    expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(200);

    await post('forgot-password', { email, turnstileToken: 'human' });
    const token = tokenIn(mail.last(email));
    const res = await post('reset-password', { token, password: 'a brand new passphrase' });
    expect(res.status).toBe(200);

    expect((await login(email, STRONG)).status).toBe(401); // old password is dead
    expect((await login(email, 'a brand new passphrase')).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401); // other devices signed out
    expect((await request(app).get('/api/auth/me').set('Cookie', cookieOf(res))).status).toBe(200); // this one stays in

    const reuse = await post('reset-password', { token, password: 'yet another passphrase' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('a weak new password does not burn the link', async () => {
    const { email } = await verifiedAccount();
    await post('forgot-password', { email, turnstileToken: 'human' });
    const token = tokenIn(mail.last(email));
    expect((await post('reset-password', { token, password: 'short' })).body.error.code).toBe('WEAK_PASSWORD');
    expect((await post('reset-password', { token, password: 'a good long passphrase' })).status).toBe(200);
  });

  it('refuses an expired link', async () => {
    const { email } = await verifiedAccount();
    await post('forgot-password', { email, turnstileToken: 'human' });
    const token = tokenIn(mail.last(email));
    now += TOKEN_TTL_MS.RESET_PASSWORD + 1000;
    expect((await post('reset-password', { token, password: 'a good long passphrase' })).status).toBe(400);
  });

  it('a newer reset link replaces the older one', async () => {
    const { email } = await verifiedAccount();
    await post('forgot-password', { email, turnstileToken: 'human' });
    const first = tokenIn(mail.last(email));
    await post('forgot-password', { email, turnstileToken: 'human' });
    const second = tokenIn(mail.last(email));
    expect((await post('reset-password', { token: first, password: 'a good long passphrase' })).status).toBe(400);
    expect((await post('reset-password', { token: second, password: 'a good long passphrase' })).status).toBe(200);
  });

  it('unlocks a locked account, and following the emailed link also verifies the address', async () => {
    const email = freshEmail();
    await register(email); // never verified
    await post('forgot-password', { email, turnstileToken: 'human' });
    const token = tokenIn(mail.last(email));
    await post('reset-password', { token, password: 'a good long passphrase' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await login(email, 'a good long passphrase')).status).toBe(200);

    for (let i = 0; i < 5; i++) await login(email, 'wrong-password-x');
    expect((await login(email, 'a good long passphrase')).status).toBe(429);
    await post('forgot-password', { email, turnstileToken: 'human' });
    await post('reset-password', { token: tokenIn(mail.last(email)), password: 'one more good passphrase' });
    expect((await login(email, 'one more good passphrase')).status).toBe(200);
  });

  it('a Google-only account can add a password through the emailed link', async () => {
    const email = freshEmail('goog');
    await post('google', { credential: `google|sub-${RUN}-2|${email}|true` });
    await post('forgot-password', { email, turnstileToken: 'human' });
    await post('reset-password', { token: tokenIn(mail.last(email)), password: 'a good long passphrase' });
    expect((await login(email, 'a good long passphrase')).status).toBe(200);
  });
});

describe('Google sign-in with open sign-up', () => {
  it('links to an existing verified password account and keeps its password', async () => {
    const { email } = await verifiedAccount();
    const res = await post('google', { credential: `google|sub-${RUN}-3|${email}|true` });
    expect(res.status).toBe(200);
    expect((await login(email, STRONG)).status).toBe(200);
  });

  it('retires a password set before the email was proven (pre-registration hijack)', async () => {
    const email = freshEmail('victim');
    await register(email, 'attacker-chosen-password'); // an attacker signs up with the victim address; never verified
    const res = await post('google', { credential: `google|sub-${RUN}-4|${email}|true` }); // the real owner signs in with Google
    expect(res.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toBeNull();
    expect(user.googleSub).toBe(`sub-${RUN}-4`);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await login(email, 'attacker-chosen-password')).status).toBe(401);
  });

  it('refuses a second Google identity on the same address, and unverified Google emails', async () => {
    const email = freshEmail('goog');
    await post('google', { credential: `google|sub-${RUN}-5|${email}|true` });
    const other = await post('google', { credential: `google|sub-${RUN}-6|${email}|true` });
    expect(other.status).toBe(403);
    expect(other.headers['set-cookie']).toBeUndefined();
    expect((await post('google', { credential: `google|sub-${RUN}-7|${freshEmail()}|false` })).status).toBe(403);
  });

  it('respects the account cap for new Google accounts', async () => {
    maxAccounts = await prisma.user.count();
    app = makeApp();
    expect((await post('google', { credential: `google|sub-${RUN}-8|${freshEmail()}|true` })).status).toBe(503);
  });
});

describe('sessions', () => {
  it('a session cookie from before a password reset stops working', async () => {
    const { email, cookie } = await verifiedAccount();
    await prisma.user.update({ where: { email }, data: { sessionVersion: { increment: 1 } } });
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('cross-site writes are still refused for the new routes', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: freshEmail(), password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('deleting your own account', () => {
  const del = (cookie: string, body: object) => request(app).delete('/api/account').set('Cookie', cookie).send(body);

  it('needs a session, the word DELETE, and the current password', async () => {
    const { email, cookie } = await verifiedAccount();
    expect((await request(app).delete('/api/account').send({ confirm: 'DELETE', password: STRONG })).status).toBe(401);
    expect((await del(cookie, { password: STRONG })).status).toBe(400); // no confirmation word
    expect((await del(cookie, { confirm: 'delete', password: STRONG })).status).toBe(400);
    const noPw = await del(cookie, { confirm: 'DELETE' });
    expect(noPw.status).toBe(403);
    expect(noPw.body.error.code).toBe('WRONG_PASSWORD');
    expect((await del(cookie, { confirm: 'DELETE', password: 'wrong-password-x' })).status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull(); // still there
  });

  it('removes the account and its tokens, clears the cookie, and the address can be used again', async () => {
    const { email, cookie } = await verifiedAccount();
    const res = await del(cookie, { confirm: 'DELETE', password: STRONG });
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401); // the old cookie is dead
    expect((await login(email, STRONG)).status).toBe(401);
    expect((await register(email)).status).toBe(202);
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it('a Google-only account deletes with just the confirmation word', async () => {
    const email = freshEmail('goog');
    const signIn = await post('google', { credential: `google|sub-${RUN}-del|${email}|true` });
    expect((await del(cookieOf(signIn), { confirm: 'DELETE' })).status).toBe(204);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('removes only the caller: another account is untouched', async () => {
    const a = await verifiedAccount();
    const b = await verifiedAccount();
    await del(a.cookie, { confirm: 'DELETE', password: STRONG });
    expect(await prisma.user.findUnique({ where: { email: b.email } })).not.toBeNull();
    expect((await request(app).get('/api/auth/me').set('Cookie', b.cookie)).status).toBe(200);
  });
});
