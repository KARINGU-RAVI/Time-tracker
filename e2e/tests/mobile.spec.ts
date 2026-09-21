import { createAccount, expect, noProblem, test } from '../support';

test.describe('on a phone', () => {
  test('every screen fits the width, with no sideways scrolling', async ({ page }) => {
    await createAccount(page.request);
    for (const path of ['/', '/calendar', '/leave', '/summary', '/more', '/holidays', '/settings', '/day/2026-09-22']) {
      await page.goto(path);
      await noProblem(page);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} is wider than the screen by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });

  test('the bottom bar moves between the main screens', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    for (const [name, url] of [['Calendar', /\/calendar/], ['Leave', /\/leave/], ['Summary', /\/summary/], ['More', /\/more/], ['Today', /\/$/]] as const) {
      await nav.getByRole('link', { name }).click();
      await expect(page).toHaveURL(url);
    }
  });

  test('check in with a thumb: the main button is big enough to tap', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Check In' });
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(120);
    await button.click();
    await expect(page.getByText('Inside office')).toBeVisible();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
  });

  test('applying leave works on a phone, including choosing the half of the day', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2026-09-16');
    await page.getByLabel(/Half day/).check();
    await page.getByRole('radio', { name: 'Second half' }).click();
    await page.getByRole('button', { name: 'Apply leave' }).click();
    await expect(page.getByText('Leave recorded for 1 day(s).')).toBeVisible();
  });

  test('the More screen tells a phone user how to put the app on the home screen', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/more');
    await expect(page.getByText('Install the app')).toBeVisible();
    await expect(page.getByText(/Install app|Add to Home screen/).first()).toBeVisible();
  });

  test('the front page and the sign-in page are usable on a phone', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/signin');
    await expect(page.getByLabel('Email')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
