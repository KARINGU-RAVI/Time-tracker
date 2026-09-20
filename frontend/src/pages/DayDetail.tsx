import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { formatDuration } from '@oht/engine';
import { AddSessionDialog } from '@/components/AddSessionDialog';
import { SessionList } from '@/components/SessionList';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Banner, Card, CardTitle, ErrorState, Skeleton, inputClass } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { addDays, prettyDate } from '@/lib/dates';
import { useDay, useDeleteDay, useDeleteSession, useLeave, useSetDay } from '@/lib/queries';
import { dayStatus } from '@/lib/status';
import type { AttendanceStatus, Session } from '@/lib/types';

const STATUS_OPTIONS: Array<{ value: AttendanceStatus; label: string }> = [
  { value: 'WORKING', label: 'Working' },
  { value: 'WFH', label: 'WFH' },
  { value: 'CASUAL_LEAVE', label: 'Casual leave' },
  { value: 'SICK_LEAVE', label: 'Sick leave' },
  { value: 'BEREAVEMENT_LEAVE', label: 'Death in family' },
  { value: 'OPTIONAL_HOLIDAY', label: 'Optional holiday' },
  { value: 'BIRTHDAY_LEAVE', label: 'Birthday half-day' },
];

const isLeave = (s: AttendanceStatus) => s !== 'WORKING' && s !== 'WFH';

export default function DayDetail() {
  const { date = '' } = useParams();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const q = useDay(validDate ? date : '2000-01-01');
  const setDay = useSetDay(date);
  const delDay = useDeleteDay(date);
  const delSession = useDeleteSession();
  const leave = useLeave();
  const navigate = useNavigate();

  const [status, setStatus] = useState<AttendanceStatus>('WORKING');
  const [half, setHalf] = useState(false);
  const [notes, setNotes] = useState('');
  const [informed, setInformed] = useState(false);
  const [eventId, setEventId] = useState<string>('');
  const [dialog, setDialog] = useState<{ open: boolean; session?: Session }>({ open: false });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const data = q.data;
  useEffect(() => {
    if (!data) return;
    setStatus(data.status ?? 'WORKING');
    setHalf(data.dayFraction === 0.5);
    setNotes(data.notes ?? '');
    setInformed(data.managerInformed);
    setEventId(data.bereavementEventId ?? '');
  }, [data]);

  if (!validDate) return <ErrorState message="That is not a valid date." />;
  if (q.isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-36" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (q.isError || !data) return <ErrorState message={q.error?.message ?? "Can't load this day."} onRetry={() => q.refetch()} />;

  const { day } = data;
  const st = dayStatus(day);
  const birthday = status === 'BIRTHDAY_LEAVE';
  const halfAllowed = status === 'CASUAL_LEAVE' || status === 'SICK_LEAVE' || birthday;
  const hasRecord = data.status !== null;
  const events = leave.data?.bereavement.events ?? [];

  function save() {
    setSaved(false);
    setDay.mutate(
      {
        status,
        dayFraction: birthday || (halfAllowed && half) ? 0.5 : 1,
        notes: notes.trim() ? notes.trim() : null,
        managerInformed: informed,
        bereavementEventId: status === 'BEREAVEMENT_LEAVE' ? eventId || null : null,
      },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{prettyDate(date)}</h1>
        </div>
        <StatusPill status={st} />
        <div className="hidden gap-1 sm:flex">
          <Link to={`/day/${addDays(date, -1)}`} aria-label="Previous day" className="rounded-full p-2 hover:bg-muted">
            <ChevronLeft size={18} />
          </Link>
          <Link to={`/day/${addDays(date, 1)}`} aria-label="Next day" className="rounded-full p-2 hover:bg-muted">
            <ChevronRight size={18} />
          </Link>
        </div>
      </header>

      {day.isIncomplete && (
        <Banner
          tone="bad"
          action={
            <Button
              size="sm"
              variant="danger"
              onClick={() => setDialog({ open: true, session: data.sessions.find((s) => s.outTime === null) })}
            >
              Add OUT time
            </Button>
          }
        >
          The last entry has no OUT time. Add it so this time is counted.
        </Banner>
      )}
      {day.isUnrecorded && <Banner tone="warn">Nothing saved for this day. Add a time entry or choose a status.</Banner>}
      {day.warnings.includes('WORKED_ON_OFF_DAY') && (
        <Banner tone="warn">
          <span className="num">{formatDuration(day.offDayWorkedMinutes)}</span> worked on a day off. It is not counted in your total.
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Required" value={formatDuration(day.requiredMinutes)} />
              <Stat label={day.isIncomplete ? 'Worked (counted)' : 'Worked'} value={formatDuration(day.workedMinutes)} />
              <Stat
                label="Ahead or behind"
                value={day.balanceMinutes === null ? 'N/A' : formatDuration(day.balanceMinutes, { signed: true })}
                tone={day.balanceMinutes === null ? undefined : day.balanceMinutes < 0 ? 'warn' : 'ok'}
              />
              <Stat label="Outside" value={formatDuration(day.outsideMinutes)} />
            </div>
            <div className="num mt-4 flex gap-6 border-t border-line pt-3 text-sm">
              <span>
                <span className="text-ink-soft">First IN </span>
                {day.firstInClock ?? '–'}
              </span>
              <span>
                <span className="text-ink-soft">Last OUT </span>
                {day.lastOutClock ?? (day.isIncomplete ? 'missing' : '–')}
              </span>
              {day.overtimeMinutes > 0 && (
                <span className="text-ok">Overtime {formatDuration(day.overtimeMinutes)}</span>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle>Sessions ({data.sessions.length})</CardTitle>
            <SessionList
              sessions={data.sessions}
              isToday={day.isToday}
              onEdit={(s) => setDialog({ open: true, session: s })}
              onDelete={(s) => setConfirmDelete(s.id)}
            />
            {confirmDelete && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm">
                <span>Delete this entry?</span>
                <span className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={delSession.isPending}
                    onClick={() => delSession.mutate(confirmDelete, { onSettled: () => setConfirmDelete(null) })}
                  >
                    Delete
                  </Button>
                </span>
              </div>
            )}
            {delSession.error && <p role="alert" className="mt-2 text-sm text-bad">{delSession.error.message}</p>}
            <Button className="mt-4 w-full" onClick={() => setDialog({ open: true })}>
              <Plus size={18} aria-hidden /> Add time entry
            </Button>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>Day status</CardTitle>
            <div role="radiogroup" aria-label="Day status" className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={status === o.value}
                  onClick={() => setStatus(o.value)}
                  className={cn(
                    'rounded-full border px-3.5 py-2 text-sm font-medium',
                    status === o.value ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-card text-ink-soft hover:bg-muted',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <label className={cn('mt-4 flex items-center gap-2 text-sm', !halfAllowed && 'opacity-50')}>
              <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={birthday || (half && halfAllowed)} disabled={!halfAllowed || birthday} onChange={(e) => setHalf(e.target.checked)} />
              Half day {birthday ? <span className="text-xs text-ink-soft">(a birthday leave is always a half day)</span> : !halfAllowed && <span className="text-xs text-ink-soft">(only for casual, sick or birthday leave)</span>}
            </label>

            {status === 'BEREAVEMENT_LEAVE' && (
              <div className="mt-3">
                <label htmlFor="event" className="text-sm font-medium text-ink-soft">
                  Which death in the family
                </label>
                <select id="event" className={inputClass + ' mt-1'} value={eventId} onChange={(e) => setEventId(e.target.value)}>
                  <option value="">Choose an event</option>
                  {events.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.relation} ({e.startDate})
                    </option>
                  ))}
                </select>
                {events.length === 0 && (
                  <p className="mt-1 text-xs text-ink-soft">
                    No events yet. <Link to="/leave" className="text-primary underline">Log one on the Leave screen</Link>.
                  </p>
                )}
              </div>
            )}

            {isLeave(status) && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={informed} onChange={(e) => setInformed(e.target.checked)} />
                I told my manager
              </label>
            )}

            <div className="mt-4">
              <label htmlFor="notes" className="text-sm font-medium text-ink-soft">
                Notes
              </label>
              <textarea
                id="notes"
                rows={3}
                maxLength={2000}
                className="mt-1 w-full rounded-xl border border-line bg-card p-3 text-base"
                placeholder="Add notes about this day…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {setDay.error && <p role="alert" className="mt-2 text-sm text-bad">{setDay.error.message}</p>}
            {saved && !setDay.isPending && !setDay.error && <p className="mt-2 text-sm text-ok">Saved.</p>}
            <Button className="mt-4 w-full" disabled={setDay.isPending} onClick={save}>
              {setDay.isPending ? 'Saving…' : 'Save day'}
            </Button>
          </Card>

          {hasRecord && (
            <Button
              variant="destructiveText"
              disabled={delDay.isPending}
              onClick={() => delDay.mutate(undefined, { onSuccess: () => navigate('/calendar') })}
            >
              <Trash2 size={16} aria-hidden /> Delete day record
            </Button>
          )}
          {delDay.error && <p role="alert" className="text-sm text-bad">{delDay.error.message}</p>}
        </div>
      </div>

      <AddSessionDialog date={date} open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} session={dialog.session} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div>
      <div className="text-xs text-ink-soft">{label}</div>
      <div className={cn('num text-xl font-semibold', tone === 'warn' && 'text-[#8a6300]', tone === 'ok' && 'text-ok')}>{value}</div>
    </div>
  );
}
