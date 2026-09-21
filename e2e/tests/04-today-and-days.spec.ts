import { createAccount, expect, NOW, noProblem, test } from '../support';
import type { Page } from '@playwright/test';

/** Moves the pretend clock forward, on the server and in the browser. */
async function advance(page: Page, minutes: number) {
  await page.request.post('/__test/clock', { data: { iso: new Date(Date.parse(NOW) + minutes * 60_000).toISOString() } });
  await page.clock.fastForward(minutes * 60_000);
}

const TODAY = '2026-09-23'; // the pretend day: Wednesday, 10:00 in India
const timerSeconds = async (text: string | null) => {
  const [h, m, s] = (text ?? '0:00:00').split(':').map(Number) as [number, number, number];
  return h * 3600 + m * 60 + s;
};

test.describe('Today: checking in and out', () => {
  test('a new day starts empty, says what is needed, and when you could leave if you checked in now', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/');
    await noProblem(page);
    await expect(page.getByText('Wed, 23 Sep 2026')).toBeVisible();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toHaveText('0:00:00');
    await expect(page.getByText('Not checked in')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check In' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check Out' })).toHaveCount(0);
    await expect(page.getByText('8h 00m').first()).toBeVisible(); // the day's requirement
    await expect(page.getByText(/If you check in now, you can leave at/)).toBeVisible();
    await expect(page.getByText(/working days have no record/)).toBeVisible(); // 14-22 Sep have nothing recorded yet
    await expect(page.getByText(/Annual leave 15\.75/)).toBeVisible();
  });

  test('check in starts a live clock that counts the seconds, and check out stops it', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Check In' }).click();
    await expect(page.getByText('Inside office')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check Out' })).toBeVisible();
    await expect(page.getByRole('timer', { name: 'This check-in' })).toBeVisible();

    // The seconds really tick: watch the worked time move forward by whole seconds.
    const worked = page.getByRole('timer', { name: 'Worked today' });
    const first = await timerSeconds(await worked.textContent());
    await expect.poll(async () => timerSeconds(await worked.textContent()), { timeout: 8000 }).toBeGreaterThanOrEqual(first + 2);
    // The countdown goes down while the time worked goes up, and they add up to the 8 hours needed.
    const remaining = page.getByRole('timer', { name: 'Time remaining' });
    const w1 = await timerSeconds(await worked.textContent());
    const r1 = await timerSeconds(await remaining.textContent());
    expect(w1 + r1).toBeGreaterThanOrEqual(8 * 3600 - 2);
    expect(w1 + r1).toBeLessThanOrEqual(8 * 3600 + 2);
    await expect(page.getByText(/You can leave at/).first()).toBeVisible();

    // Checking out in the same minute is refused with a clear message, and the person stays checked in.
    await page.getByRole('button', { name: 'Check Out' }).click();
    await expect(page.getByRole('alert')).toContainText('You checked in less than a minute ago. Wait a moment, then check out.');
    await expect(page.getByText('Inside office')).toBeVisible();

    await advance(page, 2);
    await page.getByRole('button', { name: 'Check Out' }).click();
    await expect(page.getByRole('button', { name: 'Check In' })).toBeVisible();
    await expect(page.getByText('Inside office')).toHaveCount(0);
    await expect(page.getByRole('timer', { name: 'Worked today' })).toHaveText(/^0:0[12]:00$/); // two minutes, to the minute
    // Stopped: the same figure a few seconds later.
    const stopped = await worked.textContent();
    await page.waitForTimeout(2500);
    expect(await worked.textContent()).toBe(stopped);
    await expect(page.getByText("Today's entries")).toBeVisible();
  });

  test('checking in twice is not possible, and the state survives a reload', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Check In' }).click();
    await expect(page.getByText('Inside office')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Inside office')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check In' })).toHaveCount(0);
    const again = await page.request.post('/api/attendance/check-in');
    expect(again.status()).toBe(409); // already inside
  });

  test('a time added by hand shows in the list and the total, and an overlap is refused with a clear message', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Add time manually' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add time entry' })).toBeVisible();
    await dialog.getByLabel('IN', { exact: true }).fill('06:00');
    await dialog.getByLabel('OUT', { exact: true }).fill('09:00');
    await expect(dialog.getByText('Duration 3h 00m')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save session' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('timer', { name: 'Worked today' })).toHaveText('3:00:00');
    await expect(page.getByText(/06:00\s*→\s*09:00/)).toBeVisible();

    // An overlapping entry is refused, and nothing is saved.
    await page.getByRole('button', { name: 'Add time manually' }).click();
    await dialog.getByLabel('IN', { exact: true }).fill('08:00');
    await dialog.getByLabel('OUT', { exact: true }).fill('09:30');
    await dialog.getByRole('button', { name: 'Save session' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/overlaps/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toHaveText('3:00:00');
  });

  test('the manual entry opens with the current time filled in, and "still inside" can be saved straight away', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Add time manually' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('IN', { exact: true })).toHaveValue(/^\d{2}:\d{2}$/); // hours and minutes only
    await dialog.getByLabel('Still inside (no OUT yet)').check();
    await expect(dialog.getByRole('button', { name: 'Save session' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Save session' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Inside office')).toBeVisible();
  });

  test('a time in the future is refused', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Add time manually' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('IN', { exact: true }).fill('14:00');
    await dialog.getByLabel('OUT', { exact: true }).fill('15:00');
    await dialog.getByRole('button', { name: 'Save session' }).click();
    await expect(dialog.getByRole('alert')).toContainText('You cannot record a time that has not happened yet.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('timer', { name: 'Worked today' })).toHaveText('0:00:00'); // nothing was saved
  });
});

test.describe('a past day', () => {
  test('two entries make a full day; editing one shows the shortfall; deleting one removes it', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/day/2026-09-22');
    await noProblem(page);
    for (const [inn, out] of [['08:00', '12:00'], ['13:00', '17:00']] as const) {
      await page.getByRole('button', { name: 'Add time entry' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('IN', { exact: true }).fill(inn);
      await dialog.getByLabel('OUT', { exact: true }).fill(out);
      await dialog.getByRole('button', { name: 'Save session' }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.getByText('Outside 1h 00m')).toBeVisible(); // the lunch break between the two entries
    await expect(page.getByText('8h 00m').first()).toBeVisible();
    await expect(page.getByText('Hours done')).toBeVisible();

    // Edit the second entry to end earlier: 30 minutes short.
    await page.getByRole('button', { name: 'Edit session 13:00' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('OUT', { exact: true }).fill('16:30');
    await dialog.getByRole('button', { name: /Save/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('7h 30m').first()).toBeVisible();
    await expect(page.getByText('-30m')).toBeVisible();

    // Delete it (after the confirmation).
    await page.getByRole('button', { name: 'Delete session 13:00' }).click();
    await expect(page.getByText('Delete this entry?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('4h 00m').first()).toBeVisible();
    await expect(page.getByText(/13:00/)).toHaveCount(0);
  });

  test('a day left with no OUT time is flagged on Today and can be fixed', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/day/2026-09-22');
    await page.getByRole('button', { name: 'Add time entry' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('IN', { exact: true }).fill('09:00');
    await dialog.getByLabel('Still inside (no OUT yet)').check();
    await dialog.getByRole('button', { name: 'Save session' }).click();
    await expect(page.getByText('Needs fix')).toBeVisible();

    await page.goto('/');
    await expect(page.getByText(/has no OUT time/)).toBeVisible();
    await page.getByRole('link', { name: 'Fix it' }).first().click();
    await expect(page).toHaveURL(/\/day\/2026-09-22/);
    await page.getByRole('button', { name: 'Add OUT time' }).click();
    const fix = page.getByRole('dialog');
    await fix.getByLabel('OUT', { exact: true }).fill('17:00');
    await fix.getByRole('button', { name: /Save/ }).click();
    await expect(page.getByText('Needs fix')).toHaveCount(0);
    await page.goto('/');
    await expect(page.getByText(/has no OUT time/)).toHaveCount(0);
  });

  test('a day can be marked as leave, with the first or second half, and reopens as it was saved', async ({ page, request }) => {
    await createAccount(page.request);
    await page.goto('/day/2026-09-21');
    await page.getByRole('radio', { name: 'Sick leave' }).click();
    await page.getByLabel(/Half day/).check();
    await expect(page.getByText('Which half is your leave?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save day' })).toBeDisabled(); // a half must be chosen
    await page.getByRole('radio', { name: 'Second half' }).click();
    await page.getByLabel('Notes').fill('Fever');
    await page.getByRole('button', { name: 'Save day' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('radio', { name: 'Sick leave', checked: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Second half', checked: true })).toBeVisible();
    await expect(page.getByLabel('Notes')).toHaveValue('Fever');
    await expect(page.getByText('Half-day leave')).toBeVisible();
    await expect(page.getByText('4h 00m').first()).toBeVisible(); // only the half day's hours are needed
    const leave = await (await page.request.get('/api/leave')).json();
    expect(leave.annual.balance).toBe(15.25); // 15.75 - 0.5
  });

  test('leave cannot be put on a weekend, a day before counting started, or a date that does not exist', async ({ page, request }) => {
    await createAccount(page.request);
    const put = (date: string, body: object) => page.request.put(`/api/attendance/${date}`, { data: body });
    expect((await put('2026-09-19', { status: 'SICK_LEAVE' })).status()).toBe(400); // Saturday
    expect((await put('2026-09-07', { status: 'SICK_LEAVE' })).status()).toBe(400); // before the start
    expect((await put('2026-02-30', { status: 'SICK_LEAVE' })).status()).toBe(400); // not a real date
    await page.goto('/day/2026-09-07');
    await expect(page.getByText(/Not counted/)).toBeVisible();
  });
});
