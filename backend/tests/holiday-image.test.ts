import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';
import { createApp } from '../src/app';
import { devAuthenticator } from '../src/auth';
import { MAX_IMAGE_BYTES, sniffImageType } from '../src/routes/holidayImage';
import { seedOwner } from '../prisma/seed-lib';

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const emails: string[] = [];
let seq = 0;
const NOW = istInstant('2026-09-23', '10:00');

// Real, tiny files (only the start of the file matters to the server's type check).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(30, 3)]);

async function account() {
  const email = `img-${RUN}-${++seq}@example.test`;
  emails.push(email);
  const user = await seedOwner(prisma, { email, trackingStart: '2026-09-01' });
  return { app: createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) }), id: user.id, email };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

const put = (app: ReturnType<typeof createApp>, body: Buffer | string, type: string, query = 'width=800&height=600&name=holidays.jpg') =>
  request(app).put(`/api/holidays/image?${query}`).set('Content-Type', type).send(body);

describe('the real type of a picture', () => {
  it('recognises PNG, JPEG and WebP by their first bytes, and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull(); // truncated
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull(); // RIFF, but audio
  });
});

describe('uploading, viewing and removing', () => {
  it('starts with none, and stores a picture exactly as sent', async () => {
    const { app } = await account();
    expect((await request(app).get('/api/holidays/image')).body).toEqual({ exists: false });
    expect((await request(app).get('/api/holidays/image/file')).status).toBe(404);

    const res = await put(app, PNG, 'image/png');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exists: true, mimeType: 'image/png', width: 800, height: 600, fileName: 'holidays.jpg', updatedAt: new Date(NOW).toISOString() });

    const meta = await request(app).get('/api/holidays/image');
    expect(meta.body).toMatchObject({ exists: true, mimeType: 'image/png', width: 800, height: 600 });
    expect(meta.body.data).toBeUndefined(); // the picture itself never travels with the details

    const file = await request(app).get('/api/holidays/image/file').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0); // byte for byte
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, no-cache');
    expect(file.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(file.headers['content-disposition']).toBe('inline');
  });

  it.each([
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
    ['image/png', PNG],
  ] as const)('accepts %s', async (type, bytes) => {
    const { app } = await account();
    expect((await put(app, bytes, type)).status).toBe(200);
    expect((await request(app).get('/api/holidays/image')).body.mimeType).toBe(type);
  });

  it('keeps one picture per account: a new one replaces the old', async () => {
    const { app, id } = await account();
    await put(app, PNG, 'image/png');
    await put(app, JPEG, 'image/jpeg', 'width=10&height=20&name=second.jpg');
    expect(await prisma.holidayCalendarImage.count({ where: { userId: id } })).toBe(1);
    const meta = (await request(app).get('/api/holidays/image')).body;
    expect(meta).toMatchObject({ mimeType: 'image/jpeg', width: 10, height: 20, fileName: 'second.jpg' });
  });

  it('removes it, and removing again is harmless', async () => {
    const { app } = await account();
    await put(app, PNG, 'image/png');
    expect((await request(app).delete('/api/holidays/image')).status).toBe(204);
    expect((await request(app).get('/api/holidays/image')).body.exists).toBe(false);
    expect((await request(app).get('/api/holidays/image/file')).status).toBe(404);
    expect((await request(app).delete('/api/holidays/image')).status).toBe(204);
  });

  it('is not mistaken for a holiday id (the route order matters)', async () => {
    const { app } = await account();
    const res = await put(app, PNG, 'image/png');
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/holidays')).status).toBe(200);
  });
});

describe('what is refused', () => {
  it('a file that only claims to be a picture', async () => {
    const { app, id } = await account();
    for (const [body, type] of [
      ['<html><script>alert(1)</script></html>', 'image/png'],
      ['just some text', 'image/jpeg'],
      [PNG, 'image/jpeg'], // a real PNG labelled as something else
      [JPEG, 'image/webp'],
    ] as const) {
      const res = await put(app, body as Buffer | string, type);
      expect(res.status, String(type)).toBe(400);
      expect(res.body.error.code).toBe('NOT_AN_IMAGE');
    }
    expect(await prisma.holidayCalendarImage.count({ where: { userId: id } })).toBe(0);
  });

  it('SVG, GIF and any other type (SVG can carry script)', async () => {
    const { app, id } = await account();
    for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream']) {
      const res = await put(app, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', type);
      expect(res.status, type).toBe(400);
      expect(res.body.error.code).toBe('NO_IMAGE');
    }
    expect(await prisma.holidayCalendarImage.count({ where: { userId: id } })).toBe(0);
  });

  it('an empty upload', async () => {
    const { app } = await account();
    expect((await put(app, Buffer.alloc(0), 'image/png')).status).toBe(400);
  });

  it('a picture over 1 MB, with a clear message, while one just under is fine', async () => {
    const { app, id } = await account();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1, 1)]);
    const res = await put(app, big, 'image/png');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'IMAGE_TOO_LARGE', message: 'The picture is too large. Use one under 1 MB.' });
    expect(await prisma.holidayCalendarImage.count({ where: { userId: id } })).toBe(0);
    const almost = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length - 1, 1)]);
    expect((await put(app, almost, 'image/png')).status).toBe(200);
  });

  it.each([
    ['no size at all', ''],
    ['zero width', 'width=0&height=10'],
    ['a huge height', 'width=10&height=20000'],
    ['text for a size', 'width=abc&height=10'],
    ['a fractional size', 'width=1.5&height=10'],
  ])('bad picture details: %s', async (_name, query) => {
    const { app } = await account();
    expect((await put(app, PNG, 'image/png', query)).status).toBe(400);
  });

  it('a file name can never carry markup', async () => {
    const { app } = await account();
    const res = await put(app, PNG, 'image/png', `width=1&height=1&name=${encodeURIComponent('<script>alert(1)</script>/../x.png')}`);
    expect(res.status).toBe(200);
    expect(res.body.fileName).not.toMatch(/[<>/\\]/);
    expect((await put(app, PNG, 'image/png', `width=1&height=1&name=${encodeURIComponent('\u0000\u0007')}`)).body.fileName).toBeNull();
    expect((await put(app, PNG, 'image/png', `width=1&height=1&name=${'a'.repeat(300)}`)).status).toBe(400); // too long to accept
  });
});

describe('privacy', () => {
  it("one account never sees or removes another's picture", async () => {
    const a = await account();
    const b = await account();
    await put(a.app, PNG, 'image/png');
    expect((await request(b.app).get('/api/holidays/image')).body).toEqual({ exists: false });
    expect((await request(b.app).get('/api/holidays/image/file')).status).toBe(404);
    expect((await request(b.app).delete('/api/holidays/image')).status).toBe(204);
    expect((await request(a.app).get('/api/holidays/image')).body.exists).toBe(true); // A's is still there
    // B saving their own does not touch A's.
    await put(b.app, JPEG, 'image/jpeg');
    expect((await request(a.app).get('/api/holidays/image')).body.mimeType).toBe('image/png');
  });

  it('is locked until setup is finished', async () => {
    const email = `img-nosetup-${RUN}@example.test`;
    emails.push(email);
    await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
    const app = createApp({ prisma, clock: () => NOW, authenticate: devAuthenticator(prisma, email) });
    expect((await request(app).get('/api/holidays/image')).body.error.code).toBe('SETUP_REQUIRED');
    expect((await put(app, PNG, 'image/png')).body.error.code).toBe('SETUP_REQUIRED');
  });

  it('is deleted together with the account', async () => {
    const { app, id, email } = await account();
    await put(app, PNG, 'image/png');
    await prisma.user.delete({ where: { email } });
    expect(await prisma.holidayCalendarImage.count({ where: { userId: id } })).toBe(0);
  });
});

describe('database limits (in case the application ever had a bug)', () => {
  it('refuses empty, oversized, wrongly typed and absurdly sized pictures', async () => {
    const { id } = await account();
    const base = { userId: id, mimeType: 'image/png', data: new Uint8Array(PNG), width: 1, height: 1 };
    await expect(prisma.holidayCalendarImage.create({ data: { ...base, data: new Uint8Array(0) } })).rejects.toThrow(/size_capped/);
    await expect(prisma.holidayCalendarImage.create({ data: { ...base, data: new Uint8Array(MAX_IMAGE_BYTES + 1) } })).rejects.toThrow(/size_capped/);
    await expect(prisma.holidayCalendarImage.create({ data: { ...base, mimeType: 'image/svg+xml' } })).rejects.toThrow(/type_allowed/);
    await expect(prisma.holidayCalendarImage.create({ data: { ...base, width: 0 } })).rejects.toThrow(/dimensions_sane/);
    await expect(prisma.holidayCalendarImage.create({ data: { ...base, height: 10001 } })).rejects.toThrow(/dimensions_sane/);
    await prisma.holidayCalendarImage.create({ data: base });
    await expect(prisma.holidayCalendarImage.create({ data: base })).rejects.toThrow(/Unique constraint/); // one per account
  });
});
