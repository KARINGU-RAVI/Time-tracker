import { createAccount, expect, test } from '../support';

test.describe('installable app (PWA)', () => {
  test('the manifest is served correctly and every icon it lists really loads', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('manifest+json');
    const manifest = await res.json();
    for (const icon of manifest.icons as Array<{ src: string; type: string }>) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()['content-type'], icon.src).toBe(icon.type);
    }
    expect((await request.get('/icons/apple-touch-icon.png')).status()).toBe(200);
  });

  test('Chrome itself agrees the app can be installed (no problems reported)', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: Array<{ errorId: string }> };
    // The test browser is a private window, where Chrome never offers to install. Anything else it reports is a real problem.
    expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);
    const app = (await cdp.send('Page.getAppManifest')) as { url: string; errors: Array<{ message: string }>; data?: string };
    expect(app.url).toContain('/manifest.webmanifest');
    expect(app.errors.map((e) => e.message)).toEqual([]);
    const parsed = JSON.parse(app.data ?? '{}') as { name: string; display: string; icons: unknown[] };
    expect(parsed).toMatchObject({ name: 'Office Hours', display: 'standalone' });
    expect(parsed.icons).toHaveLength(3);
  });

  test('the service worker takes over the page', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/sw.js');
    const res = await page.request.get('/sw.js');
    expect(res.headers()['content-type']).toContain('javascript');
  });

  test('with no connection, opening the app shows the friendly offline page, and it works again when the connection is back', async ({ page, context }) => {
    await createAccount(page.request);
    await page.goto('/');
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now under the service worker's control

    await context.setOffline(true);
    await page.goto('/leave');
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    await expect(page.getByText('Your records are safe.')).toBeVisible();

    await context.setOffline(false);
    await page.getByRole('link', { name: 'Try again' }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
  });

  test('when offline, data requests fail honestly: nothing old or made-up is ever shown as if it were current', async ({ page, context }) => {
    await createAccount(page.request);
    await page.goto('/');
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    const outcome = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/dashboard');
        return `answered ${r.status}`;
      } catch {
        return 'failed';
      }
    });
    expect(outcome).toBe('failed'); // not served from any store
    await context.setOffline(false);
  });
});
