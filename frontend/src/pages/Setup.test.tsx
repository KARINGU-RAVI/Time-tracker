import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import Setup from '@/pages/Setup';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const DEFAULTS = {
  alreadyComplete: false,
  today: '2026-09-19',
  profile: { name: 'Given Name' },
  work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-21' },
  leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 0, annualUsedSoFar: 0, optionalUsedSoFar: 0, birthdayQuota: 0.5, birthdayTaken: false, creditsFromMonth: 1 },
  holidays: { companyCount: 0 },
};

/** A stand-in for the server's preview, with the same arithmetic. */
function previewFor(body: { leave: { carriedForward: number; annualUsedSoFar: number; optionalQuota: number; optionalUsedSoFar: number; birthdayQuota: number; birthdayTaken: boolean } }) {
  const l = body.leave;
  const credited = 15.75;
  return {
    preview: {
      annual: { carriedIn: l.carriedForward, credited, used: l.annualUsedSoFar, balance: l.carriedForward + credited - l.annualUsedSoFar },
      optional: { quota: l.optionalQuota, used: l.optionalUsedSoFar, remaining: l.optionalQuota - l.optionalUsedSoFar },
      birthday: { quota: l.birthdayQuota, used: l.birthdayTaken ? l.birthdayQuota : 0, remaining: l.birthdayTaken ? 0 : l.birthdayQuota },
      trackingStartDate: '2026-09-21',
    },
    holidayCount: 0,
  };
}

let client: QueryClient;
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Setup />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.get.mockResolvedValue(DEFAULTS);
  api.post.mockImplementation(async (url: string, body: never) => {
    if (url === '/setup/preview') return previewFor(body);
    if (url === '/setup/complete') return { user: {} };
    throw new Error(`unexpected ${url}`);
  });
});

const next = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Continue' }));

async function toLeaveStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Set up your account' });
  await next(user); // profile -> work
  await next(user); // work -> leave
  await screen.findByText('Your leave after setup');
}

describe('the setup wizard', () => {
  it('starts on the profile with the name from sign-in and the step counter', async () => {
    mount();
    expect(await screen.findByLabelText('Full name')).toHaveValue('Given Name');
    expect(screen.getByText('Step 1 of 5: Profile')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('will not continue without a name', async () => {
    mount();
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Full name'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.type(screen.getByLabelText('Full name'), 'A');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('fills in the company defaults for work hours', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByLabelText('Full name');
    await next(user);
    expect(screen.getByLabelText('Daily hours: hours')).toHaveValue('8');
    expect(screen.getByLabelText('Daily hours: minutes')).toHaveValue('0');
    expect(screen.getByLabelText('Weekly hours: hours')).toHaveValue('40');
    for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) expect(screen.getByRole('button', { name: d })).toHaveAttribute('aria-pressed', 'true');
    for (const d of ['Saturday', 'Sunday']) expect(screen.getByRole('button', { name: d })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('radio', { name: 'Monday' })).toBeChecked();
    expect(screen.getByText('India Standard Time (UTC+05:30)')).toBeInTheDocument();
    expect(screen.getByLabelText('Start counting from')).toHaveValue('2026-09-21');
  });

  it('needs at least one working day', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByLabelText('Full name');
    await next(user);
    for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await user.click(screen.getByRole('button', { name: d }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one working day.');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Saturday' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('shows the balance from the server as the numbers change', async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    expect(await screen.findByText('15.75 days')).toBeInTheDocument(); // nothing carried or used: only the 15.75 credited so far
  });

  it("reproduces the owner's own position: 2 carried, 5 used, 1 optional used = 12.75 and 1 left", async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    const carried = screen.getByLabelText('Leave left over from last year');
    await user.clear(carried);
    await user.type(carried, '2');
    const used = screen.getByLabelText('Leave already taken this year');
    await user.clear(used);
    await user.type(used, '5');
    const optional = screen.getByLabelText('Optional holidays already taken this year');
    await user.clear(optional);
    await user.type(optional, '1');
    expect(await screen.findByText('12.75 days')).toBeInTheDocument();
    expect(screen.getByText('1 left')).toBeInTheDocument();
  });

  it('shows the server explanation and blocks Continue when the numbers do not add up', async () => {
    api.post.mockImplementation(async (url: string) => {
      if (url === '/setup/preview') throw new ApiError('CARRY_TOO_HIGH', 'At most 3 days can be carried forward, so this cannot be more.', 400);
      throw new Error('unexpected');
    });
    mount();
    const user = userEvent.setup();
    await screen.findByLabelText('Full name');
    await next(user);
    await next(user);
    expect(await screen.findByText(/At most 3 days can be carried forward/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('flags text that is not a number without asking the server', async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    const before = api.post.mock.calls.length;
    await user.type(screen.getByLabelText('Leave left over from last year'), 'abc');
    expect(screen.getAllByText('Enter a number, for example 1.75.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 450));
    expect(api.post.mock.calls.length).toBe(before); // no request for invalid input
  });

  describe('holidays', () => {
    async function toHolidays(user: ReturnType<typeof userEvent.setup>) {
      await toLeaveStep(user);
      await screen.findByText('15.75 days');
      await next(user);
      await screen.findByText('Use the company calendar');
    }

    it('offers the three choices, with the company calendar noted as empty', async () => {
      mount();
      const user = userEvent.setup();
      await toHolidays(user);
      expect(screen.getByText('No company calendar has been published yet.')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Start empty/ })).toBeChecked(); // default when there is no company calendar
    });

    it('reads a CSV file, shows a preview, and reports bad lines instead of importing them', async () => {
      mount();
      const user = userEvent.setup();
      await toHolidays(user);
      await user.click(screen.getByRole('radio', { name: /Upload my own list/ }));
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled(); // nothing chosen yet
      const input = screen.getByLabelText('Choose CSV file');

      fireEvent.change(input, { target: { files: [new File(['2026-10-02,Gandhi Jayanti\nbroken line,X'], 'h.csv', { type: 'text/csv' })] } });
      expect(await screen.findByText(/Fix these lines/)).toBeInTheDocument();
      expect(screen.getByText(/Line 2: "broken line" is not a date/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

      fireEvent.change(input, { target: { files: [new File(['date,name,type\n2026-10-02,Gandhi Jayanti,public\n2026-11-08,Diwali,optional'], 'h.csv', { type: 'text/csv' })] } });
      expect(await screen.findByText('Preview (2 holidays)')).toBeInTheDocument();
      expect(screen.queryByText(/Fix these lines/)).not.toBeInTheDocument();
      const list = screen.getByRole('list', { name: '' });
      expect(within(list).getByText('Gandhi Jayanti')).toBeInTheDocument();
      expect(within(list).getByText('Optional')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });
  });

  describe('review and finish', () => {
    async function toReview(user: ReturnType<typeof userEvent.setup>) {
      await toLeaveStep(user);
      await screen.findByText('15.75 days');
      await next(user); // holidays
      await next(user); // review
      await screen.findByRole('button', { name: 'Finish setup' });
    }

    it('summarises everything, lets you edit a step, and keeps what you typed', async () => {
      mount();
      const user = userEvent.setup();
      await toReview(user);
      expect(screen.getByText('8h 00m a day, 40h 00m a week')).toBeInTheDocument();
      expect(screen.getByText(/Mon, Tue, Wed, Thu, Fri/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Edit Profile' }));
      expect(screen.getByLabelText('Full name')).toHaveValue('Given Name');
    });

    it('cannot finish until the data note is acknowledged', async () => {
      mount();
      const user = userEvent.setup();
      await toReview(user);
      expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
      await user.click(screen.getByRole('checkbox'));
      expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
    });

    it('sends the answers in the exact shape the server expects, then refreshes the session', async () => {
      mount();
      const spy = vi.spyOn(client, 'invalidateQueries');
      const user = userEvent.setup();
      await toLeaveStep(user);
      const carried = screen.getByLabelText('Leave left over from last year');
      await user.clear(carried);
      await user.type(carried, '2');
      const used = screen.getByLabelText('Leave already taken this year');
      await user.clear(used);
      await user.type(used, '5');
      await screen.findByText('12.75 days');
      await next(user);
      await next(user);
      await user.click(await screen.findByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/setup/complete', expect.anything()));
      const body = api.post.mock.calls.find((c) => c[0] === '/setup/complete')![1];
      expect(body).toEqual({
        profile: { name: 'Given Name', employeeId: undefined, designation: undefined, businessUnit: undefined },
        work: { dailyMinutes: 480, weeklyMinutes: 2400, workingDays: [1, 2, 3, 4, 5], weekStartsOn: 1, trackingStartDate: '2026-09-21' },
        leave: { annualEntitlement: 21, accrualPerMonth: 1.75, carryForwardCap: 3, optionalQuota: 2, bereavementDaysPerEvent: 5, carriedForward: 2, annualUsedSoFar: 5, optionalUsedSoFar: 0, birthdayQuota: 0.5, birthdayTaken: false, creditsFromMonth: 1 },
        holidays: { source: 'none', list: undefined },
        acknowledged: true,
      });
      await waitFor(() => expect(spy).toHaveBeenCalled());
    });

    it('says nothing was changed when saving fails, and lets you try again', async () => {
      mount();
      const user = userEvent.setup();
      await toReview(user);
      await user.click(screen.getByRole('checkbox'));
      api.post.mockImplementation(async (url: string, body: never) => {
        if (url === '/setup/complete') throw new ApiError('NETWORK_ERROR', "Can't reach the server.", 0);
        return previewFor(body);
      });
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your setup. Nothing was changed. Try again.');
      expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
    });

    it('shows a specific server refusal (a 4xx) as it is', async () => {
      mount();
      const user = userEvent.setup();
      await toReview(user);
      await user.click(screen.getByRole('checkbox'));
      api.post.mockImplementation(async (url: string, body: never) => {
        if (url === '/setup/complete') throw new ApiError('ALREADY_SET_UP', 'This account is already set up.', 409);
        return previewFor(body);
      });
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('This account is already set up.');
    });
  });
});

describe('birthday half-day in the setup wizard', () => {
  it('asks for the allowance and whether it was already taken, and shows what is left', async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    expect(screen.getByLabelText('Birthday half-day each year')).toHaveValue('0.5');
    expect(await screen.findByText('0.5 left')).toBeInTheDocument(); // the preview: nothing taken yet
    await user.click(screen.getByLabelText('I have already taken my birthday half-day this year'));
    expect(await screen.findByText('0 left')).toBeInTheDocument();
  });

  it('a zero allowance disables the "already taken" box', async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    const allowance = screen.getByLabelText('Birthday half-day each year');
    await user.clear(allowance);
    await user.type(allowance, '0');
    expect(screen.getByLabelText('I have already taken my birthday half-day this year')).toBeDisabled();
  });

  it('sends the birthday answers to the server when finishing', async () => {
    mount();
    const user = userEvent.setup();
    await toLeaveStep(user);
    await user.click(screen.getByLabelText('I have already taken my birthday half-day this year'));
    await screen.findByText('0 left');
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/setup/complete', expect.anything()));
    const body = api.post.mock.calls.find((c) => c[0] === '/setup/complete')![1];
    expect(body.leave).toMatchObject({ birthdayQuota: 0.5, birthdayTaken: true });
  });
});
