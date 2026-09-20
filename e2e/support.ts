import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** The day the tests pretend it is: Wednesday 23 Sep 2026, 10:00 in India. Time still flows normally from here. */
export const NOW = '2026-09-23T04:30:00Z';
/** The Monday the test accounts start counting on (nine days earlier). */
export const START = '2026-09-14';
export const PASSWORD = 'correct horse battery';

let counter = 0;
export const uniqueEmail = (tag = 'u') => `e2e-${tag}-${Date.now().toString(36)}-${++counter}@example.test`;

export interface Account {
  email: string;
  password: string;
}

/** Pretends it is `iso`, in the browser and on the server. Time keeps flowing from that moment. */
export async function pretendNow(context: BrowserContext, request: APIRequestContext, iso = NOW) {
  await request.post('/__test/clock', { data: { iso } });
  await context.clock.install({ time: new Date(iso) });
  await context.clock.resume();
}

const RUN = Date.now().toString(36);

/** Every test is a different visitor (its own network address), so the app's per-address limits never mix tests up. */
export const ipHeaders = (testId: string) => ({ 'x-nf-client-connection-ip': `e2e-${RUN}-${testId}` });

export const test = base.extend<{ pretend: void; headers: Record<string, string> }>({
  // Sent by the browser, and by `request`, on every call of the test.
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use(ipHeaders(testInfo.testId));
  },
  headers: async ({}, use, testInfo) => {
    await use(ipHeaders(testInfo.testId));
  },
  // Every test starts on the same pretend day, on both the server and the browser.
  pretend: [
    async ({ context, request }, use) => {
      await pretendNow(context, request);
      await use();
      await request.post('/__test/clock', { data: { iso: null } });
    },
    { auto: true },
  ],
});
export { expect };

/** The link in the last email sent to `email`. */
export async function mailLink(request: APIRequestContext, email: string): Promise<{ link: string; token: string; subject: string; count: number }> {
  let last: { link: string | null; subject: string; count: number } | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.get('/__test/mail', { params: { to: email } });
        if (res.status() !== 200) return false;
        last = await res.json();
        return true;
      },
      { message: `an email to ${email}` },
    )
    .toBe(true);
  const link = last!.link!;
  return { link, token: new URL(link).searchParams.get('token') ?? '', subject: last!.subject, count: last!.count };
}

export interface SetupOverrides {
  name?: string;
  start?: string;
  carriedForward?: number;
  annualUsedSoFar?: number;
  optionalUsedSoFar?: number;
  birthdayTaken?: boolean;
  holidays?: Array<{ date: string; name: string; type: 'COMPANY' | 'OPTIONAL' }>;
}

/**
 * Signs a new account up, verifies it and finishes setup, all through the real API.
 * Pass `page.request` (not the separate `request` helper) and the browser is then signed in as that account.
 */
export async function createAccount(request: APIRequestContext, o: SetupOverrides = {}, tag = 'acct'): Promise<Account> {
  const email = uniqueEmail(tag);
  const reg = await request.post('/api/auth/register', { data: { email, password: PASSWORD, turnstileToken: 'x' } });
  expect(reg.status()).toBe(202);
  const { token } = await mailLink(request, email);
  const ver = await request.post('/api/auth/verify-email', { data: { token } });
  expect(ver.status()).toBe(200);
  const done = await request.post('/api/setup/complete', {
    data: {
      acknowledged: true,
      profile: { name: o.name ?? 'E2E Tester' },
      work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: o.start ?? START },
      leave: {
        annualEntitlement: 21,
        accrualPerMonth: 1.75,
        carryForwardCap: 3,
        optionalQuota: 2,
        bereavementDaysPerEvent: 5,
        carriedForward: o.carriedForward ?? 0,
        annualUsedSoFar: o.annualUsedSoFar ?? 0,
        optionalUsedSoFar: o.optionalUsedSoFar ?? 0,
        birthdayQuota: 0.5,
        birthdayTaken: o.birthdayTaken ?? false,
        creditsFromMonth: 1,
      },
      holidays: o.holidays ? { source: 'list', list: o.holidays } : { source: 'none' },
    },
  });
  expect(done.status(), await done.text()).toBe(201);
  return { email, password: PASSWORD };
}

/** A second, separate browser (its own cookies), on the same pretend day. */
export async function newBrowserContext(
  browser: Browser,
  request: APIRequestContext,
  baseURL: string | undefined,
  headers: Record<string, string> = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, locale: 'en-IN', timezoneId: 'Asia/Kolkata', extraHTTPHeaders: headers });
  await pretendNow(context, request);
  return { context, page: await context.newPage() };
}

/** Signs in through the real sign-in form. */
export async function signInWithForm(page: Page, account: Account) {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Every page text a signed-in person should never see while there is a problem. */
export const noProblem = async (page: Page) => {
  await expect(page.getByText('Something went wrong showing this page.')).toHaveCount(0);
  await expect(page.getByText(/Can.t reach the server/)).toHaveCount(0);
};
