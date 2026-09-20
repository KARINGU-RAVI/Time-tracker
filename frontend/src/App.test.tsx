import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App, { makeQueryClient } from './App';
import { ApiError } from '@/lib/api';
import { makeDay, makePeriod, makeLeave } from '@/test/utils';
import type { Dashboard } from '@/lib/types';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const dashboard = (): Dashboard => ({
  now: new Date().toISOString(),
  trackingStartDate: '2026-09-01',
  today: {
    ...makeDay({ date: '2026-09-18', isToday: true, isInside: false, sessionCount: 0, workedMinutes: 0, balanceMinutes: -480 }),
    sessions: [],
    live: { status: 'NOT_STARTED', remainingMinutes: 480, expectedOutAt: null, expectedOutClock: null, ifCheckInNowOutClock: '4:00 PM' },
    message: 'You need 8h 00m more.',
  },
  week: { ...makePeriod(), nudge: null },
  leave: { annualBalance: 12.75, optionalRemaining: 1, nextCredit: null, yearEnd: null },
  alerts: { incompleteDates: [], unrecordedDates: [] },
});

const rules = { rules: [{ id: 'r', dailyRequiredMinutes: 480, weeklyRequiredMinutes: 2400, halfDayRequiredMinutes: 240, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, effectiveFrom: '2026-09-01', effectiveTo: null }] };

/** Route the mocked API by URL, with the sign-in check configurable. */
function serve(session: 'dev' | 'google' | '401' | 'network') {
  api.get.mockImplementation(async (url: string) => {
    if (url === '/auth/me') {
      if (session === 'dev') throw new ApiError('NOT_FOUND', 'That endpoint does not exist.', 404);
      if (session === '401') throw new ApiError('UNAUTHENTICATED', 'Please sign in.', 401);
      if (session === 'network') throw new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0);
      return { user: { email: 'me@example.test' } };
    }
    if (url === '/dashboard') return dashboard();
    if (url === '/rules') return rules;
    if (url === '/leave') return makeLeave();
    return {};
  });
}

function mount(path = '/') {
  window.history.pushState({}, '', path);
  return render(<App client={makeQueryClient()} />);
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

describe('sign-in gate', () => {
  it('shows the app straight away in dev mode (no sign-in configured)', async () => {
    serve('dev');
    mount();
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows the app when a Google session exists', async () => {
    serve('google');
    mount();
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
  });

  it('shows a public front page that explains the app to visitors who are not signed in, and never the app', async () => {
    serve('401');
    mount();
    expect(await screen.findByRole('heading', { name: 'Track your working hours, leave and balance.' })).toBeInTheDocument();
    expect(screen.getByText(/personal attendance and leave tracker/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/signin?mode=signup');
    expect(screen.getAllByRole('link', { name: /Sign in/ })[0]).toHaveAttribute('href', '/signin');
    expect(screen.getAllByRole('link', { name: /rivacy policy/ }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Worked today')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/dashboard');
  });

  it('shows the login page at /signin, and for any other address when signed out', async () => {
    serve('401');
    const first = mount('/signin');
    expect(await screen.findByRole('heading', { name: 'Office Hours' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sign in', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Worked today')).not.toBeInTheDocument();
    first.unmount();
    mount('/calendar');
    expect(await screen.findByRole('tab', { name: 'Sign in', selected: true })).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/dashboard');
  });

  it('opens on the Create account tab from the front-page button', async () => {
    serve('401');
    mount('/signin?mode=signup');
    expect(await screen.findByRole('tab', { name: 'Create account', selected: true })).toBeInTheDocument();
  });

  it('a signed-in person who lands on /signin is sent to the app', async () => {
    serve('google');
    mount('/signin');
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
  });

  it('still offers email sign-in when Google is not configured (no dead page)', async () => {
    serve('401');
    mount('/signin');
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('holds a signed-in account that has not finished setup on the setup wizard, and never loads the app', async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === '/auth/me') return { user: { email: 'new@example.test', name: null, setupComplete: false, isAdmin: false, hasPassword: true } };
      if (url === '/setup/defaults') return { alreadyComplete: false, today: '2026-09-19', profile: { name: '' }, work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-21' }, leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0, creditsFromMonth: 1 }, holidays: { companyCount: 0 } };
      throw new Error(`unexpected ${url}`);
    });
    mount();
    expect(await screen.findByRole('heading', { name: 'Set up your account' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Worked today')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/dashboard');
  });

  it('shows the privacy policy to anyone, signed in or not', async () => {
    serve('401');
    const first = mount('/privacy');
    expect(await screen.findByRole('heading', { name: 'Privacy policy' })).toBeInTheDocument();
    expect(screen.getByText(/Delete my account/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'karinguravi307@gmail.com' })).toHaveAttribute('href', 'mailto:karinguravi307@gmail.com');
    first.unmount();
    serve('google');
    mount('/privacy');
    expect(await screen.findByRole('heading', { name: 'Privacy policy' })).toBeInTheDocument();
  });

  it('links to the privacy policy from the sign-in page', async () => {
    serve('401');
    mount('/signin');
    expect(await screen.findByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  });

  it('opens the forgot-password page while signed out', async () => {
    serve('401');
    mount('/forgot-password');
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  });

  it('the emailed verification link works while signed out and uses its token exactly once', async () => {
    api.post.mockResolvedValue({});
    serve('401');
    mount('/verify-email?token=abc123');
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/auth/verify-email', { token: 'abc123' });
  });

  it('explains a network failure during the sign-in check and retries', async () => {
    serve('network');
    mount();
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    serve('dev');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
  });

  it('shows a friendly page for an unknown address', async () => {
    serve('dev');
    mount('/nowhere');
    expect(await screen.findByText('That page does not exist.')).toBeInTheDocument();
  });
});

describe('navigation shell', () => {
  it('has the five main destinations for phone and desktop, and marks the current one', async () => {
    serve('dev');
    mount();
    await screen.findByLabelText('Worked today');
    const navs = screen.getAllByRole('navigation', { name: 'Main' });
    expect(navs).toHaveLength(2); // desktop sidebar + phone tab bar
    for (const nav of navs) {
      for (const label of ['Today', 'Calendar', 'Leave', 'Summary', 'More']) {
        expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
      }
      expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    }
  });

  it('navigates between screens', async () => {
    serve('dev');
    mount();
    await screen.findByLabelText('Worked today');
    await userEvent.setup().click(within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: 'More' }));
    expect(await screen.findByRole('heading', { name: 'More' })).toBeInTheDocument();
    const page = within(screen.getByRole('main'));
    expect(page.getByRole('link', { name: /Holidays/ })).toHaveAttribute('href', '/holidays');
    expect(page.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '/settings');
  });

  it('shows an offline banner while the device is offline and hides it when back online', async () => {
    serve('dev');
    mount();
    await screen.findByLabelText('Worked today');
    expect(screen.queryByText(/You are offline/)).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(screen.queryByText(/You are offline/)).not.toBeInTheDocument());
  });
});

describe('Settings', () => {
  it('shows the work rule in plain words and the data actions', async () => {
    serve('dev');
    mount('/settings');
    expect(await screen.findByText(/8h per day, 40h per week, Mon, Tue, Wed, Thu, Fri, week starts Monday, effective from 2026-09-01/)).toBeInTheDocument();
    expect(screen.getByText(/Development mode: sign-in is off/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export backup (JSON)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restore from backup' })).toBeEnabled();
  });

  it('switches the theme and remembers it', async () => {
    serve('dev');
    mount('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('oht-theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('oht-theme')).toBe('light');
  });

  it('signs out through the API when a Google session is active', async () => {
    serve('google');
    api.post.mockResolvedValue(undefined);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true, configurable: true });
    mount('/settings');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/logout'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
});
