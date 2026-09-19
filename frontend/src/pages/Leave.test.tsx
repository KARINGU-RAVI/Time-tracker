import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { LeavePreview } from '@/lib/types';
import { makeLeave, renderAt } from '@/test/utils';
import Leave from './Leave';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const okPreview = (over: Partial<LeavePreview> = {}): LeavePreview => ({
  workingDays: ['2026-09-18'],
  skipped: [],
  totalDays: 1,
  paid: 1,
  lop: 0,
  summary: '1.00 working day(s) selected (weekends and holidays are skipped).',
  warning: null,
  managerMessage: null,
  ...over,
});

const unpaid = okPreview({
  workingDays: ['2026-10-01', '2026-10-02'],
  totalDays: 22,
  paid: 14.5,
  lop: 7.5,
  summary: '22.00 working day(s) selected (weekends and holidays are skipped).',
  warning: '7.50 day(s) will be unpaid (salary cut).',
  managerMessage: 'Hi, I would like to apply for casual leave on 1 Oct 2026 to 30 Oct 2026. My leave balance covers 14.50 day(s), so 7.50 day(s) would be unpaid. Please let me know if this is fine. Thank you.',
});

function serve(leave = makeLeave(), preview: LeavePreview = okPreview()) {
  api.get.mockResolvedValue(leave);
  api.post.mockImplementation(async (url: string) => {
    if (url === '/leave/preview') return preview;
    if (url === '/leave/apply') return { applied: preview.workingDays, paid: preview.paid, lop: preview.lop, warning: preview.warning };
    return {};
  });
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const open = () => renderAt('/leave', '/leave', <Leave />);
const applyBody = (over: object = {}) => ({ type: 'CASUAL_LEAVE', startDate: '2026-09-18', endDate: '2026-09-18', half: false, managerInformed: false, bereavementEventId: null, ...over });

describe('Leave balances', () => {
  it('shows the annual balance, its parts, the next credit, optional and bereavement', async () => {
    serve();
    open();
    expect(await screen.findByText('12.75', { selector: 'p' })).toBeInTheDocument(); // the balance card (the ledger also shows 12.75)
    expect(screen.getByText('Carried in').nextSibling).toHaveTextContent('2.00');
    expect(screen.getByText('Accrued').nextSibling).toHaveTextContent('15.75');
    expect(screen.getByText('Used').nextSibling).toHaveTextContent('5.00');
    expect(screen.getByText(/Next credit: \+1.75 on 1 Oct/)).toBeInTheDocument();
    expect(screen.getByText('1 of 2 remaining')).toBeInTheDocument();
    expect(screen.getByText(/Up to 5 days per event/)).toBeInTheDocument();
    expect(screen.getByText('No events logged.')).toBeInTheDocument();
  });

  it('shows the ledger with signs and a running balance', async () => {
    serve();
    open();
    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('Carried forward from 2025');
    expect(table).toHaveTextContent('+2.00');
    expect(table).toHaveTextContent('-5.00');
    expect(table).toHaveTextContent('12.75');
  });

  it('shows unpaid days by month and warns about year-end lapse', async () => {
    serve(makeLeave({ lopByMonth: { '2026-09': 1.5 }, yearEnd: { balance: 16.25, carryForward: 3, willLapse: 13.25 } }));
    open();
    expect(await screen.findByText('Sep 1.5')).toBeInTheDocument();
    expect(screen.getByText('Aug 0')).toBeInTheDocument();
    expect(screen.queryByText('Oct 0')).not.toBeInTheDocument(); // only months up to now
    expect(screen.getByText(/13.25 will lapse on 31 Dec/)).toBeInTheDocument();
    expect(screen.getByText(/cut from that month's salary/)).toBeInTheDocument();
  });
});

describe('Applying leave', () => {
  it('previews as you type and applies within balance with no warning', async () => {
    serve();
    open();
    expect(await screen.findByText(/1.00 working day\(s\) selected/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/leave/preview', applyBody());
    expect(screen.queryByText(/will be unpaid/)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', applyBody()));
    expect(await screen.findByText(/Leave recorded for 1 day/)).toBeInTheDocument();
  });

  it('warns before saving when leave is beyond the balance, and still allows it', async () => {
    serve(makeLeave(), unpaid);
    open();
    expect(await screen.findByText('7.50 day(s) will be unpaid (salary cut).')).toBeInTheDocument();
    expect(screen.getByText(/You can still save/)).toBeInTheDocument();
    expect(screen.getByText(/would be unpaid/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeEnabled();
  });

  it('copies the manager message and records that the manager was informed', async () => {
    serve(makeLeave(), unpaid);
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(unpaid.managerMessage);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await user.click(screen.getByLabelText('Manager informed'));
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', expect.objectContaining({ managerInformed: true })));
  });

  it('cannot apply when no working days are selected, and says which days were skipped', async () => {
    serve(makeLeave(), okPreview({ workingDays: [], totalDays: 0, paid: 0, summary: 'No working days are selected (weekends and holidays are skipped).', skipped: [{ date: '2026-09-19', reason: 'Weekly off' }, { date: '2026-09-20', reason: 'Weekly off' }] }));
    open();
    expect(await screen.findByText(/No working days are selected/)).toBeInTheDocument();
    expect(screen.getByText(/19 Sep \(Weekly off\), 20 Sep \(Weekly off\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
  });

  it('only allows a half day for casual or sick leave on a single date', async () => {
    serve();
    open();
    const half = await screen.findByLabelText(/Half day/);
    expect(half).toBeEnabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Bereavement' }));
    expect(half).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Sick leave' }));
    expect(half).toBeEnabled();
    await user.click(half);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/preview', applyBody({ type: 'SICK_LEAVE', half: true })));
  });

  it('shows the server message when the request is refused', async () => {
    api.get.mockResolvedValue(makeLeave());
    api.post.mockRejectedValue(new ApiError('LEAVE_TOO_FAR', 'Leave can only be applied within the current year for now.', 400));
    open();
    expect(await screen.findByText('Leave can only be applied within the current year for now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
  });
});

describe('Bereavement', () => {
  it('logs an event with today as the start date', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Relation'), 'Family member');
    await user.click(screen.getByRole('button', { name: /Log/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/bereavement-events', { relation: 'Family member', startDate: '2026-09-18' }));
  });

  it('lists existing events with days used and sends the chosen event when applying', async () => {
    serve(makeLeave({ bereavement: { maxDaysPerEvent: 5, events: [{ id: 'e1', relation: 'Family member', startDate: '2026-09-16', note: null, daysUsed: 2 }] } }));
    open();
    expect(await screen.findByText(/Family member, 16 Sep: 2\/5 days/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Bereavement' }));
    await user.selectOptions(screen.getByLabelText('Bereavement event'), 'e1');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/preview', applyBody({ type: 'BEREAVEMENT_LEAVE' })));
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', applyBody({ type: 'BEREAVEMENT_LEAVE', bereavementEventId: 'e1' })));
  });
});

describe('Leave loading', () => {
  it('explains a failed load and retries', async () => {
    api.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    api.get.mockResolvedValue(makeLeave());
    api.post.mockResolvedValue(okPreview());
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('12.75', { selector: 'p' })).toBeInTheDocument();
  });
});

describe('Birthday half-day', () => {
  it('shows its own allowance next to (and separate from) annual and optional leave', async () => {
    serve(makeLeave({ birthday: { quota: 0.5, used: 0, remaining: 0.5 } }));
    open();
    expect(await screen.findByText('Birthday half-day', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('0.5 of 0.5 remaining')).toBeInTheDocument();
    expect(screen.getByText(/Half a day each year, separate from annual leave/)).toBeInTheDocument();
    expect(screen.getByText('12.75', { selector: 'p' })).toBeInTheDocument(); // annual balance is its own number
  });

  it('shows none left once it has been taken', async () => {
    serve();
    open();
    expect(await screen.findByText('0 of 0.5 remaining')).toBeInTheDocument();
  });

  it('is a single date and always half a day: the To date is locked and the request says so', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Birthday half-day' }));
    expect(screen.getByLabelText('To')).toBeDisabled();
    expect(screen.getByText(/one date and always half a day/)).toBeInTheDocument();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/preview', applyBody({ type: 'BIRTHDAY_LEAVE', half: true })));
  });

  it('even after choosing a range first, the request is one date', async () => {
    serve();
    open();
    const user = userEvent.setup();
    const to = await screen.findByLabelText('To');
    fireEvent.change(to, { target: { value: '2026-09-25' } });
    await user.click(screen.getByRole('radio', { name: 'Birthday half-day' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/preview', applyBody({ type: 'BIRTHDAY_LEAVE', half: true, endDate: '2026-09-18' })));
  });

  it('applies it, and warns that a second one in the year is unpaid', async () => {
    serve(makeLeave(), okPreview({ workingDays: ['2026-09-18'], totalDays: 0.5, paid: 0, lop: 0.5, warning: '0.5 day(s) will be unpaid (salary cut).', managerMessage: 'Hi, I would like to apply for my birthday half-day on 18 Sep 2026.' }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Birthday half-day' }));
    expect(await screen.findByText('0.5 day(s) will be unpaid (salary cut).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', applyBody({ type: 'BIRTHDAY_LEAVE', half: true })));
  });
});
