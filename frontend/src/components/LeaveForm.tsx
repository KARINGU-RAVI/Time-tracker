import { CalendarPlus, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Banner, Card, CardTitle, Field, inputClass } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { shortDate, todayIst } from '@/lib/dates';
import { useApplyLeave, useDeleteEarlierLeave, useLeavePreview, type LeaveInput } from '@/lib/queries';
import type { LeaveSummary } from '@/lib/types';

export const TYPES: Array<{ value: LeaveInput['type']; label: string }> = [
  { value: 'CASUAL_LEAVE', label: 'Casual leave' },
  { value: 'SICK_LEAVE', label: 'Sick leave' },
  { value: 'BEREAVEMENT_LEAVE', label: 'Bereavement' },
  { value: 'OPTIONAL_HOLIDAY', label: 'Optional holiday' },
  { value: 'BIRTHDAY_LEAVE', label: 'Birthday half-day' },
];

const MAX_PICKED = 31;

function Radios<T extends string>({ label, value, onChange, options }: { label: string; value: T | null; onChange: (v: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-full border px-3.5 py-2 text-sm font-medium', value === o.value ? 'border-primary bg-primary-soft text-primary' : 'border-line text-ink-soft hover:bg-muted')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Applying for leave: any dates (in a row, or picked one by one), a first or second half, and dates from earlier in the year. */
export function LeaveForm({ d }: { d: LeaveSummary }) {
  const preview = useLeavePreview();
  const apply = useApplyLeave();
  const today = todayIst();

  const [type, setType] = useState<LeaveInput['type']>('CASUAL_LEAVE');
  const [mode, setMode] = useState<'row' | 'pick'>('row');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [pickDate, setPickDate] = useState(today);
  const [picked, setPicked] = useState<string[]>([]);
  const [half, setHalf] = useState(false);
  const [halfPart, setHalfPart] = useState<'FIRST' | 'SECOND' | null>(null);
  const [informed, setInformed] = useState(false);
  const [eventId, setEventId] = useState('');
  const [copied, setCopied] = useState(false);

  const birthday = type === 'BIRTHDAY_LEAVE';
  const bereavement = type === 'BEREAVEMENT_LEAVE';
  const halfAllowed = type === 'CASUAL_LEAVE' || type === 'SICK_LEAVE';
  const isHalf = birthday || (halfAllowed && half);
  // A half day is one date, so choosing dates one by one only makes sense for whole days.
  const picking = mode === 'pick' && !isHalf;

  const common = {
    type,
    half: isHalf,
    halfPart: isHalf && halfPart ? halfPart : undefined,
    managerInformed: informed,
    bereavementEventId: bereavement ? eventId || null : null,
  };
  const input: LeaveInput | null = picking
    ? picked.length > 0
      ? { ...common, dates: picked }
      : null
    : { ...common, startDate: start, endDate: isHalf ? start : end < start ? start : end };

  // Live preview: what is paid, what is unpaid, and which dates are skipped. Debounced so typing dates stays smooth.
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) return;
    const id = window.setTimeout(() => preview.mutate(input), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const pv = input ? preview.data : undefined;
  const event = d.bereavement.events.find((e) => e.id === eventId);
  const chosen = picking ? picked : [start, ...(isHalf || end < start ? [] : [end])];
  const hasEarlier = chosen.some((x) => x < d.trackingStartDate);
  const nothingToSave = !pv || pv.workingDays.length + (pv.earlierDates?.length ?? 0) === 0;
  const blocked = apply.isPending || !input || nothingToSave || (isHalf && !halfPart) || (bereavement && !eventId);

  function addPicked() {
    if (!pickDate || picked.includes(pickDate) || picked.length >= MAX_PICKED) return;
    setPicked([...picked, pickDate].sort());
  }

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
    <Card>
      <CardTitle>Apply leave</CardTitle>
      <Radios label="Leave type" value={type} onChange={setType} options={TYPES} />

      {/* Half day (casual and sick), and the first or second half */}
      {halfAllowed && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={half} onChange={(e) => setHalf(e.target.checked)} />
          Half day <span className="text-xs text-ink-soft">(one date)</span>
        </label>
      )}
      {birthday && (
        <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm text-ink-soft">
          A birthday half-day is one date and always half a day (you still work the other half). It has its own yearly amount and does not use your annual leave.
        </p>
      )}
      {isHalf && (
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-medium">Which half is your leave?</p>
          <Radios label="Which half" value={halfPart} onChange={setHalfPart} options={[{ value: 'FIRST', label: 'First half' }, { value: 'SECOND', label: 'Second half' }]} />
          <p className="mt-1 text-xs text-ink-soft">
            {halfPart === 'FIRST' ? 'You are on leave in the first half and work the second half.' : halfPart === 'SECOND' ? 'You work the first half and are on leave in the second half.' : 'Choose one. You work the other half.'}
          </p>
        </div>
      )}

      {/* Bereavement: an event, and any dates */}
      {bereavement && (
        <div className="mt-3">
          <Field label="Bereavement event" htmlFor="leave-event">
            <select id="leave-event" className={inputClass} value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Choose an event</option>
              {d.bereavement.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.relation} ({e.startDate}), {e.daysUsed} of {d.bereavement.maxDaysPerEvent} days used
                </option>
              ))}
            </select>
          </Field>
          <p className="mt-1 text-xs text-ink-soft">
            You do not have to take all {d.bereavement.maxDaysPerEvent} days together. Choose any dates, now or later, up to {d.bereavement.maxDaysPerEvent} days in total for one event.
            {event ? ` ${Math.max(0, d.bereavement.maxDaysPerEvent - event.daysUsed)} left for this event.` : ''}
          </p>
        </div>
      )}

      {/* How the dates are chosen */}
      {!isHalf && (
        <div className="mt-4">
          <Radios
            label="How to choose dates"
            value={mode}
            onChange={setMode}
            options={[{ value: 'row', label: 'Dates in a row' }, { value: 'pick', label: 'Pick dates' }]}
          />
        </div>
      )}

      {!picking ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="From" htmlFor="leave-from">
            <input id="leave-from" type="date" className={inputClass} value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} />
          </Field>
          <Field label="To" htmlFor="leave-to">
            <input id="leave-to" type="date" className={inputClass} value={isHalf ? start : end} min={start} disabled={isHalf} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Add a date" htmlFor="leave-pick">
                <input id="leave-pick" type="date" className={inputClass} value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
              </Field>
            </div>
            <Button variant="outline" onClick={addPicked} disabled={!pickDate || picked.includes(pickDate) || picked.length >= MAX_PICKED}>
              <CalendarPlus size={16} aria-hidden /> Add date
            </Button>
          </div>
          {picked.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No dates chosen yet. Add each date you want; they do not have to be next to each other.</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Chosen dates">
              {picked.map((p) => (
                <li key={p} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-3 py-1 text-sm text-primary">
                  <span className="num">{shortDate(p)}</span>
                  <button type="button" aria-label={`Remove ${shortDate(p)}`} onClick={() => setPicked(picked.filter((x) => x !== p))} className="grid h-5 w-5 place-items-center rounded-full hover:bg-primary/10">
                    <X size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picked.length >= MAX_PICKED && <p className="mt-1 text-xs text-ink-soft">That is the most you can add at once ({MAX_PICKED}).</p>}
        </div>
      )}

      <p className="mt-2 text-xs text-ink-soft">
        You can also choose dates that have already passed this year.
        {hasEarlier ? ` Dates before ${shortDate(d.trackingStartDate)} are saved as earlier leave: they lower your balance but do not create a day record.` : ''}
      </p>

      <div className="mt-4 space-y-3" aria-live="polite">
        {preview.isError && <Banner tone="bad">{preview.error.message}</Banner>}
        {pv && <p className="text-sm text-ink-soft">{pv.summary}</p>}
        {pv && (pv.earlierDates?.length ?? 0) > 0 && (
          <p className="text-xs text-ink-soft">Saved as earlier leave: {pv.earlierDates!.map(shortDate).join(', ')}</p>
        )}
        {pv && pv.skipped.length > 0 && (
          <p className="text-xs text-ink-soft">Skipped: {pv.skipped.map((s) => `${shortDate(s.date)} (${s.reason})`).join(', ')}</p>
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
        {apply.isSuccess && (
          <Banner tone="ok">
            Leave recorded for {apply.data.applied.length + (apply.data.earlier?.length ?? 0)} day(s).
            {(apply.data.earlier?.length ?? 0) > 0 ? ` ${apply.data.earlier.length} saved as earlier leave.` : ''}
          </Banner>
        )}
      </div>

      <Button className="mt-4 w-full sm:w-auto" size="md" disabled={blocked} onClick={() => input && apply.mutate(input)}>
        {apply.isPending ? 'Saving…' : 'Apply leave'}
      </Button>
      {isHalf && !halfPart && <p className="mt-2 text-xs text-ink-soft">Choose the first or second half to continue.</p>}
      {bereavement && !eventId && <p className="mt-2 text-xs text-ink-soft">Choose a bereavement event to continue.</p>}
    </Card>
  );
}

/** Leave from before the person started counting, added by hand. It lowers the balance; each entry can be removed. */
export function EarlierLeaveCard({ d }: { d: LeaveSummary }) {
  const del = useDeleteEarlierLeave();
  const [confirming, setConfirming] = useState<string | null>(null);
  if (d.earlier.length === 0) return null;
  return (
    <Card>
      <CardTitle>Earlier leave you added</CardTitle>
      <p className="mb-2 text-xs text-ink-soft">
        Leave from before you started counting. It lowers your balance. If you already included it when you set up, remove it here so it is not counted twice.
      </p>
      <ul className="divide-y divide-line text-sm">
        {d.earlier.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="num font-medium">{shortDate(e.date)}</span>
              <span className="ml-2 text-ink-soft">{(e.note ?? '').replace(/^Earlier leave: /, '').replace(/ on \d+ \w+ \d{4}/, '')}</span>
              <span className="num ml-2 text-ink-soft">{e.days} day{e.days === 1 ? '' : 's'}</span>
            </span>
            {confirming === e.id ? (
              <span className="flex gap-1">
                <Button size="sm" variant="danger" disabled={del.isPending} onClick={() => del.mutate(e.id, { onSuccess: () => setConfirming(null) })}>
                  Yes, remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="destructiveText" aria-label={`Remove earlier leave on ${shortDate(e.date)}`} onClick={() => setConfirming(e.id)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {del.error && <Banner tone="bad" className="mt-2">{del.error.message}</Banner>}
    </Card>
  );
}
