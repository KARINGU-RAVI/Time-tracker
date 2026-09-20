import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { Day } from '@/lib/types';
import { makeDay, makePeriod, renderAt } from '@/test/utils';
import Calendar from './Calendar';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

/** September 2026 the way the design shows it. */
function september(): Day[] {
  const days: Day[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    let day = makeDay({ date, workedMinutes: 480, balanceMinutes: 0 });
    if (weekday === 0 || weekday === 6) day = makeDay({ date, kind: 'WEEKLY_OFF', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null, sessionCount: 0 });
    else if (d === 7) day = makeDay({ date, kind: 'HOLIDAY', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null, sessionCount: 0 });
    else if (d === 8) day = makeDay({ date, kind: 'WFH' });
    else if (d === 11) day = makeDay({ date, workedMinutes: 450, balanceMinutes: -30 });
    else if (d === 16) day = makeDay({ date, kind: 'FULL_LEAVE', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null, sessionCount: 0 });
    else if (d === 17) day = makeDay({ date, isIncomplete: true, workedMinutes: 440, balanceMinutes: -40 });
    else if (d === 18) day = makeDay({ date, isToday: true, workedMinutes: 410, balanceMinutes: -70 });
    else if (d > 18) day = makeDay({ date, isFuture: true, workedMinutes: 0, balanceMinutes: null, sessionCount: 0 });
    days.push(day);
  }
  return days;
}

const totals = makePeriod({
  workedMinutes: 94 * 60 + 10,
  requiredMinutes: 96 * 60,
  balanceMinutes: -110,
  periodOvertimeMinutes: 30,
  counts: { working: 12, wfh: 1, leaveDays: 1, optionalHolidays: 0, bereavementDays: 0, birthdayDays: 0, holidays: 1, weeklyOffs: 8 },
  lopDays: 0,
});

function serve() {
  api.get.mockImplementation(async (url: string) => (url === '/attendance' ? { days: september() } : totals));
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Calendar', () => {
  it('shows the month, the totals strip and every status with text and an icon', async () => {
    serve();
    renderAt('/calendar', '/calendar', <Calendar />);
    expect(await screen.findByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    expect(await screen.findByText('Worked 94h 10m')).toBeInTheDocument();
    expect(screen.getByText('Required 96h 00m')).toBeInTheDocument();
    expect(screen.getByText('Balance -1h 50m')).toBeInTheDocument();
    expect(screen.getByText('Overtime 30m')).toBeInTheDocument();
    expect(screen.getByText('Unpaid (LOP) 0')).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: '2026-09-01: Hours done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-05: Weekly off' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-07: Holiday' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-08: WFH' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-11: Short' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-16: Leave' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-17: Needs fix' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-18: In progress' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-09-22: Upcoming' })).toBeInTheDocument();
  });

  it('opens the day when a date is tapped', async () => {
    serve();
    renderAt('/calendar', '/calendar', <Calendar />);
    expect(await screen.findByRole('link', { name: '2026-09-17: Needs fix' })).toHaveAttribute('href', '/day/2026-09-17');
  });

  it('lays out 5 weeks starting Monday, with 1 Sep under Tuesday', async () => {
    serve();
    renderAt('/calendar', '/calendar', <Calendar />);
    await screen.findByRole('link', { name: '2026-09-01: Hours done' });
    const cells = screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/day/'));
    expect(cells).toHaveLength(30);
    const firstRowHeaders = screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/).slice(0, 7).map((e) => e.textContent);
    expect(firstRowHeaders).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('requests the whole month and moves between months', async () => {
    serve();
    renderAt('/calendar', '/calendar', <Calendar />);
    await screen.findByRole('link', { name: '2026-09-01: Hours done' });
    expect(api.get).toHaveBeenCalledWith('/attendance', { startDate: '2026-09-01', endDate: '2026-09-30' });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/attendance', { startDate: '2026-10-01', endDate: '2026-10-31' }));

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByRole('heading', { name: 'August 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
  });

  it('has a legend for every status', async () => {
    serve();
    renderAt('/calendar', '/calendar', <Calendar />);
    const legend = await screen.findByRole('list', { name: 'Legend' });
    for (const label of ['Hours done', 'Short', 'WFH', 'Leave', 'Holiday', 'Weekly off', 'Needs fix']) {
      expect(legend).toHaveTextContent(label);
    }
  });

  it('explains a failed load and lets you retry', async () => {
    api.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    api.get.mockImplementation(async (url: string) => (url === '/attendance' ? { days: september() } : totals));
    renderAt('/calendar', '/calendar', <Calendar />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: '2026-09-01: Hours done' })).toBeInTheDocument();
  });
});
