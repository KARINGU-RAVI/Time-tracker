import { readFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';
import { createAccount, expect, noProblem, signInWithForm, test } from '../support';

const worked = (r: APIRequestContext, date: string, from: string, to: string) =>
  r.post(`/api/attendance/${date}/sessions`, { data: { inTime: `${date}T${from}:00+05:30`, outTime: `${date}T${to}:00+05:30` } });

test.describe('settings and your data', () => {
  test('settings show the account and the work rule, and the theme choice is kept', async ({ page }) => {
    const account = await createAccount(page.request);
    await page.goto('/settings');
    await noProblem(page);
    await expect(page.getByText(account.email)).toBeVisible();
    await expect(page.getByText(/8h per day, 40h per week, Mon, Tue, Wed, Thu, Fri/)).toBeVisible();
    await page.getByRole('radio', { name: 'dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.getByRole('radio', { name: 'dark', checked: true })).toBeVisible();
    await page.getByRole('radio', { name: 'light' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test('a backup can be downloaded, and restoring it brings back what was there, after typing REPLACE', async ({ page }) => {
    await createAccount(page.request);
    await worked(page.request, '2026-09-21', '09:00', '17:00');
    await page.goto('/settings');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup (JSON)' }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const file = await download.path();
    const backup = JSON.parse(await readFile(file!, 'utf8'));
    expect(backup).toBeTruthy();
    await expect(page.getByText('Backup downloaded.')).toBeVisible();

    // Now change things: add another day and delete the first one.
    await worked(page.request, '2026-09-22', '09:00', '13:00');
    const days = await (await page.request.get('/api/attendance?startDate=2026-09-14&endDate=2026-09-27')).json();
    expect(JSON.stringify(days)).toContain('2026-09-22');

    await page.getByLabel('Choose backup file').setInputFiles(file!);
    const dialog = page.getByRole('dialog', { name: 'Restore from backup' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('This replaces ALL your current data with the file.')).toBeVisible();
    await expect(dialog.getByText(/1 day recorded now is not in the backup and will be deleted/)).toBeVisible();
    const go = dialog.getByRole('button', { name: 'Restore and replace everything' });
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Type REPLACE to confirm').fill('replace'); // wrong case does not count
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Type REPLACE to confirm').fill('REPLACE');
    await go.click();
    await expect(dialog.getByText('Restored. All your data now matches the backup.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    const after = JSON.stringify(await (await page.request.get('/api/attendance?startDate=2026-09-14&endDate=2026-09-27')).json());
    expect(after).toContain('2026-09-21');
    expect(after).not.toContain('T13:00:00'); // the day added after the backup is gone
  });

  test('a file that is not a backup is refused and nothing changes', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/settings');
    await page.getByLabel('Choose backup file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('this is not json') });
    await expect(page.getByText('That file is not a readable backup (it is not valid JSON).')).toBeVisible();
    await page.getByLabel('Choose backup file').setInputFiles({ name: 'y.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alert').or(page.locator('[class*="bad"]')).first()).toBeVisible();
  });

  test('a spreadsheet (CSV) report can be downloaded for a range of dates', async ({ page }) => {
    await createAccount(page.request);
    await worked(page.request, '2026-09-21', '09:00', '17:00');
    await page.goto('/settings');
    await page.getByLabel('From', { exact: true }).fill('2026-09-14');
    await page.getByLabel('To', { exact: true }).fill('2026-09-27');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download CSV|Export CSV/ }).click()]);
    expect(download.suggestedFilename()).toMatch(/^office-hours-.*2026-09-14_to_2026-09-27\.csv$/);
    expect(await readFile((await download.path())!, 'utf8')).toContain('2026-09-21');
  });

  test('deleting the account needs the password and the word DELETE, then removes everything', async ({ page, browser, baseURL, headers }) => {
    const account = await createAccount(page.request);
    await worked(page.request, '2026-09-21', '09:00', '17:00');
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
    const go = dialog.getByRole('button', { name: 'Delete everything' });
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
    await expect(go).toBeDisabled(); // the password is needed too
    await dialog.getByLabel('Your password', { exact: true }).fill('the wrong password');
    await go.click();
    await expect(dialog.getByRole('alert').or(dialog.locator('[class*="bad"]')).first()).toBeVisible();
    expect((await page.request.get('/api/dashboard')).status()).toBe(200); // still there

    await dialog.getByLabel('Your password', { exact: true }).fill(account.password);
    await go.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Track your working hours, leave and balance.' })).toBeVisible();

    const fresh = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: headers });
    const p = await fresh.newPage();
    await signInWithForm(p, account);
    await expect(p.getByRole('alert')).toHaveText(/incorrect/); // the account no longer exists
    await fresh.close();
  });
});
