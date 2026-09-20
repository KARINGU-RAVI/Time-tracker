import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitWithin, ImageError, MAX_SIDE, MAX_UPLOAD_BYTES, shrinkImage } from './image';

describe('fitWithin', () => {
  it('scales the long side down to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });
  it('never enlarges a small picture, and never returns a zero size', () => {
    expect(fitWithin(300, 200, 1600)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

/** A stand-in for the browser's canvas: records what was drawn, and reports a blob size chosen by the test. */
function fakeBrowser(sizeFor: (width: number, quality: number) => number, source = { width: 4000, height: 3000 }) {
  const drawn: Array<{ width: number; height: number; fill: string }> = [];
  const closed = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ ...source, close: closed })));
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreate(tag);
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement & { width: number; height: number };
    let fill = '';
    (canvas as { getContext: unknown }).getContext = () => ({
      set fillStyle(v: string) {
        fill = v;
      },
      fillRect: () => undefined,
      drawImage: (_s: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ width: w, height: h, fill }),
    });
    (canvas as { toBlob: unknown }).toBlob = (cb: (b: Blob | null) => void, type: string, quality: number) =>
      cb(new Blob([new Uint8Array(sizeFor(canvas.width, quality))], { type }));
    return canvas;
  }) as typeof document.createElement);
  return { drawn, closed };
}

const file = (name = 'calendar.PNG', type = 'image/png', size = 5000) => new File([new Uint8Array(size)], name, { type });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('shrinkImage', () => {
  it('scales a big picture to the maximum side, saves a JPEG, and names it .jpg', async () => {
    const { drawn, closed } = fakeBrowser(() => 200_000);
    const out = await shrinkImage(file('Company Holidays 2026.PNG'));
    expect(out).toMatchObject({ width: MAX_SIDE, height: 1200, name: 'Company Holidays 2026.jpg' });
    expect(out.blob.type).toBe('image/jpeg');
    expect(out.blob.size).toBe(200_000);
    expect(drawn[0]).toMatchObject({ width: 1600, height: 1200, fill: '#ffffff' }); // white behind transparent parts
    expect(closed).toHaveBeenCalled(); // the decoded picture is released
  });

  it('keeps a small picture at its own size', async () => {
    fakeBrowser(() => 50_000, { width: 800, height: 600 });
    expect(await shrinkImage(file())).toMatchObject({ width: 800, height: 600 });
  });

  it('lowers the quality first when the result is too big', async () => {
    const qualities: number[] = [];
    fakeBrowser((_w, q) => {
      qualities.push(q);
      return q > 0.7 ? MAX_UPLOAD_BYTES + 1 : 300_000;
    });
    const out = await shrinkImage(file());
    expect(qualities).toEqual([0.85, 0.72, 0.6]); // each step lower, stopping at the first that fits
    expect(out.width).toBe(1600); // same size, only the quality dropped
  });

  it('makes the picture smaller when even the lowest quality is too big', async () => {
    fakeBrowser((w) => (w > 1000 ? MAX_UPLOAD_BYTES + 1 : 400_000));
    const out = await shrinkImage(file());
    expect(out.width).toBeLessThanOrEqual(1000);
    expect(out.blob.size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    expect(out.height / out.width).toBeCloseTo(0.75, 1); // same shape
  });

  it('gives up with a clear message when it cannot get small enough', async () => {
    fakeBrowser(() => MAX_UPLOAD_BYTES + 1);
    await expect(shrinkImage(file())).rejects.toThrow('Could not make that picture small enough. Try a smaller one.');
  });

  it('refuses an empty file, a huge file, and something that is not a picture, before doing any work', async () => {
    const { closed } = fakeBrowser(() => 1);
    await expect(shrinkImage(file('a.png', 'image/png', 0))).rejects.toThrow('That file is empty.');
    await expect(shrinkImage({ size: 26 * 1024 * 1024, type: 'image/png', name: 'x.png' } as File)).rejects.toThrow(/too big/);
    await expect(shrinkImage(file('notes.pdf', 'application/pdf'))).rejects.toThrow('Choose a picture');
    await expect(shrinkImage(file('notes.exe', 'application/x-msdownload'))).rejects.toBeInstanceOf(ImageError);
    expect(closed).not.toHaveBeenCalled();
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts a file with no type when the browser can still open it', async () => {
    fakeBrowser(() => 1000, { width: 100, height: 100 });
    expect((await shrinkImage(file('photo', '', 100))).name).toBe('photo.jpg');
  });

  it('tells the person when the browser cannot open the picture at all (for example an unsupported phone format)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('cannot decode'); }));
    // The fallback path uses an <img> element, which in this environment never loads.
    class FailingImage { onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onerror?.()); } }
    vi.stubGlobal('Image', FailingImage);
    await expect(shrinkImage(file('photo.heic', 'image/heic'))).rejects.toThrow("This browser can't open that kind of picture. Try a JPG or PNG.");
  });
});
