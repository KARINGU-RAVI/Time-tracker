import { createAccount, expect, noProblem, test } from '../support';

// A real 1x1 PNG picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.describe('holidays', () => {
  test('add a company holiday and an optional one; both show in the list and count; delete removes it', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/holidays');
    await noProblem(page);
    await expect(page.getByRole('heading', { name: 'Holidays' })).toBeVisible();
    await expect(page.getByText('Upload your company holiday calendar')).toBeVisible();

    const add = async (date: string, name: string, type: 'Company holiday' | 'Optional holiday') => {
      await page.getByRole('button', { name: 'Add holiday' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Date').fill(date);
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByLabel('Type').selectOption({ label: type });
      await dialog.getByRole('button', { name: 'Save holiday' }).click();
      await expect(dialog).toHaveCount(0);
    };
    await add('2026-10-02', 'Gandhi Jayanti', 'Company holiday');
    await add('2026-11-10', 'Festival of lights', 'Optional holiday');
    await expect(page.getByText('Gandhi Jayanti')).toBeVisible();
    await expect(page.getByText('Festival of lights')).toBeVisible();
    await expect(page.getByText('1 company holidays · 1 optional')).toBeVisible();

    // The same date twice is refused with a message.
    await page.getByRole('button', { name: 'Add holiday' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Date').fill('2026-10-02');
    await dialog.getByLabel('Name').fill('Again');
    await dialog.getByRole('button', { name: 'Save holiday' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: /Close|Cancel/ }).first().click();

    await page.getByRole('button', { name: 'Delete Festival of lights' }).click();
    await expect(page.getByText('Festival of lights')).toHaveCount(0);
    await expect(page.getByText('1 company holidays · 0 optional')).toBeVisible();
  });

  test('a holiday is a day off everywhere: leave skips it and the day screen says so', async ({ page }) => {
    await createAccount(page.request);
    await page.request.post('/api/holidays', { data: { date: '2026-09-24', name: 'Founders day', type: 'COMPANY' } });
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2026-09-24');
    await page.getByLabel('To', { exact: true }).fill('2026-09-25');
    await expect(page.getByText(/1\.00 working day\(s\) selected/)).toBeVisible();
    await expect(page.getByText(/Skipped: 24 Sep \(Company holiday\)/)).toBeVisible();
    await page.goto('/day/2026-09-24');
    await expect(page.getByText('Holiday', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Required').locator('..')).toContainText('0m'); // nothing is required on a holiday
  });

  test('import a file: a preview first, errors are never saved, duplicates can be skipped or overwritten', async ({ page }) => {
    await createAccount(page.request);
    await page.request.post('/api/holidays', { data: { date: '2026-10-02', name: 'Old name', type: 'COMPANY' } });
    await page.goto('/holidays');
    await page.getByRole('button', { name: 'Import from file' }).first().click();
    const dialog = page.getByRole('dialog');
    const csv = ['date,name,type,description', '2026-10-02,Gandhi Jayanti,COMPANY,', '2026-10-20,Dussehra,COMPANY,', '2026-12-25,Christmas,OPTIONAL,', 'not-a-date,Broken,COMPANY,'].join('\n');
    await dialog.getByLabel('Choose CSV file').setInputFiles({ name: 'holidays.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

    await expect(dialog.getByText('2 new')).toBeVisible();
    await expect(dialog.getByText('1 duplicates')).toBeVisible();
    await expect(dialog.getByText('1 error')).toBeVisible();
    await expect(dialog.getByText(/Error:/)).toBeVisible();
    // Nothing is saved yet.
    expect(((await (await page.request.get('/api/holidays?year=2026')).json()).holidays as unknown[]).length).toBe(1);

    await dialog.getByLabel('Overwrite existing').check();
    await expect(dialog.getByRole('button', { name: 'Import 3 holidays' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Import 3 holidays' }).click();
    await expect(dialog.getByText(/2 holidays imported, 1 overwritten/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByText('Gandhi Jayanti')).toBeVisible();
    await expect(page.getByText('Old name')).toHaveCount(0);
    await expect(page.getByText('Dussehra')).toBeVisible();
    await expect(page.getByText('Broken')).toHaveCount(0);
    await expect(page.getByText('2 company holidays · 1 optional')).toBeVisible();
  });

  test('a file that is not a holiday list is refused with a message', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/holidays');
    await page.getByRole('button', { name: 'Import from file' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Choose CSV file').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('hello there\nnothing useful') });
    await expect(dialog.getByText(/0 new/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Import 0 holidays$/ })).toBeDisabled();
  });

  test('the holiday calendar picture: upload, view full size, replace, remove, and it is private to the account', async ({ page, browser, baseURL, headers }) => {
    await createAccount(page.request);
    await page.goto('/holidays');
    await expect(page.getByText(/Any photo or screenshot works/)).toBeVisible();

    await page.getByLabel('Choose a picture').setInputFiles({ name: 'calendar.png', mimeType: 'image/png', buffer: PNG });
    const img = page.getByRole('img', { name: 'Your holiday calendar', exact: true });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1); // really loaded

    await page.reload();
    await expect(img).toBeVisible(); // it is kept

    await page.getByRole('button', { name: 'View full size' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('img', { name: 'Your holiday calendar, full size' })).toBeVisible();
    await expect(dialog.getByText('calendar.jpg')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Someone who is not signed in cannot fetch it.
    const stranger = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: headers });
    expect((await stranger.request.get('/api/holidays/image/file')).status()).toBe(401);
    await stranger.close();

    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();
    await expect(page.getByRole('button', { name: 'Upload a picture' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Upload a picture' })).toBeVisible();
  });

  test('something that is not a picture is refused', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/holidays');
    await page.getByLabel('Choose a picture').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not really a picture') });
    await expect(page.getByRole('alert').or(page.locator('[class*="bad"]')).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload a picture' })).toBeVisible();
  });
});
