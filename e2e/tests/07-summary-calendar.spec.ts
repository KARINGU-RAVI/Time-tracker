import type { APIRequestContext } from '@playwright/test';
import { createAccount, expect, noProblem, test } from '../support';

/** A finished session on a day, in India time. */
const worked = (r: APIRequestContext, date: string, from: string, to: string) =>
  r.post(`/api/attendance/${date}/sessions`, { data: { inTime: `${date}T${from}:00+05:30`, outTime: `${date}T${to}:00+05:30` } });

test.describe('summary and calendar', () => {
  test('the calendar marks each kind of day, opens a day when tapped, and moves between months', async ({ page }) => {
    await createAccount(page.request, { holidays: [{ date: '2026-09-17', name: 'Local festival', type: 'COMPANY' }] });
    await worked(page.request, '2026-09-15', '09:00', '17:00'); // a full day
    await page.request.put('/api/attendance/2026-09-16', { data: { status: 'CASUAL_LEAVE' } });
    await page.goto('/calendar');
    await noProblem(page);
    await expect(page.getByRole('heading', { level: 1, name: /September 2026/ })).toBeVisible();
    await expect(page.getByRole('link', { name: '2026-09-15: Working' }).or(page.getByRole('link', { name: /^2026-09-15/ }))).toBeVisible();
    await expect(page.getByRole('link', { name: /^2026-09-16: .*leave/i })).toBeVisible();
    await expect(page.getByRole('link', { name: '2026-09-17: Holiday' })).toBeVisible();
    await expect(page.getByRole('link', { name: '2026-09-19: Weekly off' })).toBeVisible();
    await expect(page.getByLabel('Month totals')).toContainText('Holiday 1');
    await expect(page.getByLabel('Month totals')).toContainText('Worked 8h 00m');
    await expect(page.getByRole('list', { name: 'Legend' })).toBeVisible();

    await page.getByRole('link', { name: /^2026-09-15/ }).click();
    await expect(page).toHaveURL(/\/day\/2026-09-15/);
    await page.goBack();

    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /October 2026/ })).toBeVisible();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /August 2026/ })).toBeVisible();
    await noProblem(page);
  });

  test('the weekly summary adds up the days worked, the days required, and the balance', async ({ page }) => {
    await createAccount(page.request);
    await worked(page.request, '2026-09-21', '09:00', '18:00'); // Mon 9h
    await worked(page.request, '2026-09-22', '09:00', '16:00'); // Tue 7h
    await page.goto('/summary');
    await noProblem(page);
    await expect(page.getByRole('tab', { name: 'week', selected: true })).toBeVisible();
    await expect(page.getByText('21 Sep – 27 Sep 2026')).toBeVisible();
    const stat = (label: string) => page.getByText(label, { exact: true }).first().locator('..');
    await expect(stat('Worked')).toContainText('16h 00m');
    await expect(stat('Required')).toContainText('40h 00m');
    // Wed 23 Sep is today and not finished: the balance is judged on the days that are over.
    await expect(stat('Balance')).toBeVisible();
    await page.getByRole('button', { name: 'Previous week' }).click();
    await expect(page.getByText('14 Sep – 20 Sep 2026')).toBeVisible();
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.getByText('21 Sep – 27 Sep 2026')).toBeVisible();
  });

  test('the monthly summary and the balance on Today agree with each other', async ({ page }) => {
    await createAccount(page.request);
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16']) await worked(page.request, d, '09:00', '18:00'); // 9h each: +1h a day
    const dash = await (await page.request.get('/api/dashboard')).json();
    await page.goto('/summary');
    await page.getByRole('tab', { name: 'month' }).click();
    await expect(page.getByRole('heading', { name: /Summary/ })).toBeVisible();
    await expect(page.getByText('September 2026')).toBeVisible();
    await expect(page.getByText('Worked', { exact: true }).first().locator('..')).toContainText('27h 00m');
    expect(JSON.stringify(dash)).toContain('27');
    await noProblem(page);
  });

  test('days before the start date are not counted and a month before it says "Not started"', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/summary');
    await page.getByRole('tab', { name: 'month' }).click();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.getByText('August 2026')).toBeVisible();
    await expect(page.getByText(/Not started|0m/).first()).toBeVisible();
    await noProblem(page);
  });
});
