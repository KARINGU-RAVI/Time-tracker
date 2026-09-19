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

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// The most commonly used passwords that still satisfy a length-10 rule.
const COMMON = new Set(
  [
    '1234567890', '0123456789', '1234567891', '12345678910', '123456789012', 'password12', 'password123', 'password1234',
    'password01', 'passw0rd123', 'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwertyuiop123', 'iloveyou12', 'iloveyou123',
    'welcome123', 'welcome1234', 'letmein123', 'admin12345', 'administrator', 'abcdefghij', 'abcd123456', 'abc1234567',
    'changeme123', 'changeme12', 'monkey1234', 'dragon1234', 'football12', 'baseball12', 'superman12', 'trustno1234',
    'zxcvbnm123', 'asdfghjkl1', 'asdfghjkl123', 'internet123', 'sunshine123', 'princess123', 'letmein1234', '1q2w3e4r5t',
    '1qaz2wsx3edc', 'qazwsxedc123', 'office12345', 'officehours', 'officehours1', 'timetracker', 'timetracker1',
  ].map((p) => p.toLowerCase()),
);

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'SAME_AS_EMAIL' | 'ONE_CHARACTER_REPEATED';

/** Returns the reasons a password is refused (empty list = acceptable). Shown to the user as a checklist. */
export function passwordProblems(password: string, email?: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN) problems.push('TOO_SHORT');
  if (password.length > PASSWORD_MAX) problems.push('TOO_LONG');
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push('TOO_COMMON');
  if (/^(.)\1+$/.test(password)) problems.push('ONE_CHARACTER_REPEATED');
  if (email) {
    const e = email.toLowerCase();
    if (lower === e || lower === e.split('@')[0]) problems.push('SAME_AS_EMAIL');
  }
  return problems;
}

export const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  TOO_SHORT: `Use at least ${PASSWORD_MIN} characters.`,
  TOO_LONG: `Use at most ${PASSWORD_MAX} characters.`,
  TOO_COMMON: 'That password is too common. Choose another.',
  SAME_AS_EMAIL: 'The password must not be your email address.',
  ONE_CHARACTER_REPEATED: 'The password must not be one repeated character.',
};
