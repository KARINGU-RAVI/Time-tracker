import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '@/App';
import { useDashboard, useDay, useDeleteHoliday, useHolidayImage, useHolidays, useLeave, useRules, useWeek } from './queries';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), putBinary: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const T0 = new Date('2026-09-20T10:00:00Z').getTime();
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const callsTo = (url: string) => api.get.mock.calls.filter((c) => c[0] === url).length;

/** Opens a screen's data, waits for it, then closes the screen again (as when moving between pages). */
async function visit(hook: () => { isSuccess: boolean }) {
  const r = renderHook(hook, { wrapper });
  await waitFor(() => expect(r.result.current.isSuccess).toBe(true));
  r.unmount();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  Object.values(api).forEach((m) => m.mockReset());
  api.get.mockImplementation(async (url: string) => ({ url, exists: false, holidays: [], summary: { company: 0, optional: 0 }, rules: [] }));
  client = makeQueryClient();
});
afterEach(() => vi.useRealTimers());

describe('reference data is reused for 5 minutes', () => {
  it.each([
    ['holidays', '/holidays', () => useHolidays(2026)],
    ['work rules', '/rules', () => useRules()],
    ['the calendar picture', '/holidays/image', () => useHolidayImage()],
  ])('%s: opening the screen again within 5 minutes does not ask the server', async (_name, url, hook) => {
    await visit(hook);
    expect(callsTo(url)).toBe(1);
    advance(4 * 60_000 + 59_000);
    await visit(hook);
    expect(callsTo(url)).toBe(1); // reused
    advance(2_000); // now over 5 minutes since it was fetched
    await visit(hook);
    expect(callsTo(url)).toBe(2);
  });
});

describe('day, week and leave data is reused for 1 minute', () => {
  it.each([
    ['a day', '/attendance/2026-09-17', () => useDay('2026-09-17')],
    ['a week summary', '/summary/week', () => useWeek('2026-09-17')],
    ['the leave balance', '/leave', () => useLeave()],
  ])('%s', async (_name, url, hook) => {
    await visit(hook);
    advance(59_000);
    await visit(hook);
    expect(callsTo(url)).toBe(1);
    advance(2_000);
    await visit(hook);
    expect(callsTo(url)).toBe(2);
  });
});

describe("today's figures are reused for only 15 seconds", () => {
  it('a quick return to the screen is free, a later one refreshes', async () => {
    await visit(() => useDashboard());
    advance(14_000);
    await visit(() => useDashboard());
    expect(callsTo('/dashboard')).toBe(1);
    advance(2_000);
    await visit(() => useDashboard());
    expect(callsTo('/dashboard')).toBe(2);
  });
});

describe('requests are not repeated needlessly', () => {
  it('two screens asking for the same thing at the same moment make one request', async () => {
    const a = renderHook(() => useRules(), { wrapper });
    const b = renderHook(() => useRules(), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(true));
    expect(callsTo('/rules')).toBe(1);
  });

  it('different questions are kept apart: another year of holidays is its own request, but each year is reused', async () => {
    await visit(() => useHolidays(2026));
    await visit(() => useHolidays(2027));
    await visit(() => useHolidays(2026));
    await visit(() => useHolidays(2027));
    expect(api.get.mock.calls.filter((c) => c[0] === '/holidays').map((c) => (c[1] as { year: number }).year)).toEqual([2026, 2027]);
  });

  it('answers are kept for 10 minutes after the screen closes, so coming back is instant', async () => {
    await visit(() => useLeave());
    expect(client.getQueryData(['leave'])).toBeDefined();
    advance(9 * 60_000);
    client.getQueryCache().findAll(); // nothing removes it yet
    expect(client.getQueryData(['leave'])).toBeDefined();
  });
});

describe('a save always refreshes everything (a person must see their own change at once)', () => {
  it('marks even fresh data stale, so it is asked for again', async () => {
    api.del.mockResolvedValue(undefined);
    await visit(() => useRules());
    await visit(() => useHolidays(2026));
    expect(callsTo('/rules')).toBe(1); // still well inside its 5 minutes

    const del = renderHook(() => useDeleteHoliday(), { wrapper });
    del.result.current.mutate('some-id');
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    await visit(() => useRules());
    await visit(() => useHolidays(2026));
    expect(callsTo('/rules')).toBe(2); // refreshed although only seconds old
    expect(callsTo('/holidays')).toBe(2);
  });
});

describe('the default settings of the app', () => {
  it('keep answers 30 s by default and 10 minutes in memory, and retry only network failures', () => {
    const d = makeQueryClient().getDefaultOptions().queries!;
    expect(d.staleTime).toBe(30_000);
    expect(d.gcTime).toBe(10 * 60_000);
    expect(d.refetchOnReconnect).toBe(true);
    expect(makeQueryClient().getDefaultOptions().mutations!.retry).toBe(false);
  });
});
