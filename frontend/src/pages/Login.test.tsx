import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import ForgotPassword from '@/pages/auth/ForgotPassword';
import ResetPassword from '@/pages/auth/ResetPassword';
import VerifyEmail from '@/pages/auth/VerifyEmail';
import Login from '@/pages/Login';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const STRONG = 'correct horse battery';

function mount(ui = <Login />, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, invalidate };
}

beforeEach(() => Object.values(api).forEach((m) => m.mockReset()));

describe('sign in', () => {
  it('sends the email and password, then refreshes the session', async () => {
    api.post.mockResolvedValue({ user: {} });
    const { invalidate } = mount();
    const user = userEvent.setup();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled(); // nothing typed yet
    await user.type(screen.getByLabelText('Email'), 'me@example.test');
    await user.type(screen.getByLabelText('Password'), 'my-password-1');
    await user.click(submit);
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'me@example.test', password: 'my-password-1' });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it('shows the server message for a wrong password, keeps what was typed, and does not refresh the session', async () => {
    api.post.mockRejectedValue(new ApiError('INVALID_LOGIN', 'Email or password is incorrect.', 401));
    const { invalidate } = mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'me@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByLabelText('Email')).toHaveValue('me@example.test');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('explains a locked account and a rate limit in the words the server gave', async () => {
    api.post.mockRejectedValue(new ApiError('ACCOUNT_LOCKED', 'Too many wrong passwords. Try again in a few minutes, or reset your password.', 429));
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'me@example.test');
    await user.type(screen.getByLabelText('Password'), 'whatever-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many wrong passwords/);
  });

  it('moves an unverified account to the "check your email" screen', async () => {
    api.post.mockRejectedValue(new ApiError('EMAIL_NOT_VERIFIED', 'Please verify your email first.', 403));
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'me@example.test');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('me@example.test')).toBeInTheDocument();
  });

  it('has a working link to reset the password, and hides/shows the password', async () => {
    mount();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
    const pw = screen.getByLabelText('Password');
    expect(pw).toHaveAttribute('type', 'password');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw).toHaveAttribute('type', 'text');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide password' }));
    expect(pw).toHaveAttribute('type', 'password');
  });
});

describe('create account', () => {
  async function openSignup() {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: 'Create account' }));
    return user;
  }

  it('shows the live password rules and the confirm field', async () => {
    const user = await openSignup();
    const rules = screen.getByRole('list', { name: 'Password rules' });
    expect(rules).toHaveTextContent('At least 10 characters');
    expect(rules).toHaveTextContent('Not a commonly used password');
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'short');
    expect(rules).toHaveTextContent(/At least 10 characters\s*not met yet/);
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'password123');
    expect(rules).toHaveTextContent(/At least 10 characters\s*met/);
    expect(rules).toHaveTextContent(/Not a commonly used password\s*not met yet/); // common password
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), STRONG);
    expect(rules).toHaveTextContent(/Not a commonly used password\s*met/);
  });

  it('refuses mismatched passwords without contacting the server', async () => {
    const user = await openSignup();
    await user.type(screen.getByLabelText('Email'), 'new@example.test');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), 'something else entirely');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('registers, then tells the person to check their email', async () => {
    api.post.mockResolvedValue({ status: 'verification_sent' });
    const user = await openSignup();
    await user.type(screen.getByLabelText('Email'), 'new@example.test');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(api.post).toHaveBeenCalledWith('/auth/register', { email: 'new@example.test', password: STRONG, turnstileToken: undefined });
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('new@example.test')).toBeInTheDocument();
  });

  it.each([
    ['SIGNUPS_FULL', 'Sign-ups are full right now. Please try again later.', 503],
    ['TOO_MANY_REQUESTS', 'Too many attempts. Please wait a little and try again.', 429],
    ['WEAK_PASSWORD', 'That password is too common. Choose another.', 400],
    ['BOT_CHECK_FAILED', 'The human check did not pass. Please try again.', 400],
  ])('shows %s from the server', async (code, message, status) => {
    api.post.mockRejectedValue(new ApiError(code, message, status));
    const user = await openSignup();
    await user.type(screen.getByLabelText('Email'), 'new@example.test');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.type(screen.getByLabelText('Confirm password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('heading', { name: 'Check your email' })).not.toBeInTheDocument();
  });

  it('clears the passwords when switching between the tabs', async () => {
    const user = await openSignup();
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('tab', { name: 'Sign in' }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
  });
});

describe('check your email', () => {
  it('starts with the resend button counting down and disabled', async () => {
    api.post.mockRejectedValue(new ApiError('EMAIL_NOT_VERIFIED', 'x', 403));
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'me@example.test');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const resend = await screen.findByRole('button', { name: /Resend in 1:00/ });
    expect(resend).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(await screen.findByRole('tab', { name: 'Sign in' })).toBeInTheDocument(); // back to the form
  });
});

describe('verify email link', () => {
  it('confirms once and offers to continue', async () => {
    api.post.mockResolvedValue({});
    mount(<VerifyEmail />, '/verify-email?token=tok123');
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/auth/verify-email', { token: 'tok123' });
  });

  it('says so when the link is used or expired, and when it is incomplete', async () => {
    api.post.mockRejectedValue(new ApiError('INVALID_TOKEN', 'This link has expired or was already used.', 400));
    const first = mount(<VerifyEmail />, '/verify-email?token=old');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
    first.unmount();
    api.post.mockReset();
    mount(<VerifyEmail />, '/verify-email');
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete/);
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('forgot password', () => {
  it('shows the same neutral message whatever the server knows', async () => {
    api.post.mockResolvedValue({ status: 'reset_link_sent_if_account_exists' });
    mount(<ForgotPassword />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'anyone@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(api.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'anyone@example.test', turnstileToken: undefined });
    expect(await screen.findByRole('status')).toHaveTextContent('If an account exists for this email, a reset link is on its way.');
  });
});

describe('reset password', () => {
  it('checks the two passwords match, sends the token and the new password, and refreshes the session', async () => {
    api.post.mockResolvedValue({});
    const { invalidate } = mount(<ResetPassword />, '/reset-password?token=abc');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Confirm new password'), 'different-one-1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(api.post).toHaveBeenCalledWith('/auth/reset-password', { token: 'abc', password: STRONG });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it('offers a new link when the old one is dead or missing', async () => {
    api.post.mockRejectedValue(new ApiError('INVALID_TOKEN', 'This link has expired or was already used.', 400));
    mount(<ResetPassword />, '/reset-password?token=old');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Confirm new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('This link has expired or was already used.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('a weak password is reported by the server without losing the form', async () => {
    api.post.mockRejectedValue(new ApiError('WEAK_PASSWORD', 'Use at least 10 characters.', 400));
    mount(<ResetPassword />, '/reset-password?token=abc');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 10 characters.');
    expect(screen.getByLabelText('New password')).toHaveValue('short');
  });
});
