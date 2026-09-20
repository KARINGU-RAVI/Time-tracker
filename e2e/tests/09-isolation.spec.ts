import { createAccount, expect, newBrowserContext, noProblem, signInWithForm, test } from '../support';

test.describe('people cannot see each other', () => {
  test('two accounts at once: hours, leave, holidays and pictures stay separate', async ({ page, browser, request, baseURL, headers }) => {
    await createAccount(page.request, { name: 'Asha' });
    await page.request.post('/api/attendance/2026-09-21/sessions', { data: { inTime: '2026-09-21T09:00:00+05:30', outTime: '2026-09-21T17:00:00+05:30' } });
    await page.request.post('/api/holidays', { data: { date: '2026-10-02', name: 'Asha only holiday', type: 'COMPANY' } });
    await page.request.put('/api/attendance/2026-09-16', { data: { status: 'CASUAL_LEAVE' } });

    const { context, page: other } = await newBrowserContext(browser, request, baseURL, { ...headers, 'x-nf-client-connection-ip': headers['x-nf-client-connection-ip'] + '-b' });
    const bob = await createAccount(other.request, { name: 'Bob' });
    await other.goto('/');
    await noProblem(other);

    const bobDays = JSON.stringify(await (await other.request.get('/api/attendance?startDate=2026-09-14&endDate=2026-09-27')).json());
    expect(bobDays).not.toContain('2026-09-21T09');
    expect(((await (await other.request.get('/api/holidays?year=2026')).json()).holidays as unknown[]).length).toBe(0);
    expect((await (await other.request.get('/api/leave')).json()).annual.balance).toBe(15.75);
    expect((await (await other.request.get('/api/holidays/image')).json()).exists).toBe(false);
    expect((await other.request.get('/api/holidays/image/file')).status()).toBe(404);
    await other.goto('/holidays');
    await expect(other.getByText('Asha only holiday')).toHaveCount(0);

    // Bob cannot change Asha's records, even knowing an id.
    const ashaDay = await (await page.request.get('/api/attendance/2026-09-21')).json();
    const sessionId = ashaDay.sessions?.[0]?.id ?? ashaDay.day?.sessions?.[0]?.id;
    expect(sessionId).toBeTruthy();
    expect((await other.request.delete(`/api/sessions/${sessionId}`)).status()).toBe(404);
    const holiday = (await (await page.request.get('/api/holidays?year=2026')).json()).holidays[0];
    expect((await other.request.delete(`/api/holidays/${holiday.id}`)).status()).toBe(404);

    // Asha's data is untouched.
    expect(JSON.stringify(await (await page.request.get('/api/attendance/2026-09-21')).json())).toContain('09:00');
    await page.goto('/holidays');
    await expect(page.getByText('Asha only holiday')).toBeVisible();

    await other.goto('/settings');
    await expect(other.getByText(bob.email)).toBeVisible();
    await context.close();
  });

  test("one person's sign-out does not sign the other out", async ({ page, browser, request, baseURL, headers }) => {
    const a = await createAccount(page.request);
    const { context, page: b } = await newBrowserContext(browser, request, baseURL, { ...headers, 'x-nf-client-connection-ip': headers['x-nf-client-connection-ip'] + '-b' });
    await createAccount(b.request);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('timer')).toHaveCount(0);
    await b.goto('/');
    await expect(b.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await signInWithForm(page, a);
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await context.close();
  });

  test('every page that needs an account refuses a visitor who is not signed in', async ({ page }) => {
    for (const path of ['/dashboard', '/leave', '/holidays', '/attendance/today', '/summary?mode=week', '/holidays/image', '/export/csv']) {
      const res = await page.request.get(`/api${path}`);
      expect(res.status(), path).toBe(401);
    }
    expect((await page.request.get('/api/dashboard')).status()).toBe(401);
    expect((await page.request.get('/api/leave')).status()).toBe(401);
    expect((await page.request.post('/api/attendance/check-in')).status()).toBe(401);
    expect((await page.request.delete('/api/account', { data: { confirm: 'DELETE' } })).status()).toBe(401);
  });

  test('a request from another website is refused (cross-site protection)', async ({ page }) => {
    await createAccount(page.request);
    const res = await page.request.post('/api/attendance/check-in', { headers: { origin: 'https://evil.example' } });
    expect(res.status()).toBe(403);
    const today = await (await page.request.get('/api/attendance/today')).json();
    expect(JSON.stringify(today)).not.toContain('"outTime":null');
  });
});
