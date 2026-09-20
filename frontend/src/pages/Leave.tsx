import { useEffect, useState } from 'react';
import { Cake, Copy, Palmtree, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner, Card, CardTitle, Chip, ErrorState, Field, Skeleton, inputClass } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { shortDate, todayIst } from '@/lib/dates';
import { useAddBereavementEvent, useApplyLeave, useLeave, useLeavePreview, type LeaveInput } from '@/lib/queries';

const TYPES: Array<{ value: LeaveInput['type']; label: string }> = [
  { value: 'CASUAL_LEAVE', label: 'Casual leave' },
  { value: 'SICK_LEAVE', label: 'Sick leave' },
  { value: 'BEREAVEMENT_LEAVE', label: 'Bereavement' },
  { value: 'OPTIONAL_HOLIDAY', label: 'Optional holiday' },
  { value: 'BIRTHDAY_LEAVE', label: 'Birthday half-day' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Leave() {
  const q = useLeave();
  const preview = useLeavePreview();
  const apply = useApplyLeave();
  const addEvent = useAddBereavementEvent();

  const today = todayIst();
  const [type, setType] = useState<LeaveInput['type']>('CASUAL_LEAVE');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [half, setHalf] = useState(false);
  const [informed, setInformed] = useState(false);
  const [eventId, setEventId] = useState('');
  const [copied, setCopied] = useState(false);
  const [relation, setRelation] = useState('');

  const birthday = type === 'BIRTHDAY_LEAVE';
  const halfAllowed = type === 'CASUAL_LEAVE' || type === 'SICK_LEAVE';
  const input: LeaveInput = {
    type,
    startDate: start,
    // A birthday half-day is one date, always half a day.
    endDate: birthday ? start : end < start ? start : end,
    half: birthday || (halfAllowed && half && start === end),
    managerInformed: informed,
    bereavementEventId: type === 'BEREAVEMENT_LEAVE' ? eventId || null : null,
  };

  // Live preview: what is paid, what is unpaid. Debounced so typing dates stays smooth.
  const key = JSON.stringify([input.type, input.startDate, input.endDate, input.half]);
  useEffect(() => {
    const id = window.setTimeout(() => preview.mutate(input), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (q.isLoading) return <div className="flex flex-col gap-4" aria-busy="true"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <ErrorState message={q.error?.message ?? "Can't load leave."} onRetry={() => q.refetch()} />;
  const d = q.data;
  const pv = preview.data;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Leave</h1>

      {d.yearEnd && d.yearEnd.willLapse > 0 && (
        <Banner tone="warn">
          Only {d.yearEnd.carryForward.toFixed(2)} days carry forward. {d.yearEnd.willLapse.toFixed(2)} will lapse on 31 Dec.
        </Banner>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-1">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <Palmtree size={16} className="text-leave" aria-hidden /> Annual leave (sick + casual)
          </div>
          <p className="num mt-1 text-4xl font-semibold">
            {d.annual.balance.toFixed(2)} <span className="text-base font-normal text-ink-soft">days</span>
          </p>
          <dl className="num mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-ink-soft">Carried in</dt>
              <dd className="font-medium">{d.annual.carriedIn.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">Accrued</dt>
              <dd className="font-medium">{d.annual.accruedThisYear.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">Used</dt>
              <dd className="font-medium text-leave">{d.annual.usedThisYear.toFixed(2)}</dd>
            </div>
          </dl>
          {d.annual.nextCredit && (
            <p className="num mt-3 text-xs text-ink-soft">
              Next credit: +{d.annual.nextCredit.days} on {shortDate(d.annual.nextCredit.date)}
            </p>
          )}
        </Card>

        <Card>
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <Star size={16} className="text-holiday" aria-hidden /> Optional leave
          </div>
          <p className="num mt-1 text-2xl font-semibold">
            {d.optional.remaining} of {d.optional.quota} remaining
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <Cake size={16} className="text-leave" aria-hidden /> Birthday half-day
          </div>
          <p className="num mt-1 text-2xl font-semibold">
            {d.birthday.remaining} of {d.birthday.quota} remaining
          </p>
          <p className="mt-1 text-xs text-ink-soft">Half a day each year, separate from annual leave. It does not carry over.</p>
        </Card>

        <Card>
          <div className="text-sm font-medium text-ink-soft">Bereavement leave</div>
          <p className="mt-1 text-xs text-ink-soft">Up to {d.bereavement.maxDaysPerEvent} days per event, separate from annual leave.</p>
          {d.bereavement.events.length === 0 ? (
            <p className="mt-2 text-sm">No events logged.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {d.bereavement.events.map((e) => (
                <li key={e.id} className="num">
                  {e.relation}, {shortDate(e.startDate)}: {e.daysUsed}/{d.bereavement.maxDaysPerEvent} days
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (relation.trim()) addEvent.mutate({ relation: relation.trim(), startDate: today }, { onSuccess: () => setRelation('') });
            }}
          >
            <input aria-label="Relation" className={inputClass + ' h-10 text-sm'} placeholder="Relation (e.g. Family member)" value={relation} onChange={(e) => setRelation(e.target.value)} />
            <Button size="sm" type="submit" disabled={addEvent.isPending || !relation.trim()}>
              <Plus size={14} aria-hidden /> Log
            </Button>
          </form>
          {addEvent.error && <p role="alert" className="mt-1 text-xs text-bad">{addEvent.error.message}</p>}
        </Card>
      </div>

      <Card>
        <CardTitle>Apply leave</CardTitle>
        <div role="radiogroup" aria-label="Leave type" className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={type === t.value}
              onClick={() => setType(t.value)}
              className={cn('rounded-full border px-3.5 py-2 text-sm font-medium', type === t.value ? 'border-primary bg-primary-soft text-primary' : 'border-line text-ink-soft hover:bg-muted')}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="From" htmlFor="leave-from">
            <input id="leave-from" type="date" className={inputClass} value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} />
          </Field>
          <Field label="To" htmlFor="leave-to">
            <input id="leave-to" type="date" className={inputClass} value={birthday ? start : end} min={start} disabled={birthday} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>

        {birthday && (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm text-ink-soft">
            A birthday half-day is one date and always half a day (you still work the other half). It has its own yearly allowance and does not use your annual leave.
          </p>
        )}

        <label className={cn('mt-3 flex items-center gap-2 text-sm', (!halfAllowed || start !== end) && 'opacity-50', birthday && 'hidden')}>
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={half && halfAllowed && start === end} disabled={!halfAllowed || start !== end} onChange={(e) => setHalf(e.target.checked)} />
          Half day <span className="text-xs text-ink-soft">(single date, casual or sick)</span>
        </label>

        {type === 'BEREAVEMENT_LEAVE' && (
          <div className="mt-3">
            <Field label="Bereavement event" htmlFor="leave-event">
              <select id="leave-event" className={inputClass} value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">Choose an event</option>
                {d.bereavement.events.map((e) => (
                  <option key={e.id} value={e.id}>{e.relation} ({e.startDate})</option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="mt-4 space-y-3" aria-live="polite">
          {preview.isError && <Banner tone="bad">{preview.error.message}</Banner>}
          {pv && <p className="text-sm text-ink-soft">{pv.summary}</p>}
          {pv && pv.skipped.length > 0 && (
            <p className="text-xs text-ink-soft">
              Skipped: {pv.skipped.map((s) => `${shortDate(s.date)} (${s.reason})`).join(', ')}
            </p>
          )}
          {pv?.warning && (
            <Banner tone="bad">
              <strong>{pv.warning}</strong>
              <span className="mt-1 block text-xs">You can still save. Unpaid days are recorded for the month they fall in.</span>
            </Banner>
          )}
          {pv?.managerMessage && (
            <div className="rounded-xl border border-line bg-muted p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-ink-soft">Message to your manager</div>
              <p>{pv.managerMessage}</p>
              <Button className="mt-2" variant="outline" size="sm" onClick={() => copy(pv.managerMessage!)}>
                <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={informed} onChange={(e) => setInformed(e.target.checked)} />
                Manager informed
              </label>
            </div>
          )}
          {apply.error && <Banner tone="bad">{apply.error.message}</Banner>}
          {apply.isSuccess && <Banner tone="ok">Leave recorded for {apply.data.applied.length} day(s).</Banner>}
        </div>

        <Button className="mt-4 w-full sm:w-auto" size="md" disabled={apply.isPending || !pv || pv.workingDays.length === 0} onClick={() => apply.mutate(input)}>
          {apply.isPending ? 'Saving…' : 'Apply leave'}
        </Button>
      </Card>

      <Card>
        <CardTitle>Unpaid leave (LOP) by month</CardTitle>
        <div className="flex flex-wrap gap-2">
          {MONTHS.slice(0, Number(d.asOf.slice(5, 7))).map((m, i) => {
            const v = d.lopByMonth[`${d.year}-${String(i + 1).padStart(2, '0')}`] ?? 0;
            return (
              <Chip key={m} className={v > 0 ? 'bg-bad/10 text-bad' : ''}>
                {m} {v}
              </Chip>
            );
          })}
          {Object.entries(d.lopByMonth)
            .filter(([k]) => k > d.asOf.slice(0, 7))
            .map(([k, v]) => (
              <Chip key={k} className="bg-bad/10 text-bad">
                {MONTHS[Number(k.slice(5)) - 1]} {v} (planned)
              </Chip>
            ))}
        </div>
        <p className="mt-2 text-xs text-ink-soft">Days beyond your balance are unpaid and cut from that month&apos;s salary.</p>
      </Card>

      <Card className="overflow-x-auto">
        <CardTitle>Ledger</CardTitle>
        <table className="w-full min-w-[26rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-soft">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Entry</th>
              <th className="py-2 text-right font-medium">Change</th>
              <th className="py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {d.ledger.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="num py-2">{shortDate(r.date)}</td>
                <td className="py-2">{r.note ?? r.kind.charAt(0) + r.kind.slice(1).toLowerCase()}</td>
                <td className={cn('num py-2 text-right font-medium', r.days < 0 ? 'text-leave' : 'text-ok')}>
                  {r.days > 0 ? '+' : ''}
                  {r.days.toFixed(2)}
                </td>
                <td className="num py-2 text-right">{r.running.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
