import axios, { AxiosError } from 'axios';

/** The single, user-friendly error shape the whole UI works with. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork(): boolean {
    return this.code === 'NETWORK_ERROR';
  }
}

export const http = axios.create({
  baseURL: '/api',
  timeout: 20_000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

/** Turns any axios failure into an ApiError, so components never see raw axios errors. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (axios.isAxiosError(e)) {
    const err = e as AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>;
    if (!err.response) {
      return new ApiError(
        'NETWORK_ERROR',
        "Can't reach the server. Check your connection and try again.",
        0,
      );
    }
    const body = err.response.data?.error;
    return new ApiError(
      body?.code ?? 'UNKNOWN_ERROR',
      body?.message ?? 'Something went wrong. Please try again.',
      err.response.status,
      body?.details,
    );
  }
  return new ApiError('UNKNOWN_ERROR', 'Something went wrong. Please try again.', 0);
}

type UnauthorizedListener = () => void;
let onUnauthorized: UnauthorizedListener | null = null;
export function setUnauthorizedListener(fn: UnauthorizedListener | null) {
  onUnauthorized = fn;
}

http.interceptors.response.use(
  (r) => r,
  (e) => {
    const err = toApiError(e);
    // 401: the session ended. SETUP_REQUIRED: the account still has to finish setup. Either way, re-check who is signed in.
    if ((err.status === 401 || err.code === 'SETUP_REQUIRED') && onUnauthorized) onUnauthorized();
    return Promise.reject(err);
  },
);

export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  return (await http.get<T>(url, { params })).data;
}
export async function post<T>(url: string, body?: unknown): Promise<T> {
  return (await http.post<T>(url, body)).data;
}
export async function put<T>(url: string, body?: unknown): Promise<T> {
  return (await http.put<T>(url, body)).data;
}
/** Uploads raw bytes (a picture) with its own content type, instead of JSON. */
export async function putBinary<T>(url: string, body: Blob, contentType: string, params?: Record<string, unknown>): Promise<T> {
  return (await http.put<T>(url, body, { params, headers: { 'Content-Type': contentType }, timeout: 60_000 })).data;
}
export async function del<T = void>(url: string): Promise<T> {
  return (await http.delete<T>(url)).data;
}
