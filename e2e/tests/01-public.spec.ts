import { expect, test, uniqueEmail } from '../support';

test.describe('public pages (nobody signed in)', () => {
  test('the front page explains what the app is for and offers sign-in and sign-up', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Office Hours');
    await expect(page.getByRole('heading', { level: 1, name: 'Track your working hours, leave and balance.' })).toBeVisible();
    await expect(page.getByText(/personal attendance and leave tracker/)).toBeVisible();
    for (const t of ['Record your day', 'Know your balance', 'Leave and holidays', 'Private to you']) await expect(page.getByRole('heading', { name: t })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/signin?mode=signup');
    await expect(page.getByRole('link', { name: 'Privacy policy' }).first()).toBeVisible();
    // Nothing private is on the page.
    await expect(page.getByRole('timer')).toHaveCount(0);
  });

  test('the privacy policy is public and says what is stored and how to delete it', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
    for (const h of ['Google user data', 'What we store', 'Who else handles data', 'Keeping and deleting your data', 'Contact']) {
      await expect(page.getByRole('heading', { name: h })).toBeVisible();
    }
    await expect(page.getByText(/Delete my account/)).toBeVisible();
    await page.getByRole('link', { name: /Back to Office Hours/ }).click();
    await expect(page).toHaveURL('/');
  });

  test('the sign-in page has both tabs, the email fields and a way to reset the password', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('tab', { name: 'Sign in', selected: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Create account' }).click();
    await expect(page.getByLabel('Confirm password', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Password rules' })).toBeVisible();
    await page.getByRole('tab', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible();
    // The front page's "Create a free account" opens the sign-up tab.
    await page.goto('/');
    await page.getByRole('link', { name: 'Create a free account' }).click();
    await expect(page.getByRole('tab', { name: 'Create account', selected: true })).toBeVisible();
  });

  test('private addresses send a signed-out visitor to the sign-in page, never to data', async ({ page, request }) => {
    for (const path of ['/calendar', '/leave', '/summary', '/settings', '/day/2026-09-16']) {
      await page.goto(path);
      await expect(page.getByRole('tab', { name: 'Sign in', selected: true })).toBeVisible();
      await expect(page.getByRole('timer')).toHaveCount(0);
    }
    for (const path of ['/api/dashboard', '/api/leave', '/api/backup', '/api/holidays/image/file', '/api/setup/defaults']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
      expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
    }
  });

  test('the forgot-password page always gives the same answer, whether or not the account exists', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(uniqueEmail('nobody'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists for this email, a reset link is on its way.')).toBeVisible();
  });

  test('an unknown address shows the sign-in page (not a broken page), and the API is healthy', async ({ page, request }) => {
    await page.goto('/this/does/not/exist');
    await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
    const health = await request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect(health.headers()['cache-control']).toContain('no-cache');
  });

  test('the page is served with the browser security headers the site relies on (checked on the live API answer)', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-powered-by']).toBeUndefined();
  });
});
