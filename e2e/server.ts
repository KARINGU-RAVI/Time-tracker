/**
 * End-to-end test server: the REAL API (all routes, real database, real sign-in and cookies) and the REAL built frontend, on one port.
 * The only differences from production are things a browser test cannot do by itself:
 *   - emails are kept in memory (so a test can read the verification link) instead of being sent,
 *   - the human check accepts everything,
 *   - Google is faked (the Google button is not configured in this build anyway),
 *   - a test-only /__test API to read mail, set the clock and clean up. It exists only in this file, never in the deployed app.
 * Run:  npx tsx server.ts   (build the frontend first: npm run build)
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../backend/src/app';
import { MemoryEmailSender } from '../backend/src/email';
import { sessionAuthenticator } from '../backend/src/routes/auth';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../frontend/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('frontend/dist is missing. Run "npm run build" first.');
  process.exit(1);
}
// The database comes from backend/.env (the local test database).
const { config } = await import('dotenv');
config({ path: path.resolve(here, '../backend/.env') });

const PORT = Number(process.env.E2E_PORT ?? 4599);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECRET = 'e2e-secret-that-is-long-enough-to-be-accepted-1234567890';

const prisma = new PrismaClient();
const mail = new MemoryEmailSender();
let offsetMs = 0; // lets a test move the server's clock to a fixed date; time still flows normally from there
const clock = () => Date.now() + offsetMs;

const api = createApp({
  prisma,
  clock,
  authenticate: sessionAuthenticator(prisma, SECRET),
  auth: {
    verifyGoogle: async () => {
      throw new Error('Google is not available in the end-to-end tests');
    },
    sessionSecret: SECRET,
    secureCookies: false,
    appOrigin: ORIGIN,
    email: mail,
    verifyTurnstile: async () => true,
    maxAccounts: 100000,
  },
});

const app = express();
app.disable('x-powered-by');

// ---- test-only helpers -----------------------------------------------------------------
const test = express.Router();
test.use(express.json());
test.get('/mail', (req, res) => {
  const to = String(req.query.to ?? '');
  const m = mail.last(to);
  if (!m) return void res.status(404).json({ error: 'no mail for that address' });
  res.json({ subject: m.subject, text: m.text, link: /https?:\/\/\S+/.exec(m.text)?.[0] ?? null, count: mail.sent.filter((x) => x.to === to).length });
});
test.post('/clock', (req, res) => {
  const iso = (req.body as { iso?: string | null }).iso;
  offsetMs = iso ? Date.parse(iso) - Date.now() : 0;
  res.json({ now: new Date(clock()).toISOString() });
});
test.post('/cleanup', async (req, res) => {
  const prefix = String((req.body as { prefix?: string }).prefix ?? '');
  if (!prefix.startsWith('e2e-')) return void res.status(400).json({ error: 'only e2e- addresses can be removed here' });
  const r = await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  // The per-address counters of the test visitors ("e2e-..." addresses) are removed too.
  await prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "key" LIKE '%:ip:e2e-%'`;
  res.json({ removed: r.count });
});
test.get('/user', async (req, res) => {
  const u = await prisma.user.findUnique({ where: { email: String(req.query.email ?? '') }, select: { id: true, setupCompletedAt: true, emailVerifiedAt: true } });
  res.json(u ?? null);
});
app.use('/__test', test);

// ---- the real app ----------------------------------------------------------------------
app.use(express.static(dist, { index: false }));
app.use(api); // /api/* (anything else falls through to the page below)
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`E2E server on ${ORIGIN}`));
