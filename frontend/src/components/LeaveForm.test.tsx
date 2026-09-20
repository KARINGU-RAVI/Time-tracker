import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { LeavePreview } from '@/lib/types';
import { makeDay, makeLeave, renderAt } from '@/test/utils';
import Leave from '@/pages/Leave';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));
void makeDay;

const preview = (over: Partial<LeavePreview> = {}): LeavePreview => ({
  workingDays: ['2026-09-18'],
  earlierDates: [],
  skipped: [],
  totalDays: 1,
  paid: 1,
  lop: 0,
  summary: '1.00 working day(s) selected (weekends and holidays are skipped).',
  warning: null,
  managerMessage: null,
  ...over,
});

function serve(leave = makeLeave(), pv: LeavePreview = preview()) {
  api.get.mockResolvedValue(leave);
  api.post.mockImplementation(async (url: string) => {
    if (url === '/leave/preview') return pv;
    if (url === '/leave/apply') return { applied: pv.workingDays, earlier: pv.earlierDates ?? [], paid: pv.paid, lop: pv.lop, warning: pv.warning };
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
const previews = () => api.post.mock.calls.filter((c) => c[0] === '/leave/preview').map((c) => c[1]);
const lastPreview = () => previews().at(-1);
const setDate = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('picking dates that are not in a row', () => {
  it('offers "Dates in a row" by default, and switches to picking single dates', async () => {
    serve();
    open();
    const user = userEvent.setup();
    expect(await screen.findByRole('radio', { name: 'Dates in a row', checked: true })).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pick dates' }));
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Add a date')).toBeInTheDocument();
    expect(screen.getByText(/do not have to be next to each other/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled(); // nothing chosen yet
  });

  it('adds dates one by one (kept in order, never twice), previews them, and can remove one', async () => {
    serve(makeLeave(), preview({ workingDays: ['2026-09-22', '2026-09-24'], totalDays: 2, paid: 2 }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Pick dates' }));
    for (const d of ['2026-09-24', '2026-09-22']) {
      setDate('Add a date', d);
      await user.click(screen.getByRole('button', { name: 'Add date' }));
    }
    const list = screen.getByRole('list', { name: 'Chosen dates' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['22 Sep', '24 Sep']); // sorted
    // Adding the same date again does nothing.
    setDate('Add a date', '2026-09-22');
    expect(screen.getByRole('button', { name: 'Add date' })).toBeDisabled();
    await waitFor(() => expect(lastPreview()).toMatchObject({ type: 'CASUAL_LEAVE', dates: ['2026-09-22', '2026-09-24'], half: false }));
    expect(lastPreview()).not.toHaveProperty('startDate');
    // Removing one updates the request.
    await user.click(screen.getByRole('button', { name: 'Remove 22 Sep' }));
    await waitFor(() => expect(lastPreview()).toMatchObject({ dates: ['2026-09-24'] }));
  });

  it('applies exactly the chosen dates', async () => {
    serve(makeLeave(), preview({ workingDays: ['2026-09-22', '2026-09-24'], totalDays: 2 }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Pick dates' }));
    for (const d of ['2026-09-22', '2026-09-24']) {
      setDate('Add a date', d);
      await user.click(screen.getByRole('button', { name: 'Add date' }));
    }
    await screen.findByText(/2 working day|working day\(s\) selected/);
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', expect.objectContaining({ type: 'CASUAL_LEAVE', dates: ['2026-09-22', '2026-09-24'] })));
    expect(await screen.findByText(/Leave recorded for 2 day/)).toBeInTheDocument();
  });

  it('stops at 31 dates', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Pick dates' }));
    for (let i = 1; i <= 31; i++) {
      setDate('Add a date', `2026-10-${String(i).padStart(2, '0')}`);
      await user.click(screen.getByRole('button', { name: 'Add date' }));
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(31);
    setDate('Add a date', '2026-11-05');
    expect(screen.getByRole('button', { name: 'Add date' })).toBeDisabled();
    expect(screen.getByText(/most you can add at once \(31\)/)).toBeInTheDocument();
  });

  it('a half day is one date, so picking is not offered for it', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Pick dates' }));
    await user.click(screen.getByLabelText(/Half day/));
    expect(screen.queryByRole('radio', { name: 'Pick dates' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeDisabled();
  });
});

describe('the first or the second half', () => {
  it('must be chosen for a half day before it can be applied, and is sent with the request', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Half day/));
    expect(screen.getByText('Which half is your leave?')).toBeInTheDocument();
    await screen.findByText(/working day\(s\) selected/); // the preview is ready, so only the missing half can be holding the button back
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
    expect(screen.getByText(/Choose the first or second half to continue/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Second half' }));
    expect(screen.getByText('You work the first half and are on leave in the second half.')).toBeInTheDocument();
    await waitFor(() => expect(lastPreview()).toMatchObject({ half: true, halfPart: 'SECOND' }));
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leave/apply', expect.objectContaining({ half: true, halfPart: 'SECOND' })));
  });

  it('explains what the first half means', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Half day/));
    await user.click(screen.getByRole('radio', { name: 'First half' }));
    expect(screen.getByText('You are on leave in the first half and work the second half.')).toBeInTheDocument();
  });

  it('is not asked for a full day, and unticking a half day removes the question', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Apply leave' });
    expect(screen.queryByText('Which half is your leave?')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Half day/));
    await user.click(screen.getByRole('radio', { name: 'First half' }));
    await user.click(screen.getByLabelText(/Half day/)); // back to a full day
    expect(screen.queryByText('Which half is your leave?')).not.toBeInTheDocument();
    await waitFor(() => expect(lastPreview()).toMatchObject({ half: false }));
    expect(lastPreview()).not.toHaveProperty('halfPart', 'FIRST');
  });

  it('a birthday half-day always asks which half', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Birthday half-day' }));
    expect(screen.getByText('Which half is your leave?')).toBeInTheDocument();
    await screen.findByText(/working day\(s\) selected/);
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'First half' }));
    await waitFor(() => expect(lastPreview()).toMatchObject({ type: 'BIRTHDAY_LEAVE', half: true, halfPart: 'FIRST' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply leave' })).toBeEnabled());
  });

  it('the choice is kept when the leave type changes between casual and sick', async () => {
    serve();
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Half day/));
    await user.click(screen.getByRole('radio', { name: 'Second half' }));
    await user.click(screen.getByRole('radio', { name: 'Sick leave' }));
    expect(screen.getByRole('radio', { name: 'Second half', checked: true })).toBeInTheDocument();
  });
});

describe('bereavement on any dates', () => {
  const withEvents = () =>
    makeLeave({ bereavement: { maxDaysPerEvent: 5, events: [{ id: 'e1', relation: 'Grandfather', startDate: '2026-09-16', note: null, daysUsed: 2 }] } });

  it('says the days do not have to be taken together, and how many are left for the chosen event', async () => {
    serve(withEvents());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Bereavement' }));
    expect(screen.getByText(/You do not have to take all 5 days together/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grandfather (2026-09-16), 2 of 5 days used' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Bereavement event'), 'e1');
    expect(screen.getByText(/3 left for this event/)).toBeInTheDocument();
  });

  it('cannot be applied until an event is chosen', async () => {
    serve(withEvents());
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Bereavement' }));
    await screen.findByText(/working day\(s\) selected/);
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
    expect(screen.getByText(/Choose a bereavement event to continue/)).toBeInTheDocument();
  });

  it('can take separate dates, picked one by one', async () => {
    serve(withEvents(), preview({ workingDays: ['2026-09-22', '2026-09-28'], totalDays: 2 }));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Bereavement' }));
    await user.selectOptions(screen.getByLabelText('Bereavement event'), 'e1');
    await user.click(screen.getByRole('radio', { name: 'Pick dates' }));
    for (const d of ['2026-09-22', '2026-09-28']) {
      setDate('Add a date', d);
      await user.click(screen.getByRole('button', { name: 'Add date' }));
    }
    await screen.findByText(/working day\(s\) selected/);
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/leave/apply', expect.objectContaining({ type: 'BEREAVEMENT_LEAVE', dates: ['2026-09-22', '2026-09-28'], bereavementEventId: 'e1' })),
    );
  });

  it('shows the limit message from the server when there are too many days', async () => {
    serve(withEvents());
    api.post.mockImplementation(async (url: string) => {
      if (url === '/leave/preview') return preview();
      throw new ApiError('BEREAVEMENT_LIMIT', 'Bereavement leave is limited to 5 days per event.', 409);
    });
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Bereavement' }));
    await user.selectOptions(screen.getByLabelText('Bereavement event'), 'e1');
    await screen.findByText(/working day\(s\) selected/);
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    expect(await screen.findByText('Bereavement leave is limited to 5 days per event.')).toBeInTheDocument();
  });

  it('the Bereavement card also says the days can be on any dates', async () => {
    serve(withEvents());
    open();
    expect(await screen.findByText(/You can take them on any dates, not only in a row/)).toBeInTheDocument();
  });
});

describe('dates from earlier in the year', () => {
  it('says that earlier dates can be chosen, and warns when a chosen date is before the start date', async () => {
    serve(makeLeave({ trackingStartDate: '2026-09-15' }));
    open();
    expect(await screen.findByText(/You can also choose dates that have already passed this year/)).toBeInTheDocument();
    expect(screen.queryByText(/saved as earlier leave: they lower your balance/)).not.toBeInTheDocument(); // 18 Sep is after 15 Sep
    setDate('From', '2026-09-10');
    expect(await screen.findByText(/Dates before 15 Sep are saved as earlier leave: they lower your balance but do not create a day record/)).toBeInTheDocument();
  });

  it('shows which dates will be saved as earlier leave, and applies them', async () => {
    serve(makeLeave({ trackingStartDate: '2026-09-15' }), preview({
      workingDays: [],
      earlierDates: ['2026-09-10', '2026-09-11'],
      totalDays: 2,
      summary: '2.00 working day(s) selected (weekends and holidays are skipped). 2 date(s) fall before you started counting: they are saved as earlier leave and reduce your balance.',
    }));
    open();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Apply leave' });
    setDate('From', '2026-09-10');
    setDate('To', '2026-09-11');
    expect(await screen.findByText('Saved as earlier leave: 10 Sep, 11 Sep')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeEnabled(); // there is something to save even with no normal days
    await user.click(screen.getByRole('button', { name: 'Apply leave' }));
    expect(await screen.findByText(/Leave recorded for 2 day\(s\). 2 saved as earlier leave/)).toBeInTheDocument();
  });

  it('cannot be applied when every chosen date was skipped', async () => {
    serve(makeLeave(), preview({ workingDays: [], earlierDates: [], totalDays: 0, summary: 'No working days are selected (weekends and holidays are skipped).', skipped: [{ date: '2026-09-19', reason: 'Weekly off' }] }));
    open();
    await screen.findByText(/No working days are selected/);
    expect(screen.getByRole('button', { name: 'Apply leave' })).toBeDisabled();
    expect(screen.getByText(/Skipped: 19 Sep \(Weekly off\)/)).toBeInTheDocument();
  });
});

describe('earlier leave that was added', () => {
  const withEarlier = () =>
    makeLeave({
      earlier: [
        { id: 'x1', date: '2026-09-14', pool: 'ANNUAL', days: 1, note: 'Earlier leave: Sick leave on 14 Sep 2026' },
        { id: 'x2', date: '2026-09-11', pool: 'BIRTHDAY', days: 0.5, note: 'Earlier leave: Birthday half-day on 11 Sep 2026 (second half)' },
      ],
    });

  it('is listed with what it was, and explains why it can be removed', async () => {
    serve(withEarlier());
    open();
    expect(await screen.findByText('Earlier leave you added')).toBeInTheDocument();
    expect(screen.getByText(/remove it here so it is not counted twice/)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter((li) => /Sick leave|Birthday half-day/.test(li.textContent ?? ''));
    expect(rows[0]).toHaveTextContent('14 Sep');
    expect(rows[0]).toHaveTextContent('Sick leave');
    expect(rows[0]).toHaveTextContent('1 day');
    expect(rows[1]).toHaveTextContent('Birthday half-day (second half)');
    expect(rows[1]).toHaveTextContent('0.5 days');
  });

  it('is not shown at all when there is none', async () => {
    serve(makeLeave());
    open();
    await screen.findByRole('button', { name: 'Apply leave' });
    expect(screen.queryByText('Earlier leave you added')).not.toBeInTheDocument();
  });

  it('asks before removing, can be cancelled, and removes only the one chosen', async () => {
    serve(withEarlier());
    api.del.mockResolvedValue(undefined);
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove earlier leave on 14 Sep' }));
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.del).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove earlier leave on 14 Sep' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(api.del).toHaveBeenCalledTimes(1);
    expect(api.del).toHaveBeenCalledWith('/leave/earlier/x1');
  });

  it('shows the server message if removing fails', async () => {
    serve(withEarlier());
    api.del.mockRejectedValue(new ApiError('NOT_FOUND', 'That entry was not found.', 404));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove earlier leave on 14 Sep' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(await screen.findByText('That entry was not found.')).toBeInTheDocument();
  });
});
