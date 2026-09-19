import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { makeDay, makePeriod, renderAt } from '@/test/utils';
import Summary from './Summary';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

/** The design's example week: 32h required (one leave day), 30h 20m worked, -1h 40m. */
const week = () =>
  makePeriod({
    days: [
      makeDay({ date: '2026-09-14', workedMinutes: 490, balanceMinutes: 10 }),
      makeDay({ date: '2026-09-15', workedMinutes: 480, balanceMinutes: 0 }),
      makeDay({ date: '2026-09-16', kind: 'FULL_LEAVE', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null }),
      makeDay({ date: '2026-09-17', isIncomplete: true, workedMinutes: 440, balanceMinutes: -40 }),
      makeDay({ date: '2026-09-18', isToday: true, workedMinutes: 410, balanceMinutes: -70 }),
      makeDay({ date: '2026-09-19', kind: 'WEEKLY_OFF', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null }),
      makeDay({ date: '2026-09-20', kind: 'WEEKLY_OFF', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null }),
    ],
  });

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
  api.get.mockImplementation(async (url: string) =>
    url === '/summary/week' ? week() : makePeriod({ start: '2026-09-01', end: '2026-09-30', requiredMinutes: 5760, workedMinutes: 5650, balanceMinutes: -110, periodOvertimeMinutes: 0, days: week().days, lopDays: 1.5 }),
  );
});
afterEach(() => vi.useRealTimers());

const open = () => renderAt('/summary', '/summary', <Summary />);

describe('Summary', () => {
  it('shows the week totals from the design example', async () => {
    open();
    expect(await screen.findAllByText('Required')).toHaveLength(2); // stat card + table header
    expect(screen.getByText('32h 00m')).toBeInTheDocument();
    expect(screen.getByText('30h 20m')).toBeInTheDocument();
    expect(screen.getByText('-1h 40m')).toBeInTheDocument();
    expect(screen.getByText('Weekly overtime')).toBeInTheDocument();
    expect(screen.getByText(/Required is 32h 00m because of 1 leave\/holiday day/)).toBeInTheDocument();
    expect(screen.getByText(/14 Sep .* 20 Sep 2026/)).toBeInTheDocument();
  });

  it('lists each day with status, worked, required and balance', async () => {
    open();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + 7 days
    expect(rows).toHaveLength(8);
    const mon = within(rows[1]!);
    expect(mon.getByText('Mon 14 Sep')).toBeInTheDocument();
    expect(mon.getByText('Target met')).toBeInTheDocument();
    expect(mon.getByText('8h 10m')).toBeInTheDocument();
    expect(mon.getByText('+10m')).toBeInTheDocument();

    const wed = within(rows[3]!);
    expect(wed.getByText('Leave')).toBeInTheDocument();
    expect(wed.getByText('n/a')).toBeInTheDocument(); // no balance on a leave day

    const thu = within(rows[4]!);
    expect(thu.getByText('Needs fix')).toBeInTheDocument();
    expect(thu.getByText('Missing OUT time')).toBeInTheDocument();
    expect(thu.getByText('-40m')).toBeInTheDocument();

    expect(within(rows[5]!).getByText('In progress')).toBeInTheDocument();
  });

  it('never shows a leave or weekly-off day as short', async () => {
    open();
    const table = await screen.findByRole('table');
    expect(within(table).queryByText('Short')).not.toBeInTheDocument();
    expect(within(table).getAllByText('Weekly off')).toHaveLength(2);
  });

  it('shows the counts and the reminder that only the weekly balance counts', async () => {
    open();
    expect(await screen.findByText('Working 4')).toBeInTheDocument();
    expect(screen.getByText('Leave 1')).toBeInTheDocument();
    expect(screen.getByText('Weekly off 2')).toBeInTheDocument();
    expect(screen.getByText(/Only the weekly balance counts/)).toBeInTheDocument();
  });

  it('moves a week back', async () => {
    open();
    await screen.findByRole('table');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous week' }));
    expect(api.get).toHaveBeenCalledWith('/summary/week', { date: '2026-09-11' });
  });

  it('switches to the month view and shows unpaid days', async () => {
    open();
    await screen.findByRole('table');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'month' }));
    expect(await screen.findByText('September 2026')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/summary/month', { year: 2026, month: 9 });
    expect(await screen.findByText(/Unpaid \(LOP\) this month: 1.5 day/)).toBeInTheDocument();
    // Weekly-off rows are hidden in the month table to keep it readable.
    expect(within(screen.getByRole('table')).queryByText('Weekly off')).not.toBeInTheDocument();
  });

  it('explains a failed load and retries', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    api.get.mockResolvedValue(week());
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
