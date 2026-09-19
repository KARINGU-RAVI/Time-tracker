import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { makeDetail, makeLeave, renderAt } from '@/test/utils';
import DayDetail from './DayDetail';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const S = (id: string, inn: string, out: string | null) => ({
  id,
  inTime: `2026-09-17T${inn}:00Z`,
  inClock: inn,
  outTime: out ? `2026-09-17T${out}:00Z` : null,
  outClock: out,
});

/** Thu 17 Sep: two closed sessions and one with no OUT (the design's "needs fix" day). */
const incompleteDay = () =>
  makeDetail(
    { sessions: [S('a', '08:05', '12:35'), S('b', '13:20', '16:10'), S('c', '16:45', null)], status: 'WORKING' },
    { date: '2026-09-17', isIncomplete: true, workedMinutes: 440, balanceMinutes: -40, outsideMinutes: 80, firstInClock: '08:05', lastOutClock: '16:10', sessionCount: 3 },
  );

function serve(detail = incompleteDay(), leave = makeLeave()) {
  api.get.mockImplementation(async (url: string) => (url === '/leave' ? leave : detail));
}

const open = () => renderAt('/day/2026-09-17', '/day/:date', <DayDetail />);

beforeEach(() => Object.values(api).forEach((m) => m.mockReset()));

describe('DayDetail', () => {
  it('shows the day summary, sessions and the outside gaps', async () => {
    serve();
    open();
    expect(await screen.findByText('Thu, 17 Sep 2026')).toBeInTheDocument();
    expect(screen.getByText('Needs fix')).toBeInTheDocument();
    expect(screen.getByText('7h 20m')).toBeInTheDocument(); // worked, counted
    expect(screen.getByText('-40m')).toBeInTheDocument();
    expect(screen.getByText('Outside 45m')).toBeInTheDocument();
    expect(screen.getByText('Outside 35m')).toBeInTheDocument();
    expect(screen.getByText(/No OUT recorded, not counted/)).toBeInTheDocument();
  });

  it('"Add OUT time" opens the editor for the unclosed session', async () => {
    serve();
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Add OUT time' }));
    expect(await screen.findByRole('heading', { name: 'Edit session' })).toBeInTheDocument();
    expect(screen.getByLabelText('IN')).toHaveValue('16:45');
    expect(screen.getByLabelText('Still inside (no OUT yet)')).toBeChecked();
  });

  it('only allows a half day for casual or sick leave', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    open();
    const half = await screen.findByLabelText(/Half day/);
    expect(half).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Casual leave' }));
    expect(half).toBeEnabled();
    await user.click(screen.getByRole('radio', { name: 'Bereavement' }));
    expect(half).toBeDisabled();
  });

  it('saves leave with a half day and manager-informed flag', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    api.put.mockResolvedValue(makeDetail({ status: 'CASUAL_LEAVE', dayFraction: 0.5 }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Casual leave' }));
    await user.click(screen.getByLabelText(/Half day/));
    await user.click(screen.getByLabelText('Manager informed'));
    await user.type(screen.getByLabelText('Notes'), '  Doctor  ');
    await user.click(screen.getByRole('button', { name: 'Save day' }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/attendance/2026-09-17', {
        status: 'CASUAL_LEAVE',
        dayFraction: 0.5,
        notes: 'Doctor',
        managerInformed: true,
        bereavementEventId: null,
      }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('shows the server message when saving is refused', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    api.put.mockRejectedValue(new ApiError('LEAVE_ON_NON_WORKING_DAY', 'Leave cannot be applied on a holiday or weekly off.', 400));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Sick leave' }));
    await user.click(screen.getByRole('button', { name: 'Save day' }));
    expect(await screen.findByText('Leave cannot be applied on a holiday or weekly off.')).toBeInTheDocument();
  });

  it('asks before deleting a session, and deletes only when confirmed', async () => {
    serve();
    api.del.mockResolvedValue(makeDetail());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete session 08:05' }));
    expect(screen.getByText('Delete this session?')).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Delete this session?')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete session 08:05' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/sessions/a'));
  });

  it('bereavement needs an event, and points to the Leave screen when there are none', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    open();
    await userEvent.setup().click(await screen.findByRole('radio', { name: 'Bereavement' }));
    expect(screen.getByLabelText('Bereavement event')).toBeInTheDocument();
    expect(screen.getByText(/Log one on the Leave screen/)).toBeInTheDocument();
  });

  it('bereavement lists existing events and sends the chosen one', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }), makeLeave({ bereavement: { maxDaysPerEvent: 5, events: [{ id: 'e1', relation: 'Family member', startDate: '2026-09-16', note: null, daysUsed: 1 }] } }));
    api.put.mockResolvedValue(makeDetail());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Bereavement' }));
    await user.selectOptions(await screen.findByLabelText('Bereavement event'), 'e1');
    await user.click(screen.getByRole('button', { name: 'Save day' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/attendance/2026-09-17', expect.objectContaining({ status: 'BEREAVEMENT_LEAVE', bereavementEventId: 'e1' })));
  });

  it('flags an unrecorded day and hides "Delete day record" when nothing is stored', async () => {
    serve(makeDetail({ status: null }, { date: '2026-09-17', isUnrecorded: true, workedMinutes: 0, balanceMinutes: -480, sessionCount: 0, firstInClock: null, lastOutClock: null }));
    open();
    expect(await screen.findByText(/No record for this day/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete day record/ })).not.toBeInTheDocument();
    expect(screen.getByText('No sessions recorded.')).toBeInTheDocument();
  });

  it('shows Balance N/A and no missing-hours warning on a holiday', async () => {
    serve(makeDetail({ status: null }, { date: '2026-09-17', kind: 'HOLIDAY', requiredMinutes: 0, workedMinutes: 0, balanceMinutes: null, sessionCount: 0 }));
    open();
    expect(await screen.findByText('Holiday')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.queryByText(/No record for this day/)).not.toBeInTheDocument();
  });

  it('warns that work on a day off is not counted', async () => {
    serve(makeDetail({ status: null }, { date: '2026-09-19', kind: 'WEEKLY_OFF', requiredMinutes: 0, workedMinutes: 0, offDayWorkedMinutes: 120, balanceMinutes: null, warnings: ['WORKED_ON_OFF_DAY'] }));
    open();
    expect(await screen.findByText(/recorded on a day off/)).toBeInTheDocument();
  });

  it('rejects a malformed date in the address', () => {
    renderAt('/day/not-a-date', '/day/:date', <DayDetail />);
    expect(screen.getByText('That is not a valid date.')).toBeInTheDocument();
  });

  it('explains a failed load and retries', async () => {
    api.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    api.get.mockImplementation(async (url: string) => (url === '/leave' ? makeLeave() : incompleteDay()));
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Thu, 17 Sep 2026')).toBeInTheDocument();
  });
});

describe('Birthday half-day on the day screen', () => {
  it('is offered as a status, and its half-day box is ticked and locked', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Birthday half-day' }));
    const half = screen.getByLabelText(/Half day/);
    expect(half).toBeChecked();
    expect(half).toBeDisabled();
    expect(screen.getByText(/always a half day/)).toBeInTheDocument();
  });

  it('saves as a half day even though the box could not be changed', async () => {
    serve(makeDetail({}, { date: '2026-09-17' }));
    api.put.mockResolvedValue(makeDetail({ status: 'BIRTHDAY_LEAVE', dayFraction: 0.5 }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Birthday half-day' }));
    await user.click(screen.getByRole('button', { name: 'Save day' }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/attendance/2026-09-17', { status: 'BIRTHDAY_LEAVE', dayFraction: 0.5, notes: null, managerInformed: false, bereavementEventId: null }),
    );
  });

  it('a day already saved as a birthday half-day opens with it selected', async () => {
    serve(makeDetail({ status: 'BIRTHDAY_LEAVE', dayFraction: 0.5 }, { date: '2026-09-17', kind: 'BIRTHDAY_HALF_DAY', requiredMinutes: 240 }));
    open();
    expect(await screen.findByRole('radio', { name: 'Birthday half-day', checked: true })).toBeInTheDocument();
    expect(screen.getAllByText('Birthday half-day').length).toBeGreaterThan(0); // the status pill too
  });
});
