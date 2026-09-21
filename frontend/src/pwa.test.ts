import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const pub = path.resolve(__dirname, '../public');
const read = (f: string) => readFileSync(path.join(pub, f), 'utf8');
const pngSize = (f: string) => {
  const b = readFileSync(path.join(pub, f));
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('the installable app files', () => {
  const manifest = JSON.parse(read('manifest.webmanifest')) as {
    name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };

  it('has what a phone needs to offer "install"', () => {
    expect(manifest.name).toBe('Office Hours');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // it sits under the icon
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true); // opening the app stays inside its own scope
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('lists icons that exist and are exactly the size they claim', () => {
    const purposes = manifest.icons.map((i) => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable'); // Android crops these into its own shape
    for (const icon of manifest.icons) {
      const [w, h] = pngSize(icon.src.replace(/^\//, ''));
      expect(`${w}x${h}`, icon.src).toBe(icon.sizes);
    }
    expect(manifest.icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(pngSize('icons/apple-touch-icon.png')).toEqual([180, 180]);
  });

  it('is linked from the page, with the phone-specific tags', () => {
    const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('name="theme-color"');
  });

  it('has an offline page that needs no scripts (the site does not allow inline ones)', () => {
    const offline = read('offline.html');
    expect(offline).toContain('You are offline');
    expect(offline).not.toMatch(/<script/i);
    expect(offline).toContain('href="/"');
  });
});

/** Runs the real sw.js file with a fake browser around it. */
function loadWorker(network: (req: unknown) => Promise<unknown>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const stored = new Map<string, Set<string>>([['old-cache', new Set()]]);
  const caches = {
    open: async (name: string) => ({ addAll: async (urls: string[]) => void stored.set(name, new Set(urls)) }),
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
    match: async (url: string) => ({ offlinePage: url }),
  };
  const self = { addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h), skipWaiting: vi.fn(async () => undefined), clients: { claim: vi.fn(async () => undefined) } };
  new Function('self', 'caches', 'fetch', read('sw.js'))(self, caches, network);
  const ask = async (url: string, mode = 'navigate', method = 'GET') => {
    let answer: Promise<unknown> | undefined;
    handlers.fetch!({ request: { url: `https://hours.example${url}`, mode, method }, respondWith: (p: Promise<unknown>) => (answer = p) });
    return answer === undefined ? 'left alone' : await answer;
  };
  return { handlers, stored, self, ask };
}

describe('the service worker', () => {
  it('shows the offline page when a page cannot be opened', async () => {
    const w = loadWorker(async () => Promise.reject(new Error('offline')));
    expect(await w.ask('/leave')).toEqual({ offlinePage: '/offline.html' });
  });

  it('lets a page that opens normally through untouched', async () => {
    const w = loadWorker(async () => ({ ok: 'from the network' }));
    expect(await w.ask('/')).toEqual({ ok: 'from the network' });
  });

  it('never touches the API, files, or anything that is not a page opening (private and time-exact data must never be served from a store)', async () => {
    const fail = vi.fn(async () => Promise.reject(new Error('offline')));
    const w = loadWorker(fail);
    expect(await w.ask('/api/dashboard')).toBe('left alone');
    expect(await w.ask('/api/attendance/check-in', 'cors', 'POST')).toBe('left alone');
    expect(await w.ask('/assets/index-abc.js', 'no-cors')).toBe('left alone');
    expect(await w.ask('/leave', 'navigate', 'POST')).toBe('left alone');
    expect(fail).not.toHaveBeenCalled();
  });

  it('stores only the offline page, and clears out older versions when it takes over', async () => {
    const w = loadWorker(async () => ({}));
    let waited: Promise<unknown> | undefined;
    w.handlers.install!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect([...w.stored.get('office-hours-offline-v1')!]).toEqual(['/offline.html', '/icons/icon-192.png']);
    expect(w.self.skipWaiting).toHaveBeenCalled();
    w.handlers.activate!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect(w.stored.has('old-cache')).toBe(false);
    expect(w.stored.has('office-hours-offline-v1')).toBe(true);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });
});
