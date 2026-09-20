import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, del, get, http, post, setUnauthorizedListener } from './api';

/** Replaces the network with a fixed answer, so the real interceptors run. */
function answer(status: number, error?: { code: string; message: string }) {
  http.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const res = { data: error ? { error } : { ok: true }, status, statusText: '', headers: {}, config };
    if (status >= 400) throw new AxiosError('failed', String(status), config, null, res);
    return res;
  };
}

const listener = vi.fn();
const original = http.defaults.adapter;
beforeEach(() => {
  listener.mockReset();
  setUnauthorizedListener(listener);
});
afterEach(() => {
  setUnauthorizedListener(null);
  http.defaults.adapter = original;
});

describe('when the app re-checks who is signed in', () => {
  it('does so when a normal request comes back 401 (the session ended)', async () => {
    answer(401, { code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    await expect(get('/dashboard')).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    await expect(post('/attendance/check-in')).rejects.toBeInstanceOf(ApiError);
    await expect(del('/holidays/x')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does NOT when a sign-in or password form gets a 401 (wrong password): that would rebuild the page and wipe the form and its message', async () => {
    answer(401, { code: 'INVALID_LOGIN', message: 'Email or password is incorrect.' });
    for (const url of ['/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password', '/auth/verify-email', '/auth/resend-verification', '/auth/google']) {
      await expect(post(url, {})).rejects.toMatchObject({ code: 'INVALID_LOGIN', message: 'Email or password is incorrect.', status: 401 });
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('still does for the session check itself', async () => {
    answer(401, { code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    await expect(get('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does when the account has not finished setup', async () => {
    answer(403, { code: 'SETUP_REQUIRED', message: 'Finish setting up your account first.' });
    await expect(get('/leave')).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not for other failures (a refused request, a missing page, a server error)', async () => {
    for (const status of [400, 403, 404, 409, 429, 500]) {
      answer(status, { code: 'SOMETHING', message: 'nope' });
      await expect(get('/leave')).rejects.toMatchObject({ status });
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('a request that never reached the server is reported as a connection problem, not a sign-out', async () => {
    http.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    };
    await expect(get('/dashboard')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(listener).not.toHaveBeenCalled();
  });
});
