import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from Node's own crypto (no native add-ons to break on Netlify).
 * Stored as "scrypt$N$r$p$salt$hash" so the cost can be raised later without locking anyone out.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time comparison. Returns false (never throws) for a malformed stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20) return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const actual = await derive(password, salt, n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A real hash to compare against when the account does not exist, so response time does not reveal it. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('not-a-real-password-for-timing-only');
  return dummy;
}

export { PASSWORD_MAX, PASSWORD_MESSAGES, PASSWORD_MIN, passwordProblems, type PasswordProblem } from '@oht/engine';
