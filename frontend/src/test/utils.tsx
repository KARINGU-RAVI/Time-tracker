import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Day, DayDetail, LeaveSummary, Period } from '@/lib/types';

export function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/** Renders a page at a route, with routing and data-fetching providers. */
export function renderAt(path: string, routePattern: string, element: ReactElement) {
  return render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const makeDay = (over: Partial<Day> = {}): Day => ({
  date: '2026-09-15',
  kind: 'WORKING',
  isToday: false,
  isFuture: false,
  requiredMinutes: 480,
  workedMinutes: 480,
  offDayWorkedMinutes: 0,
  outsideMinutes: 0,
  sessionCount: 1,
  firstIn: null,
  firstInClock: '08:00',
  lastOut: null,
  lastOutClock: '16:00',
  balanceMinutes: 0,
  overtimeMinutes: 0,
  isInside: false,
  isIncomplete: false,
  isUnrecorded: false,
  leaveUse: null,
  warnings: [],
  ...over,
});

export const makeDetail = (over: Partial<DayDetail> = {}, day: Partial<Day> = {}): DayDetail => ({
  day: makeDay(day),
  status: 'WORKING',
  dayFraction: 1,
  halfDayPart: null,
  notes: null,
  managerInformed: false,
  bereavementEventId: null,
  sessions: [],
  live: null,
  message: null,
  ...over,
});

export const makePeriod = (over: Partial<Period> = {}): Period => ({
  start: '2026-09-14',
  end: '2026-09-20',
  throughDate: '2026-09-20',
  requiredMinutes: 1920,
  requiredFullPeriodMinutes: 1920,
  workedMinutes: 1820,
  balanceMinutes: -100,
  periodOvertimeMinutes: 0,
  dailyOvertimeMinutes: 0,
  offDayWorkedMinutes: 0,
  counts: { working: 4, wfh: 0, leaveDays: 1, optionalHolidays: 0, bereavementDays: 0, birthdayDays: 0, holidays: 0, weeklyOffs: 2 },
  incompleteDates: [],
  unrecordedDates: [],
  days: [],
  ...over,
});

export const makeLeave = (over: Partial<LeaveSummary> = {}): LeaveSummary => ({
  asOf: '2026-09-18',
  year: 2026,
  annual: { balance: 12.75, carriedIn: 2, accruedThisYear: 15.75, usedThisYear: 5, nextCredit: { date: '2026-10-01', days: 1.75 } },
  optional: { quota: 2, used: 1, remaining: 1 },
  trackingStartDate: '2026-09-01',
  earlier: [],
  birthday: { quota: 0.5, used: 0.5, remaining: 0 },
  lopByMonth: {},
  ledger: [
    { date: '2026-01-01', kind: 'OPENING', note: 'Carried forward from 2025', days: 2, running: 2 },
    { date: '2026-09-19', kind: 'ADJUSTMENT', note: 'Leave taken before tracking began', days: -5, running: 12.75 },
  ],
  yearEnd: null,
  bereavement: { maxDaysPerEvent: 5, events: [] },
  ...over,
});
