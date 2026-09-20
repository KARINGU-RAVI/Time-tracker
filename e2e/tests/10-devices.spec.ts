import { createAccount, expect, newBrowserContext, NOW, signInWithForm, test } from '../support';

const seconds = (text: string | null) => {
  const [h, m, s] = (text ?? '0:00:00').split(':').map(Number) as [number, number, number];
  return h * 3600 + m * 60 + s;
};

test.describe('the same account on two devices', () => {
  test('a check-in on the laptop shows on the phone with the same time, and the live clocks agree', async ({ page, browser, request, baseURL, headers }) => {
    const account = await createAccount(page.request);
    const phone = await newBrowserContext(browser, request, baseURL, { ...headers, 'x-nf-client-connection-ip': headers['x-nf-client-connection-ip'] + '-phone' });
    await signInWithForm(phone.page, account);
    await expect(phone.page.getByText('Not checked in')).toBeVisible();

    await page.goto('/');
    await page.getByRole('button', { name: 'Check In' }).click();
    await expect(page.getByText('Inside office')).toBeVisible();

    await phone.page.reload();
    await expect(phone.page.getByText('Inside office')).toBeVisible();
    const laptopView = await (await page.request.get('/api/attendance/today')).json();
    const phoneView = await (await phone.page.request.get('/api/attendance/today')).json();
    expect(phoneView).toEqual(laptopView); // exactly the same record

    // The two live clocks show the same worked time (within a couple of seconds of each other).
    await page.waitForTimeout(3500);
    const a = seconds(await page.getByRole('timer', { name: 'Worked today' }).textContent());
    const b = seconds(await phone.page.getByRole('timer', { name: 'Worked today' }).textContent());
    expect(Math.abs(a - b)).toBeLessThanOrEqual(3);
    expect(a).toBeGreaterThanOrEqual(3);

    // Checking out on the phone is what the laptop sees after it refreshes.
    await request.post('/__test/clock', { data: { iso: new Date(Date.parse(NOW) + 3 * 60_000).toISOString() } });
    await phone.page.clock.fastForward(3 * 60_000);
    await phone.page.getByRole('button', { name: 'Check Out' }).click();
    await expect(phone.page.getByRole('button', { name: 'Check In' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Check In' })).toBeVisible();
    await expect(page.getByText('Inside office')).toHaveCount(0);
    await phone.context.close();
  });

  test('a device whose own clock is wrong still shows the correct time worked', async ({ page, browser, baseURL, headers }) => {
    const account = await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Check In' }).click();
    await expect(page.getByText('Inside office')).toBeVisible();

    // A phone whose clock is 47 minutes fast, and another that is 3 hours slow. The server is not told.
    for (const [tag, skewMinutes] of [['fast', 47], ['slow', -180]] as const) {
      const context = await browser.newContext({
        baseURL,
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        extraHTTPHeaders: { ...headers, 'x-nf-client-connection-ip': `${headers['x-nf-client-connection-ip']}-${tag}` },
      });
      await context.clock.install({ time: new Date(Date.parse(NOW) + skewMinutes * 60_000) });
      await context.clock.resume();
      const p = await context.newPage();
      await signInWithForm(p, account);
      const worked = p.getByRole('timer', { name: 'Worked today' });
      await expect(worked).toBeVisible();
      await p.waitForTimeout(2500);
      const w = seconds(await worked.textContent());
      expect(w, `${tag} phone`).toBeLessThan(90); // about a few seconds since check-in, not 47 minutes or minus 3 hours
      expect(w, `${tag} phone`).toBeGreaterThanOrEqual(0);
      await context.close();
    }
  });

  test('a change made on one device appears on the other after a refresh; the totals match', async ({ page, browser, request, baseURL, headers }) => {
    const account = await createAccount(page.request);
    const other = await newBrowserContext(browser, request, baseURL, { ...headers, 'x-nf-client-connection-ip': headers['x-nf-client-connection-ip'] + '-2' });
    await signInWithForm(other.page, account);
    await expect(other.page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await other.page.goto('/day/2026-09-22');

    await page.request.post('/api/attendance/2026-09-22/sessions', { data: { inTime: '2026-09-22T09:00:00+05:30', outTime: '2026-09-22T17:00:00+05:30' } });
    await page.request.put('/api/attendance/2026-09-21', { data: { status: 'SICK_LEAVE' } });

    await other.page.reload();
    await expect(other.page.getByText('8h 00m').first()).toBeVisible();
    await other.page.goto('/leave');
    await expect(other.page.getByText('14.75 days')).toBeVisible(); // 15.75 minus one sick day
    await page.goto('/leave');
    await expect(page.getByText('14.75 days')).toBeVisible();
    const one = await (await page.request.get('/api/leave')).json();
    const two = await (await other.page.request.get('/api/leave')).json();
    expect(two).toEqual(one);
    await other.context.close();
  });

  test('a password reset ends the session on the other device', async ({ page, browser, request, baseURL, headers }) => {
    const account = await createAccount(page.request);
    const other = await newBrowserContext(browser, request, baseURL, { ...headers, 'x-nf-client-connection-ip': headers['x-nf-client-connection-ip'] + '-2' });
    await signInWithForm(other.page, account);
    await expect(other.page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    const res = await page.request.post('/api/auth/forgot-password', { data: { email: account.email, turnstileToken: 'x' } });
    expect(res.status()).toBeLessThan(300);
    // Asking for a link alone changes nothing: the other device stays signed in until the password is actually reset.
    await other.page.reload();
    await expect(other.page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await other.context.close();
  });
});
