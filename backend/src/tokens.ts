import { createHash, randomBytes } from 'node:crypto';
import type { AuthTokenKind, PrismaClient } from '@prisma/client';

export const TOKEN_TTL_MS: Record<AuthTokenKind, number> = {
  VERIFY_EMAIL: 24 * 60 * 60 * 1000,
  RESET_PASSWORD: 60 * 60 * 1000,
};

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * Creates a single-use link token. Only its SHA-256 is stored, so a database leak cannot be used to
 * verify or reset anyone. Older unused tokens of the same kind for that user are revoked.
 */
export async function issueToken(db: PrismaClient, userId: string, kind: AuthTokenKind, now: number): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.$transaction([
    db.authToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: new Date(now) } }),
    // createdAt comes from the app's clock (not the database's), so it is always consistent with usedAt and expiresAt.
    db.authToken.create({ data: { userId, kind, tokenHash: hash(raw), createdAt: new Date(now), expiresAt: new Date(now + TOKEN_TTL_MS[kind]) } }),
  ]);
  return raw;
}

/**
 * Uses a token exactly once. The single UPDATE ... WHERE usedAt IS NULL makes it atomic, so two
 * simultaneous requests with the same link cannot both succeed. Returns the user id, or null.
 */
export async function consumeToken(db: PrismaClient, raw: string, kind: AuthTokenKind, now: number): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return null;
  const tokenHash = hash(raw);
  const claimed = await db.authToken.updateMany({
    where: { tokenHash, kind, usedAt: null, expiresAt: { gt: new Date(now) } },
    data: { usedAt: new Date(now) },
  });
  if (claimed.count !== 1) return null;
  const row = await db.authToken.findUnique({ where: { tokenHash } });
  return row?.userId ?? null;
}
