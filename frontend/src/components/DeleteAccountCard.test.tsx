import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { DeleteAccountCard } from './DeleteAccountCard';

const api = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), http: { delete: api.del } }));

const assign = vi.fn();
beforeEach(() => {
  api.del.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
});

function mount(hasPassword: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DeleteAccountCard hasPassword={hasPassword} />
    </QueryClientProvider>,
  );
}

async function open() {
  await userEvent.setup().click(screen.getByRole('button', { name: /Delete my account/ }));
}

describe('delete account', () => {
  it('does nothing until the dialog is confirmed', async () => {
    mount(true);
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();
    await open();
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeDisabled();
  });

  it('needs DELETE typed exactly, and the password when the account has one', async () => {
    mount(true);
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
    await user.type(screen.getByLabelText('Your password'), 'my-password-1');
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeDisabled(); // wrong case
    await user.clear(screen.getByLabelText('Type DELETE to confirm'));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeEnabled();
    await user.clear(screen.getByLabelText('Your password'));
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeDisabled(); // no password
  });

  it('sends the confirmation and password, then returns to the start', async () => {
    api.del.mockResolvedValue({});
    mount(true);
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your password'), 'my-password-1');
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    expect(api.del).toHaveBeenCalledWith('/account', { data: { confirm: 'DELETE', password: 'my-password-1' } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('a Google-only account is not asked for a password', async () => {
    api.del.mockResolvedValue({});
    mount(false);
    await open();
    expect(screen.queryByLabelText('Your password')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    expect(api.del).toHaveBeenCalledWith('/account', { data: { confirm: 'DELETE', password: undefined } });
  });

  it('shows a wrong password and stays put', async () => {
    api.del.mockRejectedValue(new ApiError('WRONG_PASSWORD', 'Enter your current password to delete this account.', 403));
    mount(true);
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your password'), 'nope-nope-1');
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your current password to delete this account.');
    expect(assign).not.toHaveBeenCalled();
  });
});
