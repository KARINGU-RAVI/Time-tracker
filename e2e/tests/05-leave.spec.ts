import { createAccount, expect, noProblem, test } from '../support';
import type { Page } from '@playwright/test';

const leaveApi = async (page: Page) => (await page.request.get('/api/leave')).json();
const pickDates = async (page: Page, dates: string[]) => {
  await page.getByRole('radio', { name: 'Pick dates' }).click();
  for (const d of dates) {
    await page.getByLabel('Add a date').fill(d);
    await page.getByRole('button', { name: 'Add date' }).click();
  }
};
const applied = (page: Page) => page.getByRole('button', { name: 'Apply leave' });

test.describe('leave', () => {
  test('the Leave screen shows each balance separately', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await noProblem(page);
    await expect(page.getByText('Annual leave (sick + casual)')).toBeVisible();
    await expect(page.getByText('15.75').first()).toBeVisible();
    await expect(page.getByText('2 of 2 remaining')).toBeVisible(); // optional holidays
    await expect(page.getByText('0.5 of 0.5 remaining')).toBeVisible(); // birthday half-day
    await expect(page.getByText(/Up to 5 days per event, separate from annual leave/)).toBeVisible();
    await expect(page.getByText(/You can take them on any dates, not only in a row/)).toBeVisible();
  });

  test('casual leave on dates that are not next to each other: only those days are taken', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await pickDates(page, ['2026-09-18', '2026-09-16']); // added out of order
    await expect(page.getByRole('list', { name: 'Chosen dates' }).getByRole('listitem')).toHaveText(['16 Sep', '18 Sep']);
    await expect(page.getByText(/2\.00 working day\(s\) selected/)).toBeVisible();
    await applied(page).click();
    await expect(page.getByText('Leave recorded for 2 day(s).')).toBeVisible();

    const leave = await leaveApi(page);
    expect(leave.annual.balance).toBe(13.75);
    expect(leave.annual.usedThisYear).toBe(2);
    // 17 Sep, in between, was not touched.
    const between = await (await page.request.get('/api/attendance/2026-09-17')).json();
    expect(between.status).toBeNull();
    await page.goto('/day/2026-09-16');
    await expect(page.getByRole('radio', { name: 'Casual leave', checked: true })).toBeVisible();
  });

  test('a run of days skips the weekend and says so', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2026-09-17');
    await page.getByLabel('To', { exact: true }).fill('2026-09-21');
    await expect(page.getByText(/3\.00 working day\(s\) selected/)).toBeVisible(); // Thu, Fri and Mon
    await expect(page.getByText(/Skipped: 19 Sep \(Weekly off\), 20 Sep \(Weekly off\)/)).toBeVisible();
  });

  test('half day: the first or second half must be chosen, and is remembered', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2026-09-16');
    await page.getByLabel(/Half day/).check();
    await expect(page.getByText('Which half is your leave?')).toBeVisible();
    await expect(page.getByText(/1 of them|0\.50 working day/).or(page.getByText(/0\.50 working day\(s\) selected/))).toBeVisible();
    await expect(applied(page)).toBeDisabled();
    await expect(page.getByText(/Choose the first or second half to continue/)).toBeVisible();
    await page.getByRole('radio', { name: 'First half' }).click();
    await expect(page.getByText('You are on leave in the first half and work the second half.')).toBeVisible();
    await applied(page).click();
    await expect(page.getByText('Leave recorded for 1 day(s).')).toBeVisible();

    const day = await (await page.request.get('/api/attendance/2026-09-16')).json();
    expect(day).toMatchObject({ status: 'CASUAL_LEAVE', dayFraction: 0.5, halfDayPart: 'FIRST' });
    expect(day.day.requiredMinutes).toBe(240);
    expect((await leaveApi(page)).annual.balance).toBe(15.25);
  });

  test('birthday half-day: its own allowance, the half chosen, and a second one is unpaid', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByRole('radio', { name: 'Birthday half-day' }).click();
    await expect(page.getByText(/one date and always half a day/)).toBeVisible();
    await page.getByLabel('From', { exact: true }).fill('2026-09-16');
    await page.getByRole('radio', { name: 'Second half' }).click();
    await applied(page).click();
    await expect(page.getByText('Leave recorded for 1 day(s).')).toBeVisible();
    await expect(page.getByText('0 of 0.5 remaining')).toBeVisible();
    const after = await leaveApi(page);
    expect(after.birthday).toMatchObject({ used: 0.5, remaining: 0 });
    expect(after.annual.balance).toBe(15.75); // the yearly leave is untouched

    // A second one in the same year is offered, but flagged as unpaid, with a message for the manager.
    await page.getByLabel('From', { exact: true }).fill('2026-09-18');
    await page.getByRole('radio', { name: 'First half' }).click();
    await expect(page.getByText(/0\.50 day\(s\) will be unpaid \(salary cut\)\./)).toBeVisible();
    await expect(page.getByText(/my birthday half-day on 18 Sep 2026 \(first half\)/)).toBeVisible();
  });

  test('bereavement: any dates, in several goes, up to five days in total for one event', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('Relation').fill('Grandfather');
    await page.getByRole('button', { name: 'Log' }).click();
    await expect(page.getByText(/Grandfather, .*: 0\/5 days/)).toBeVisible();

    await page.getByRole('radio', { name: 'Bereavement' }).click();
    await expect(applied(page)).toBeDisabled(); // an event must be chosen
    await page.getByLabel('Bereavement event').selectOption({ index: 1 });
    await expect(page.getByText(/You do not have to take all 5 days together/)).toBeVisible();
    await expect(page.getByText(/5 left for this event/)).toBeVisible();

    const take = async (dates: string[]) => {
      await page.getByRole('radio', { name: 'Pick dates' }).click();
      // Clear anything chosen before.
      const chips = page.getByRole('button', { name: /^Remove \d/ });
      while ((await chips.count()) > 0) await chips.first().click();
      for (const d of dates) {
        await page.getByLabel('Add a date').fill(d);
        await page.getByRole('button', { name: 'Add date' }).click();
      }
      await expect(page.getByText(/working day\(s\) selected/)).toBeVisible();
      await applied(page).click();
    };
    await take(['2026-09-16']);
    await expect(page.getByText('Leave recorded for 1 day(s).')).toBeVisible();
    await take(['2026-09-18', '2026-09-22']); // not next to each other
    await expect(page.getByText('Leave recorded for 2 day(s).')).toBeVisible();
    await expect(page.getByText(/Grandfather, .*: 3\/5 days/)).toBeVisible();

    await take(['2026-09-23', '2026-10-05']); // and in another month: days 4 and 5
    await expect(page.getByText(/Grandfather, .*: 5\/5 days/)).toBeVisible();

    // A sixth day is refused, wherever it falls, and nothing changes.
    await take(['2026-10-09']);
    await expect(page.getByText('Bereavement leave is limited to 5 days per event.')).toBeVisible();
    await expect(page.getByText(/Grandfather, .*: 5\/5 days/)).toBeVisible();
    // The yearly leave was never touched.
    expect((await leaveApi(page)).annual.balance).toBe(15.75);
  });

  test('leave from before the start date is saved as earlier leave, lowers the balance, and can be removed', async ({ page }) => {
    await createAccount(page.request); // counting started on 14 Sep
    await page.goto('/leave');
    await page.getByRole('radio', { name: 'Sick leave' }).click();
    await page.getByLabel('From', { exact: true }).fill('2026-09-07');
    await page.getByLabel('To', { exact: true }).fill('2026-09-08');
    await expect(page.getByText(/Dates before 14 Sep are saved as earlier leave/)).toBeVisible();
    await expect(page.getByText('Saved as earlier leave: 7 Sep, 8 Sep')).toBeVisible();
    await applied(page).click();
    await expect(page.getByText(/Leave recorded for 2 day\(s\)\. 2 saved as earlier leave\./)).toBeVisible();

    await expect(page.getByText('Earlier leave you added')).toBeVisible();
    expect((await leaveApi(page)).annual.balance).toBe(13.75);
    // No day record was created for those dates.
    expect((await (await page.request.get('/api/attendance/2026-09-07')).json()).status).toBeNull();

    // The same dates cannot be added twice.
    await page.getByLabel('From', { exact: true }).fill('2026-09-07');
    await page.getByLabel('To', { exact: true }).fill('2026-09-07');
    await expect(page.getByText(/Already added as earlier leave/)).toBeVisible();
    await expect(applied(page)).toBeDisabled();

    // Remove one entry (with the confirmation): the balance comes back.
    await page.getByRole('button', { name: 'Remove earlier leave on 7 Sep' }).click();
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect.poll(async () => (await leaveApi(page)).annual.balance).toBe(14.75);
    await page.getByRole('button', { name: 'Remove earlier leave on 8 Sep' }).click();
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect.poll(async () => (await leaveApi(page)).annual.balance).toBe(15.75);
    await expect(page.getByText('Earlier leave you added')).toHaveCount(0);
  });

  test('a past day after counting started is a normal leave day that can also be changed on the day screen', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByRole('radio', { name: 'Sick leave' }).click();
    await page.getByLabel('From', { exact: true }).fill('2026-09-15');
    await page.getByLabel('To', { exact: true }).fill('2026-09-15');
    await applied(page).click();
    await expect(page.getByText('Leave recorded for 1 day(s).')).toBeVisible();
    await page.goto('/day/2026-09-15');
    await expect(page.getByRole('radio', { name: 'Sick leave', checked: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Working' }).click();
    await page.getByRole('button', { name: 'Save day' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect((await leaveApi(page)).annual.balance).toBe(15.75); // switching it back returns the day
  });

  test('leave beyond the balance is recorded as unpaid, with a warning, a message for the manager and a "manager informed" tick', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2026-10-01');
    await page.getByLabel('To', { exact: true }).fill('2026-11-27');
    const warning = page.getByText(/day\(s\) will be unpaid \(salary cut\)\./);
    await expect(warning).toBeVisible();
    await expect(page.getByText(/You can still save\. Unpaid days are recorded for the month they fall in\./)).toBeVisible();
    await expect(page.getByText('Message to your manager')).toBeVisible();
    await expect(page.getByText(/Hi, I would like to apply for casual leave on 1 Oct 2026 to 27 Nov 2026/)).toBeVisible();
    await page.getByLabel('Manager informed').check();
    await applied(page).click();
    await expect(page.getByText(/Leave recorded for \d+ day\(s\)\./)).toBeVisible(); // saving is never blocked

    const leave = await leaveApi(page);
    expect(Object.keys(leave.lopByMonth).some((m) => m.startsWith('2026-1'))).toBe(true);
    expect(leave.annual.balance).toBe(15.75); // future days are planned: they take from the balance only when the day comes
    const day = await (await page.request.get('/api/attendance/2026-10-01')).json();
    expect(day.managerInformed).toBe(true);
  });

  test('applying is refused for a date in another year, and for a range that is too long', async ({ page }) => {
    await createAccount(page.request);
    await page.goto('/leave');
    await page.getByLabel('From', { exact: true }).fill('2027-01-05');
    await page.getByLabel('To', { exact: true }).fill('2027-01-05');
    await expect(page.getByRole('alert')).toContainText('Leave can only be applied within the current year for now.');
    await expect(applied(page)).toBeDisabled();
    await page.getByLabel('From', { exact: true }).fill('2026-09-24');
    await page.getByLabel('To', { exact: true }).fill('2026-12-31');
    await expect(page.getByRole('alert')).toContainText('Choose a range of at most 60 days.');
  });
});
