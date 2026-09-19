import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, LogIn, LogOut, Palmtree, Plus } from 'lucide-react';
import { formatClockDuration, formatDuration, istClock, istClockSeconds } from '@oht/engine';
import { AddSessionDialog } from '@/components/AddSessionDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { SessionList } from '@/components/SessionList';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Banner, Card, CardTitle, ErrorState, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { dayLabel, prettyDate } from '@/lib/dates';
import { useCheckIn, useCheckOut, useDashboard } from '@/lib/queries';
import { dayMessage, dayStatus, toneSolid, type StatusInfo } from '@/lib/status';
import { liveFigures, serverClock } from '@/lib/liveClock';
import { useNow } from '@/lib/useNow';
import type { Dashboard } from '@/lib/types';

function TodaySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading today">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-80" />
      <Skeleton className="h-14" />
      <Skeleton className="h-40" />
    </div>
  );
}

export default function Today() {
  const q = useDashboard();
  // Tick every second while checked in (so the seconds run), and rarely otherwise.
  const tick = useNow(q.data?.today.isInside ? 1000 : 15_000);
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();
  const [addOpen, setAddOpen] = useState(false);

  if (q.isLoading) return <TodaySkeleton />;
  if (q.isError || !q.data) {
    return <ErrorState message={q.error instanceof ApiError ? q.error.message : "Can't load today."} onRetry={() => q.refetch()} />;
  }

  const data: Dashboard = q.data;
  const day = data.today;

  // Before the tracking start date nothing is counted or recorded, so say so instead of offering buttons.
  if (day.kind === 'BEFORE_TRACKING') {
    return (
      <div className="flex flex-col gap-4">
        <header>
          <p className="text-sm text-ink-soft">{prettyDate(day.date)}</p>
        </header>
        <Card className="py-10 text-center">
          <p className="text-lg font-semibold">Tracking starts on {prettyDate(data.trackingStartDate)}</p>
          <p className="mt-1 text-sm text-ink-soft">Nothing before that date is counted, so there is nothing to record today.</p>
        </Card>
        <Link to="/leave">
          <Card className="flex items-center gap-3 hover:bg-muted">
            <Palmtree className="text-leave" size={20} aria-hidden />
            <span className="num flex-1 text-sm font-medium">
              Annual leave {data.leave.annualBalance.toFixed(2)} · Optional {data.leave.optionalRemaining}
            </span>
            <ChevronRight size={18} className="text-ink-soft" aria-hidden />
          </Card>
        </Link>
      </div>
    );
  }

  // Every live figure comes from the SERVER's clock (its answer plus the time elapsed since), so a phone and a laptop
  // show the same second even if one device clock is wrong or in another time zone.
  const serverNow = serverClock(data.now, q.dataUpdatedAt, tick);
  const openSession = day.sessions.find((s) => s.outTime === null);
  const figures = liveFigures({
    workedMinutes: day.workedMinutes,
    requiredMinutes: day.requiredMinutes,
    isInside: day.isInside,
    openInMs: openSession ? Date.parse(openSession.inTime) : null,
    fetchNowMs: Date.parse(data.now),
    nowMs: serverNow,
  });
  const worked = Math.floor(figures.workedSeconds / 60);
  const required = day.requiredMinutes;
  const remaining = Math.max(0, required - worked);
  const overtime = required > 0 ? Math.max(0, worked - required) : 0;

  const live = day.live;
  const status = dayStatus(day);
  const officePill: StatusInfo | null =
    required > 0
      ? day.isInside
        ? { label: 'Inside office', tone: 'ok', icon: 'clock' }
        : live.status === 'OUTSIDE'
          ? { label: 'Outside', tone: 'warn', icon: 'clock' }
          : live.status === 'COMPLETED' || (worked >= required && day.sessionCount > 0)
            ? { label: 'Target met', tone: 'ok', icon: 'check' }
            : { label: 'Not checked in', tone: 'neutral', icon: 'dot' }
      : null;

  const actionError = checkIn.error ?? checkOut.error;
  const staleOpen = checkOut.error?.code === 'OPEN_SESSION_FROM_PAST' ? (checkOut.error.details as { date: string } | undefined) : undefined;
  const inClock = day.sessions.find((s) => s.outTime === null)?.inClock;
  const nowClock = istClockSeconds(serverNow);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-ink-soft">{prettyDate(day.date)}</p>
          <p className="num text-3xl font-semibold" aria-label="Current time">
            {nowClock}
          </p>
        </div>
        {officePill && <StatusPill status={officePill} pulse={day.isInside} />}
      </header>

      {data.alerts.incompleteDates.map((d) => (
        <Banner
          key={d}
          tone="bad"
          action={
            <Link to={`/day/${d}`} className="shrink-0 font-semibold underline">
              Fix it
            </Link>
          }
        >
          {dayLabel(d)} has no OUT time.
        </Banner>
      ))}
      {data.alerts.unrecordedDates.length > 0 && (
        <Banner
          tone="warn"
          action={
            <Link to={`/day/${data.alerts.unrecordedDates[0]}`} className="shrink-0 font-semibold underline">
              Review
            </Link>
          }
        >
          {data.alerts.unrecordedDates.length} working day{data.alerts.unrecordedDates.length > 1 ? 's have' : ' has'} no record.
        </Banner>
      )}
      {data.leave.yearEnd && data.leave.yearEnd.willLapse > 0 && (
        <Banner tone="warn">
          {data.leave.yearEnd.balance.toFixed(2)} leaves left. Only {data.leave.yearEnd.carryForward.toFixed(2)} carry forward,{' '}
          {data.leave.yearEnd.willLapse.toFixed(2)} will lapse.
        </Banner>
      )}
      {actionError && (
        <Banner
          tone="bad"
          action={
            staleOpen ? (
              <Link to={`/day/${staleOpen.date}`} className="shrink-0 font-semibold underline">
                Fix it
              </Link>
            ) : undefined
          }
        >
          {actionError.message}
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            {required > 0 ? (
              <>
                <ProgressRing fraction={figures.workedSeconds / (required * 60)}>
                  <span className="num text-5xl font-semibold" role="timer" aria-live="off" aria-label="Worked today">
                    {formatClockDuration(figures.workedSeconds)}
                  </span>
                  <span className="text-sm text-ink-soft">worked today</span>
                </ProgressRing>
                <div className="mt-5 grid grid-cols-3 divide-x divide-line text-center">
                  <div>
                    <div className="text-xs text-ink-soft">Required</div>
                    <div className="num text-xl font-semibold">{formatDuration(required)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-ink-soft">{overtime > 0 ? 'Overtime' : 'Remaining'}</div>
                    <div className="num text-xl font-semibold" role="timer" aria-live="off" aria-label={overtime > 0 ? 'Overtime' : 'Time remaining'}>
                      {formatClockDuration(overtime > 0 ? figures.overtimeSeconds : figures.remainingSeconds)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-ink-soft">Expected OUT</div>
                    <div className="num text-xl font-semibold">
                      {day.isInside && remaining > 0 ? live.expectedOutClock : '–'}
                    </div>
                  </div>
                </div>
                {day.isInside && openSession && (
                  <p className="mt-4 text-center text-sm text-ink-soft">
                    This session <span className="num font-semibold text-ink" role="timer" aria-live="off" aria-label="This session">{formatClockDuration(figures.sessionSeconds)}</span>
                    {' '}· since <span className="num">{openSession.inClock}</span>
                  </p>
                )}
                <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-center text-sm" aria-live="polite">
                  {dayMessage(required, worked)}
                </p>
                {!day.isInside && remaining > 0 && live.ifCheckInNowOutClock && (
                  <p className="mt-2 text-center text-xs text-ink-soft">
                    If you check in now, expected OUT is <span className="num font-medium">{live.ifCheckInNowOutClock}</span>.
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <StatusPill status={status} />
                <p className="text-lg font-semibold">{status.label === 'Holiday' ? 'No work today' : dayMessage(0, 0)}</p>
                <p className="text-sm text-ink-soft">Nothing is required, and no missing-hours warning applies.</p>
              </div>
            )}
          </Card>

          <div className="flex flex-col items-center gap-2">
            {day.isInside ? (
              <Button variant="danger" size="lg" disabled={checkOut.isPending} onClick={() => checkOut.mutate()}>
                <LogOut size={20} aria-hidden /> {checkOut.isPending ? 'Checking out…' : 'Check Out'}
              </Button>
            ) : (
              <Button size="lg" disabled={checkIn.isPending} onClick={() => checkIn.mutate()}>
                <LogIn size={20} aria-hidden /> {checkIn.isPending ? 'Checking in…' : 'Check In'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={16} aria-hidden /> Add session manually
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle right={inClock ? <span className="num text-xs text-ink-soft">since {inClock}</span> : undefined}>
              Today&apos;s sessions
            </CardTitle>
            <SessionList sessions={day.sessions} isToday nowMs={serverNow} />
          </Card>

          <Card>
            <CardTitle right={<Link to="/summary" className="text-xs font-medium text-primary">Details</Link>}>This week</CardTitle>
            <p className="num text-base">
              Worked <span className="font-semibold">{formatDuration(data.week.workedMinutes)}</span> of{' '}
              <span className="font-semibold">{formatDuration(data.week.requiredMinutes)}</span>
            </p>
            {(data.week.counts.leaveDays > 0 || data.week.counts.holidays > 0 || data.week.counts.birthdayDays > 0) && (
              <p className="mt-0.5 text-xs text-ink-soft">
                Required is {formatDuration(data.week.requiredMinutes)} because of{' '}
                {data.week.counts.leaveDays + data.week.counts.holidays + data.week.counts.birthdayDays} leave/holiday day
                {data.week.counts.leaveDays + data.week.counts.holidays + data.week.counts.birthdayDays > 1 ? 's' : ''}.
              </p>
            )}
            <div className="mt-3 grid grid-flow-col auto-cols-fr gap-2">
              {data.week.days
                .filter((d) => d.kind !== 'WEEKLY_OFF')
                .map((d) => {
                  const s = dayStatus(d);
                  return (
                    <Link key={d.date} to={`/day/${d.date}`} className="flex flex-col items-center gap-1 text-center" aria-label={`${dayLabel(d.date)}: ${s.label}`}>
                      <span className={`h-2.5 w-full rounded-full ${toneSolid[s.tone]}`} />
                      <span className="text-xs font-medium">{dayLabel(d.date).slice(0, 3)}</span>
                      <span className="num text-[11px] text-ink-soft">
                        {d.requiredMinutes === 0 ? s.label : d.workedMinutes > 0 ? formatDuration(d.workedMinutes) : '–'}
                      </span>
                    </Link>
                  );
                })}
            </div>
            <p className={`num mt-3 text-sm font-semibold ${data.week.balanceMinutes < 0 ? 'text-[#8a6300]' : 'text-ok'}`}>
              Balance {formatDuration(data.week.balanceMinutes, { signed: true })}
            </p>
            {data.week.nudge && <p className="mt-1 text-xs text-ink-soft">{data.week.nudge}</p>}
          </Card>

          <Link to="/leave">
            <Card className="flex items-center gap-3 hover:bg-muted">
              <Palmtree className="text-leave" size={20} aria-hidden />
              <span className="num flex-1 text-sm font-medium">
                Annual leave {data.leave.annualBalance.toFixed(2)} · Optional {data.leave.optionalRemaining}
              </span>
              <ChevronRight size={18} className="text-ink-soft" aria-hidden />
            </Card>
          </Link>
        </div>
      </div>

      <AddSessionDialog date={day.date} open={addOpen} onOpenChange={setAddOpen} defaultIn={nowClock} />
    </div>
  );
}
