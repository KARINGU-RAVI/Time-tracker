import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { AddSessionDialog } from './AddSessionDialog';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

function renderDialog(props: Partial<React.ComponentProps<typeof AddSessionDialog>> = {}) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddSessionDialog date="2026-09-17" open onOpenChange={onOpenChange} {...props} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const type = async (label: string, value: string) => {
  const el = screen.getByLabelText(label);
  await userEvent.setup().clear(el);
  await userEvent.setup().type(el, value);
};

beforeEach(() => Object.values(api).forEach((m) => m.mockReset()));

describe('AddSessionDialog', () => {
  it('a prefilled time that has seconds is cut to HH:MM, so the form can still be saved', async () => {
    renderDialog({ defaultIn: '08:49:27' });
    expect(screen.getByLabelText('IN')).toHaveValue('08:49');
    await userEvent.setup().click(screen.getByLabelText('Still inside (no OUT yet)'));
    expect(screen.getByRole('button', { name: 'Save session' })).toBeEnabled();
  });

  it('shows the duration live and enables Save for a valid session', async () => {
    renderDialog();
    await type('IN', '16:45');
    await type('OUT', '17:20');
    expect(await screen.findByText('Duration 35m')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save session' })).toBeEnabled();
  });

  it('blocks OUT before IN with the standard message', async () => {
    renderDialog();
    await type('IN', '10:00');
    await type('OUT', '09:00');
    expect(await screen.findByRole('alert')).toHaveTextContent('OUT must be after IN.');
    expect(screen.getByRole('button', { name: 'Save session' })).toBeDisabled();
  });

  it('allows a midnight-crossing session when "OUT is on the next day" is set', async () => {
    renderDialog();
    await type('IN', '22:00');
    await type('OUT', '02:00');
    expect(screen.getByRole('button', { name: 'Save session' })).toBeDisabled();
    await userEvent.setup().click(screen.getByLabelText('OUT is on the next day'));
    expect(await screen.findByText('Duration 4h 00m')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save session' })).toBeEnabled();
  });

  it('sends IST-local times to the server and closes on success', async () => {
    api.post.mockResolvedValue({});
    const { onOpenChange } = renderDialog();
    await type('IN', '16:45');
    await type('OUT', '17:20');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/attendance/2026-09-17/sessions', { inTime: '2026-09-17T16:45', outTime: '2026-09-17T17:20' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sends a next-day OUT on the following date', async () => {
    api.post.mockResolvedValue({});
    renderDialog();
    await type('IN', '22:00');
    await type('OUT', '02:00');
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('OUT is on the next day'));
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/attendance/2026-09-17/sessions', { inTime: '2026-09-17T22:00', outTime: '2026-09-18T02:00' }));
  });

  it('creates an open session when "Still inside" is ticked', async () => {
    api.post.mockResolvedValue({});
    renderDialog();
    await type('IN', '16:45');
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Still inside (no OUT yet)'));
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/attendance/2026-09-17/sessions', { inTime: '2026-09-17T16:45', outTime: null }));
  });

  it("shows the server's overlap message and stays open", async () => {
    api.post.mockRejectedValue(new ApiError('OVERLAP', 'This overlaps your 08:05-12:35 session.', 409));
    const { onOpenChange } = renderDialog();
    await type('IN', '12:00');
    await type('OUT', '13:00');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByText('This overlaps your 08:05-12:35 session.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('edits an existing session with a PUT', async () => {
    api.put.mockResolvedValue({});
    renderDialog({ session: { id: 'abc', inTime: '2026-09-17T11:15:00Z', inClock: '16:45', outTime: null, outClock: null } });
    expect(screen.getByRole('heading', { name: 'Edit session' })).toBeInTheDocument();
    expect(screen.getByLabelText('Still inside (no OUT yet)')).toBeChecked();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Still inside (no OUT yet)'));
    await type('OUT', '17:20');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/sessions/abc', { inTime: '2026-09-17T16:45', outTime: '2026-09-17T17:20' }));
  });
});
