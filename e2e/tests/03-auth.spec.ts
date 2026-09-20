import { createAccount, expect, mailLink, PASSWORD, signInWithForm, test, uniqueEmail } from '../support';

test.describe('signing in, signing out and passwords', () => {
  test('a wrong password shows one plain message, and the right one opens the app', async ({ page, request }) => {
    const account = await createAccount(request);
    await page.goto('/signin');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(/Email or password is incorrect\./);
    // The same message for an account that does not exist.
    await page.getByLabel('Email').fill(uniqueEmail('ghost'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(/Email or password is incorrect\./);

    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await expect(page).toHaveURL('/');
  });

  test('the sign-in cookie cannot be read by page scripts, and signing out ends the session', async ({ page, context, request }) => {
    const account = await createAccount(request);
    await signInWithForm(page, account);
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === 'oht_session');
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');
    expect(await page.evaluate(() => document.cookie)).not.toContain('oht_session');

    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Track your working hours, leave and balance.' })).toBeVisible();
    for (const path of ['/', '/leave', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('timer')).toHaveCount(0);
    }
    expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  });

  test('after five wrong passwords the account waits, even for the right password', async ({ page, request }) => {
    const account = await createAccount(request);
    await page.goto('/signin');
    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Email').fill(account.email);
      await page.getByLabel('Password', { exact: true }).fill(`wrong-password-${i}`);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(/incorrect/);
    }
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(/Too many wrong passwords/);
    await expect(page.getByRole('timer')).toHaveCount(0);
  });

  test('an account that has not verified its email is sent to "check your email" when it signs in', async ({ page, request }) => {
    const email = uniqueEmail('unverified');
    await request.post('/api/auth/register', { data: { email, password: PASSWORD, turnstileToken: 'x' } });
    await signInWithForm(page, { email, password: PASSWORD });
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled(); // a minute must pass before another email
    await expect(page.getByRole('timer')).toHaveCount(0);
  });

  test('forgot password: the emailed link sets a new password, the old one stops working, other devices are signed out', async ({ page, browser, request, baseURL, headers }) => {
    const account = await createAccount(request);

    // A second device is signed in.
    const other = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: headers });
    const otherPage = await other.newPage();
    await signInWithForm(otherPage, account);
    await expect(otherPage.getByRole('timer', { name: 'Worked today' })).toBeVisible();

    // Reset from the first device.
    await page.goto('/signin');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.getByLabel('Email').fill(account.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists for this email, a reset link is on its way.')).toBeVisible();
    const { link, subject } = await mailLink(request, account.email);
    expect(subject).toBe('Reset your Office Hours password');
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase');
    await page.getByLabel('Confirm new password', { exact: true }).fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible(); // signed in with the new password

    // The link cannot be used again: the form opens, and trying it gives the "expired" message.
    await page.goto(link);
    await page.getByLabel('New password', { exact: true }).fill('yet another passphrase');
    await page.getByLabel('Confirm new password', { exact: true }).fill('yet another passphrase');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('This link has expired or was already used.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();

    // The other device was signed out by the reset.
    await otherPage.goto('/');
    await expect(otherPage.getByRole('timer')).toHaveCount(0);
    await expect(otherPage.getByRole('link', { name: 'Sign in' }).first()).toBeVisible(); // the front page, with its sign-in link
    await other.close();

    // The old password is dead; the new one works.
    const fresh = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: headers });
    const freshPage = await fresh.newPage();
    await signInWithForm(freshPage, account);
    await expect(freshPage.getByRole('alert')).toHaveText(/incorrect/);
    await signInWithForm(freshPage, { email: account.email, password: 'a brand new passphrase' });
    await expect(freshPage.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await fresh.close();
  });

  test('a weak new password is refused without using up the reset link', async ({ page, request }) => {
    const account = await createAccount(request);
    await request.post('/api/auth/forgot-password', { data: { email: account.email, turnstileToken: 'x' } });
    const { link } = await mailLink(request, account.email);
    await page.goto(link);
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByLabel('Confirm new password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('alert')).toHaveText(/at least 10 characters/i);
    await page.getByLabel('New password', { exact: true }).fill('a good long passphrase');
    await page.getByLabel('Confirm new password', { exact: true }).fill('a good long passphrase');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
  });

  test('the address is not case-sensitive, and spaces around it do not matter', async ({ page, request }) => {
    const account = await createAccount(request);
    await signInWithForm(page, { email: `  ${account.email.toUpperCase()}  `, password: account.password });
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
  });
});
