import type { PrismaClient } from '@prisma/client';
import { ApiError } from './errors';

/**
 * Fixed-window counters kept in the database, because a serverless function has no memory shared
 * between requests. One atomic upsert per check.
 */
export interface Limit {
  key: string;
  max: number;
  windowMs: number;
}

export async function hit(db: PrismaClient, limit: Limit, now: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const start = Math.floor(now / limit.windowMs) * limit.windowMs;
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count")
    VALUES (${limit.key}, ${new Date(start)}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  const count = Number(rows[0]?.count ?? 1);
  return { allowed: count <= limit.max, retryAfterSeconds: Math.max(1, Math.ceil((start + limit.windowMs - now) / 1000)) };
}

/** Throws 429 when any of the limits is exceeded. All are counted, so one noisy caller cannot hide behind another key. */
export async function enforce(db: PrismaClient, limits: Limit[], now: number): Promise<void> {
  let worst = 0;
  for (const l of limits) {
    const r = await hit(db, l, now);
    if (!r.allowed) worst = Math.max(worst, r.retryAfterSeconds);
  }
  if (worst > 0) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait a little and try again.', { retryAfterSeconds: worst });
  }
}

/** Removes counters from windows that ended long ago. Cheap; called occasionally. */
export async function pruneRateLimits(db: PrismaClient, now: number): Promise<void> {
  await db.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(now - 48 * 60 * 60 * 1000) } } });
}
