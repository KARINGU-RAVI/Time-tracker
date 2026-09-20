import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, del, get, post, put } from './api';
import type {
  AttendanceStatus,
  Dashboard,
  Day,
  DayDetail,
  Holiday,
  ImportRow,
  LeavePreview,
  LeaveSummary,
  Period,
  WorkRule,
} from './types';

/** Data older than this is refetched on focus. Attendance changes rarely, but "now" must stay right. */
const STALE_MS = 15_000;

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<Dashboard>('/dashboard'),
    staleTime: STALE_MS,
    // Another device may have checked in or out: look again often while the screen is open, and whenever it is switched back to.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useDay(date: string) {
  return useQuery({ queryKey: ['day', date], queryFn: () => get<DayDetail>(`/attendance/${date}`), staleTime: STALE_MS });
}

export function useRange(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['range', startDate, endDate],
    queryFn: () => get<{ days: Day[] }>('/attendance', { startDate, endDate }),
    staleTime: STALE_MS,
  });
}

export function useWeek(date: string) {
  return useQuery({ queryKey: ['week', date], queryFn: () => get<Period>('/summary/week', { date }), staleTime: STALE_MS });
}

export function useMonth(year: number, month: number) {
  return useQuery({
    queryKey: ['month', year, month],
    queryFn: () => get<Period>('/summary/month', { year, month }),
    staleTime: STALE_MS,
  });
}

export function useLeave() {
  return useQuery({ queryKey: ['leave'], queryFn: () => get<LeaveSummary>('/leave'), staleTime: STALE_MS });
}

export function useHolidays(year: number) {
  return useQuery({
    queryKey: ['holidays', year],
    queryFn: () => get<{ holidays: Holiday[]; summary: { company: number; optional: number } }>('/holidays', { year }),
  });
}

export function useRules() {
  return useQuery({ queryKey: ['rules'], queryFn: () => get<{ rules: WorkRule[] }>('/rules') });
}

/**
 * Anything that changes attendance, leave or holidays can change many derived numbers
 * (day, week, month, balances), so all cached data is refreshed. Simple and always correct.
 */
function useRefreshAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useCheckIn() {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError>({ mutationFn: () => post('/attendance/check-in'), onSuccess: refresh });
}

export function useCheckOut() {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError>({ mutationFn: () => post('/attendance/check-out'), onSuccess: refresh });
}

export interface SessionInput {
  inTime: string;
  outTime: string | null;
}

export function useAddSession(date: string) {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError, SessionInput>({
    mutationFn: (b) => post(`/attendance/${date}/sessions`, b),
    onSuccess: refresh,
  });
}

export function useUpdateSession() {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError, { id: string; body: Partial<SessionInput> }>({
    mutationFn: ({ id, body }) => put(`/sessions/${id}`, body),
    onSuccess: refresh,
  });
}

export function useDeleteSession() {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError, string>({ mutationFn: (id) => del<DayDetail>(`/sessions/${id}`), onSuccess: refresh });
}

export interface DayInput {
  status: AttendanceStatus;
  dayFraction: 1 | 0.5;
  notes: string | null;
  managerInformed?: boolean;
  bereavementEventId?: string | null;
}

export function useSetDay(date: string) {
  const refresh = useRefreshAll();
  return useMutation<DayDetail, ApiError, DayInput>({ mutationFn: (b) => put(`/attendance/${date}`, b), onSuccess: refresh });
}

export function useDeleteDay(date: string) {
  const refresh = useRefreshAll();
  return useMutation<void, ApiError>({ mutationFn: () => del(`/attendance/${date}`), onSuccess: refresh });
}

export interface LeaveInput {
  type: 'CASUAL_LEAVE' | 'SICK_LEAVE' | 'BEREAVEMENT_LEAVE' | 'OPTIONAL_HOLIDAY' | 'BIRTHDAY_LEAVE';
  startDate: string;
  endDate: string;
  half: boolean;
  managerInformed?: boolean;
  bereavementEventId?: string | null;
}

export function useLeavePreview() {
  return useMutation<LeavePreview, ApiError, LeaveInput>({ mutationFn: (b) => post('/leave/preview', b) });
}

export function useApplyLeave() {
  const refresh = useRefreshAll();
  return useMutation<{ applied: string[]; paid: number; lop: number; warning: string | null }, ApiError, LeaveInput>({
    mutationFn: (b) => post('/leave/apply', b),
    onSuccess: refresh,
  });
}

export function useAddBereavementEvent() {
  const refresh = useRefreshAll();
  return useMutation<unknown, ApiError, { relation: string; startDate: string }>({
    mutationFn: (b) => post('/leave/bereavement-events', b),
    onSuccess: refresh,
  });
}

export function useAddHoliday() {
  const refresh = useRefreshAll();
  return useMutation<unknown, ApiError, { date: string; name: string; type: 'COMPANY' | 'OPTIONAL' }>({
    mutationFn: (b) => post('/holidays', b),
    onSuccess: refresh,
  });
}

export function useDeleteHoliday() {
  const refresh = useRefreshAll();
  return useMutation<void, ApiError, string>({ mutationFn: (id) => del(`/holidays/${id}`), onSuccess: refresh });
}

export function useImportPreview() {
  return useMutation<
    { rows: ImportRow[]; summary: { new: number; duplicates: number; errors: number } },
    ApiError,
    string
  >({ mutationFn: (csv) => post('/holidays/import/preview', { csv }) });
}

export function useImportCommit() {
  const refresh = useRefreshAll();
  return useMutation<
    { imported: number; overwritten: number; skippedDuplicates: number; errors: number },
    ApiError,
    { csv: string; duplicates: 'skip' | 'overwrite' }
  >({ mutationFn: (b) => post('/holidays/import/commit', b), onSuccess: refresh });
}

/** Who is signed in. 404 means the backend runs in dev mode (no sign-in). */
export type SessionState =
  | { mode: 'dev' }
  | { mode: 'google'; email: string; name: string | null; setupComplete: boolean; isAdmin: boolean; hasPassword: boolean };

export function useSession() {
  return useQuery<SessionState, ApiError>({
    queryKey: ['session'],
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        const r = await get<{ user: { email: string; name?: string | null; setupComplete?: boolean; isAdmin?: boolean; hasPassword?: boolean } }>('/auth/me');
        // The server gates every route until setup is done, so treating "unknown" as done cannot open anything.
        return { mode: 'google', email: r.user.email, name: r.user.name ?? null, setupComplete: r.user.setupComplete !== false, isAdmin: r.user.isAdmin === true, hasPassword: r.user.hasPassword === true };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { mode: 'dev' };
        throw e;
      }
    },
  });
}
