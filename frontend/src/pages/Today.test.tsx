import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { Dashboard, Day } from '@/lib/types';
import Today from './Today';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const baseDay = (over: Partial<Day> = {}): Day => ({
  date: '2026-09-18',
  kind: 'WORKING',
  isToday: true,
  isFuture: false,
  requiredMinutes: 480,
  workedMinutes: 415,
  offDayWorkedMinutes: 0,
  outsideMinutes: 45,
  sessionCount: 2,
  firstIn: null,
  firstInClock: '08:02',
  lastOut: null,
  lastOutClock: '11:30',
  balanceMinutes: -65,
  overtimeMinutes: 0,
  isInside: true,
  isIncomplete: false,
  isUnrecorded: false,
  leaveUse: null,
  warnings: [],
  ...over,
});

function dashboard(over: Partial<Dashboard['today']> = {}, alerts: Dashboard['alerts'] = { incompleteDates: [], unrecordedDates: [] }): Dashboard {
  return {
    now: new Date().toISOString(),
    trackingStartDate: '2026-09-01',
    today: {
      ...baseDay(),
      sessions: [
        { id: 's1', inTime: '2026-09-18T02:32:00Z', inClock: '08:02', outTime: '2026-09-18T06:00:00Z', outClock: '11:30' },
        { id: 's2', inTime: '2026-09-18T06:45:00Z', inClock: '12:15', outTime: null, outClock: null },
      ],
      live: { status: 'INSIDE', remainingMinutes: 65, expectedOutAt: null, expectedOutClock: '4:47 PM', ifCheckInNowOutClock: null },
      message: 'You need 1h 05m more.',
      ...over,
    },
    week: {
      start: '2026-09-14', end: '2026-09-20', throughDate: '2026-09-20', requiredMinutes: 1920, requiredFullPeriodMinutes: 1920,
      workedMinutes: 1820, balanceMinutes: -100, periodOvertimeMinutes: 0, dailyOvertimeMinutes: 0, offDayWorkedMinutes: 0,
      counts: { working: 4, wfh: 0, leaveDays: 1, optionalHolidays: 0, bereavementDays: 0, holidays: 0, weeklyOffs: 2 },
      incompleteDates: [], unrecordedDates: [], days: [baseDay({ date: '2026-09-14', isToday: false })], nudge: "1h 40m left to reach this week's target.",
    },
    leave: { annualBalance: 12.75, optionalRemaining: 1, nextCredit: { date: '2026-10-01', days: 1.75 }, yearEnd: null },
    alerts,
  };
}

function renderToday() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Today />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
});

describe('Today', () => {
  it('shows worked time, remaining time, expected OUT and the message', async () => {
    api.get.mockResolvedValue(dashboard());
    renderToday();
    expect(await screen.findByLabelText('Worked today')).toHaveTextContent('6h 55m');
    expect(screen.getByText('8h 00m')).toBeInTheDocument();
    expect(screen.getByText('4:47 PM')).toBeInTheDocument();
    expect(screen.getByText('You need 1h 05m more.')).toBeInTheDocument();
    expect(screen.getByText('Inside office')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check out/i })).toBeInTheDocument();
    expect(screen.getByText('Outside 45m')).toBeInTheDocument();
    expect(screen.getByText(/Annual leave 12.75/)).toBeInTheDocument();
  });

  it('offers Check In when outside and never shows a Check Out button', async () => {
    api.get.mockResolvedValue(
      dashboard({ isInside: false, workedMinutes: 208, live: { status: 'OUTSIDE', remainingMinutes: 272, expectedOutAt: null, expectedOutClock: null, ifCheckInNowOutClock: '5:37 PM' } }),
    );
    renderToday();
    expect(await screen.findByRole('button', { name: /check in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument();
    expect(screen.getByText('5:37 PM')).toBeInTheDocument();
    expect(screen.getByText('Outside')).toBeInTheDocument();
  });

  it('sends a check-out request and cannot be double-submitted', async () => {
    api.get.mockResolvedValue(dashboard());
    api.post.mockImplementation(() => new Promise(() => {})); // stays pending
    renderToday();
    const button = await screen.findByRole('button', { name: /check out/i });
    const user = userEvent.setup();
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/attendance/check-out');
    expect(screen.getByRole('button', { name: /checking out/i })).toBeDisabled();
  });

  it('shows the server message when check-out is refused', async () => {
    api.get.mockResolvedValue(dashboard());
    api.post.mockRejectedValue(new ApiError('OPEN_SESSION_FROM_PAST', 'Your session from 2026-09-17 16:45 has no OUT time. Enter the real OUT time.', 409, { date: '2026-09-17' }));
    renderToday();
    await userEvent.setup().click(await screen.findByRole('button', { name: /check out/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has no OUT time');
    expect(screen.getByRole('link', { name: 'Fix it' })).toHaveAttribute('href', '/day/2026-09-17');
  });

  it('flags unclosed and unrecorded days with links to fix them', async () => {
    api.get.mockResolvedValue(dashboard({}, { incompleteDates: ['2026-09-17'], unrecordedDates: ['2026-09-15', '2026-09-16'] }));
    renderToday();
    expect(await screen.findByText(/Thu 17 Sep has no OUT time/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix it' })).toHaveAttribute('href', '/day/2026-09-17');
    expect(screen.getByText(/2 working days have no record/)).toBeInTheDocument();
  });

  it('shows no missing-hours warning on a holiday', async () => {
    api.get.mockResolvedValue(
      dashboard({ kind: 'HOLIDAY', requiredMinutes: 0, workedMinutes: 0, isInside: false, sessionCount: 0, balanceMinutes: null, sessions: [], live: { status: 'NO_WORK_REQUIRED', remainingMinutes: 0, expectedOutAt: null, expectedOutClock: null, ifCheckInNowOutClock: null } }),
    );
    renderToday();
    expect(await screen.findByText('No work today')).toBeInTheDocument();
    expect(screen.queryByText(/You need/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Worked today')).not.toBeInTheDocument();
  });

  it('explains a failed load and lets you retry', async () => {
    api.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    api.get.mockResolvedValueOnce(dashboard());
    renderToday();
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Worked today')).toBeInTheDocument();
  });

  it('before the tracking start date there are no buttons, only an explanation', async () => {
    api.get.mockResolvedValue(
      dashboard({ kind: 'BEFORE_TRACKING', requiredMinutes: 0, workedMinutes: 0, isInside: false, sessionCount: 0, balanceMinutes: null, sessions: [] }),
    );
    renderToday();
    expect(await screen.findByText('Tracking starts on Tue, 1 Sep 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument();
    expect(screen.queryByText('No work is required today.')).not.toBeInTheDocument();
  });
});
