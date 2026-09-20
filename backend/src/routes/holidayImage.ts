import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler } from '../http';
import type { AppDeps } from '../app';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 1024 * 1024;

/**
 * The real type of an image, from its first bytes. The label the browser sends is not trusted, so a script or an SVG
 * (which can carry script) cannot be stored by calling it a PNG.
 */
export function sniffImageType(buf: Buffer): (typeof IMAGE_TYPES)[number] | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const meta = z.object({
  width: z.coerce.number().int().min(1).max(10_000),
  height: z.coerce.number().int().min(1).max(10_000),
  name: z.string().max(200).optional(),
});

/** Keeps only printable characters, so a file name can never carry markup or control characters into the page. */
const cleanName = (name: string | undefined) => {
  const s = (name ?? '').replace(/[^\p{L}\p{N} ._()\-]/gu, '').trim().slice(0, 120);
  return s || null;
};

const rawImage = express.raw({ type: [...IMAGE_TYPES], limit: MAX_IMAGE_BYTES });
/** Reads the picture, and answers a too-large one with a message about pictures (not the general upload limit). */
function readImage(req: Request, res: Response, next: NextFunction) {
  rawImage(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
      return next(new ApiError(413, 'IMAGE_TOO_LARGE', 'The picture is too large. Use one under 1 MB.'));
    }
    next(err);
  });
}

/**
 * One picture of the person's holiday calendar, kept so they can look at it in the app. At most one per account.
 * (The browser shrinks it first; the server checks the size and the real type again.)
 */
export function holidayImageRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  router.get(
    '/holidays/image',
    asyncHandler(async (req, res) => {
      const row = await prisma.holidayCalendarImage.findUnique({
        where: { userId: currentUser(req).id },
        select: { mimeType: true, width: true, height: true, fileName: true, updatedAt: true, data: false },
      });
      if (!row) return void res.json({ exists: false });
      res.json({ exists: true, mimeType: row.mimeType, width: row.width, height: row.height, fileName: row.fileName, updatedAt: row.updatedAt.toISOString() });
    }),
  );

  router.get(
    '/holidays/image/file',
    asyncHandler(async (req, res) => {
      const row = await prisma.holidayCalendarImage.findUnique({ where: { userId: currentUser(req).id } });
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'No holiday calendar image has been uploaded.');
      res
        .status(200)
        .set({
          'Content-Type': row.mimeType,
          'Content-Length': String(row.data.length),
          'Content-Disposition': 'inline',
          // Private to the signed-in person; re-checked each time, and never treated as anything but an image.
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        })
        .end(Buffer.from(row.data));
    }),
  );

  router.put(
    '/holidays/image',
    readImage,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const m = meta.parse(req.query);
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new ApiError(400, 'NO_IMAGE', 'Choose a PNG, JPEG or WebP picture.');
      }
      const real = sniffImageType(body);
      if (!real || real !== req.get('content-type')?.split(';')[0]?.trim()) {
        throw new ApiError(400, 'NOT_AN_IMAGE', 'That file is not a valid PNG, JPEG or WebP picture.');
      }
      const now = new Date(clock());
      const data = { mimeType: real, data: new Uint8Array(body), width: m.width, height: m.height, fileName: cleanName(m.name), updatedAt: now };
      await prisma.holidayCalendarImage.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } });
      res.status(200).json({ exists: true, mimeType: real, width: m.width, height: m.height, fileName: data.fileName, updatedAt: now.toISOString() });
    }),
  );

  router.delete(
    '/holidays/image',
    asyncHandler(async (req, res) => {
      await prisma.holidayCalendarImage.deleteMany({ where: { userId: currentUser(req).id } });
      res.status(204).end();
    }),
  );

  return router;
}
