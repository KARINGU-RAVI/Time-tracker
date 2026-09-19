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
    expect(screen.queryByText('Only the authorised Google account can sign in.')).not.toBeInTheDocument();
  });

  it('shows the app when a Google session exists', async () => {
    serve('google');
    mount();
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
  });

  it('shows the login page when there is no session, and never the app', async () => {
    serve('401');
    mount();
    expect(await screen.findByRole('heading', { name: 'Office Hours' })).toBeInTheDocument();
    expect(screen.getByText('Only the authorised Google account can sign in.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Worked today')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/dashboard');
  });

  it('tells you when Google sign-in is not configured instead of showing a dead page', async () => {
    serve('401');
    mount();
    expect(await screen.findByText(/VITE_GOOGLE_CLIENT_ID is missing/)).toBeInTheDocument();
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
