/**
 * Prepares a picture for upload: any picture the browser can open (JPG, PNG, WebP, GIF, a screenshot, a phone photo) is
 * redrawn on a canvas, scaled down and saved as a JPEG under the size limit. So the person can upload "any type of image"
 * without the server having to accept risky formats.
 */

export const MAX_UPLOAD_BYTES = 900_000; // the server accepts up to 1 MB
export const MAX_SIDE = 1600; // long enough to read a calendar's small print
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

export interface ShrunkImage {
  blob: Blob;
  width: number;
  height: number;
  name: string;
}

export class ImageError extends Error {}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to an <img> element below */
    }
  }
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ImageError('Could not read that file.'));
    r.readAsDataURL(file); // a data: address, so no extra permission is needed by the page's security policy
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new ImageError("This browser can't open that kind of picture. Try a JPG or PNG."));
    el.src = url;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));

/** Longest side at most `maxSide`, never enlarged, never zero. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function shrinkImage(file: File): Promise<ShrunkImage> {
  if (file.size === 0) throw new ImageError('That file is empty.');
  if (file.size > MAX_ORIGINAL_BYTES) throw new ImageError('That picture is too big (over 25 MB). Choose a smaller one.');
  if (file.type && !file.type.startsWith('image/')) throw new ImageError('Choose a picture (JPG, PNG, WebP and similar).');

  const decoded = await decode(file);
  try {
    let { width, height } = fitWithin(decoded.width, decoded.height, MAX_SIDE);
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new ImageError("This browser can't prepare pictures.");
      ctx.fillStyle = '#ffffff'; // transparent parts of a PNG would otherwise turn black in a JPEG
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(decoded.source, 0, 0, width, height);
      for (const quality of [0.85, 0.72, 0.6, 0.48]) {
        const blob = await toBlob(canvas, quality);
        if (!blob) throw new ImageError("This browser can't prepare pictures.");
        if (blob.size <= MAX_UPLOAD_BYTES) {
          return { blob, width, height, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
        }
      }
      // Still too big at the lowest quality: make the picture smaller and try again.
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    throw new ImageError('Could not make that picture small enough. Try a smaller one.');
  } finally {
    decoded.close();
  }
}
