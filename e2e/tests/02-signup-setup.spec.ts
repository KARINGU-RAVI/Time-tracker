import { expect, mailLink, PASSWORD, START, test, uniqueEmail } from '../support';

test.describe('creating an account, from the sign-up form to the first screen', () => {
  test('sign up, verify by email, set up (with the opening leave position), and land on Today', async ({ page, request }) => {
    const email = uniqueEmail('signup');

    // 1. Sign up.
    await page.goto('/signin?mode=signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // 2. The verification link in the email signs the person in.
    const { link, subject } = await mailLink(request, email);
    expect(subject).toBe('Verify your email for Office Hours');
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue to setup' }).click();

    // 3. The setup wizard: nothing else is reachable until it is finished.
    await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
    await expect(page.getByText('Step 1 of 5: Profile')).toBeVisible();
    await page.getByLabel('Full name').fill('Playwright Person');
    await page.getByLabel('Employee ID (optional)').fill('E-100');
    await page.getByLabel('Job title (optional)').fill('Engineer');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Step 2 of 5: Work hours')).toBeVisible();
    await expect(page.getByLabel('Daily hours: hours')).toHaveValue('8');
    await expect(page.getByLabel('Weekly hours: hours')).toHaveValue('40');
    await expect(page.getByText('India Standard Time (UTC+05:30)')).toBeVisible();
    await page.getByLabel('Start counting from').fill(START);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Step 3 of 5: Leave')).toBeVisible();
    await page.getByLabel('Leave left over from last year').fill('2');
    await page.getByLabel('Leave already taken this year').fill('5');
    await page.getByLabel('Optional holidays already taken this year').fill('1');
    await page.getByLabel('I have already taken my birthday half-day this year').check();
    // The balance comes from the server and matches the real position: 2 + 9 x 1.75 - 5 = 12.75.
    await expect(page.getByText('12.75 days')).toBeVisible();
    await expect(page.getByText('1 left')).toBeVisible(); // optional holidays
    await expect(page.getByText('0 left')).toBeVisible(); // birthday half-day
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Step 4 of 5: Holidays')).toBeVisible();
    await page.getByRole('radio', { name: /Start empty/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Step 5 of 5: Review')).toBeVisible();
    await expect(page.getByText('Playwright Person')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish setup' })).toBeDisabled(); // needs the acknowledgement
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Finish setup' }).click();

    // 4. The app opens.
    await expect(page.getByRole('timer', { name: 'Worked today' })).toBeVisible();
    await page.getByRole('link', { name: 'Leave' }).first().click();
    await expect(page.getByText('12.75', { exact: false }).first()).toBeVisible();
    const leave = await (await page.request.get('/api/leave')).json();
    expect(leave.annual.balance).toBe(12.75);
    expect(leave.optional).toMatchObject({ used: 1, remaining: 1 });
    expect(leave.birthday).toMatchObject({ used: 0.5, remaining: 0 });

    // 5. Setup can only happen once.
    const again = await page.request.post('/api/setup/complete', { data: { acknowledged: true } });
    expect([400, 409]).toContain(again.status());
  });

  test('a verified account that has not finished setup is held on the wizard, on every address', async ({ page, request }) => {
    const email = uniqueEmail('gate');
    await page.request.post('/api/auth/register', { data: { email, password: PASSWORD, turnstileToken: 'x' } });
    const { token } = await mailLink(request, email);
    expect((await page.request.post('/api/auth/verify-email', { data: { token } })).status()).toBe(200);

    for (const path of ['/', '/leave', '/calendar', '/settings', '/day/2026-09-22']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Set up your account' }), path).toBeVisible();
      await expect(page.getByRole('timer')).toHaveCount(0);
    }
    for (const path of ['/api/dashboard', '/api/leave', '/api/holidays', '/api/backup']) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(403);
      expect((await res.json()).error.code).toBe('SETUP_REQUIRED');
    }
  });

  test('the sign-up form checks the password before anything is sent', async ({ page }) => {
    await page.goto('/signin?mode=signup');
    const rules = page.getByRole('list', { name: 'Password rules' });
    await page.getByLabel('Password', { exact: true }).fill('short');
    await expect(rules).toContainText(/At least 10 characters\s*not met yet/);
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await expect(rules).toContainText(/Not a commonly used password\s*not met yet/);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(rules).toContainText(/At least 10 characters\s*met/);
    await expect(rules).toContainText(/Not a commonly used password\s*met/);

    await page.getByLabel('Email').fill(uniqueEmail('mismatch'));
    await page.getByLabel('Confirm password', { exact: true }).fill('something else entirely');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByText('The two passwords do not match.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  });

  test('signing up with an address that already has an account gives the same answer (no way to find out who is registered)', async ({ page, request }) => {
    const email = uniqueEmail('dup');
    await page.request.post('/api/auth/register', { data: { email, password: PASSWORD, turnstileToken: 'x' } });
    await page.goto('/signin?mode=signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    // The real owner is told by email instead.
    await expect.poll(async () => (await mailLink(request, email)).subject).toBe('You already have an Office Hours account');
  });

  test('an old or wrong verification link says so, and can be used only once', async ({ page, request }) => {
    await page.goto('/verify-email?token=this-is-not-a-real-token-0000000000');
    await expect(page.getByText('This link has expired or was already used.')).toBeVisible();

    const email = uniqueEmail('once');
    await page.request.post('/api/auth/register', { data: { email, password: PASSWORD, turnstileToken: 'x' } });
    const { link } = await mailLink(request, email);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await page.goto(link); // the same link again
    await expect(page.getByText('This link has expired or was already used.')).toBeVisible();
  });
});
