import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { formatDuration, istDateOf } from '@oht/engine';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, inputClass } from '@/components/ui/primitives';
import { addDays, prettyDate } from '@/lib/dates';
import { useAddSession, useUpdateSession } from '@/lib/queries';
import type { Session } from '@/lib/types';

interface Props {
  date: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this session instead of adding a new one. */
  session?: Session;
  /** Pre-fill IN for a new session (for example the current time). */
  defaultIn?: string;
  /** Opened from "Add OUT time": the person is adding the OUT, so "Still inside" starts un-ticked and OUT is ready to type. */
  askForOut?: boolean;
}

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function AddSessionDialog({ date, open, onOpenChange, session, defaultIn, askForOut }: Props) {
  const add = useAddSession(date);
  const update = useUpdateSession();
  const editing = Boolean(session);

  const [inTime, setIn] = useState('');
  const [outTime, setOut] = useState('');
  const [stillInside, setStillInside] = useState(false);
  const [nextDay, setNextDay] = useState(false);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    add.reset();
    update.reset();
    if (session) {
      setIn(session.inClock);
      setOut(session.outClock ?? '');
      setStillInside(session.outTime === null && !askForOut);
      setNextDay(session.outTime !== null && istDateOf(Date.parse(session.outTime)) !== date);
    } else {
      setIn((defaultIn ?? '').slice(0, 5)); // HH:MM only: a value with seconds would look filled in but could not be saved
      setOut('');
      setStillInside(false);
      setNextDay(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.id]);

  const duration = useMemo(() => {
    const a = toMinutes(inTime);
    const b = toMinutes(outTime);
    if (stillInside || a === null || b === null) return null;
    return b + (nextDay ? 1440 : 0) - a;
  }, [inTime, outTime, stillInside, nextDay]);

  const localError =
    !stillInside && duration !== null && duration <= 0 ? 'OUT must be after IN.' : null;
  const mutation = editing ? update : add;
  const serverError = mutation.error?.message ?? null;
  const canSave = toMinutes(inTime) !== null && (stillInside || toMinutes(outTime) !== null) && !localError && !mutation.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const outDate = nextDay ? addDays(date, 1) : date;
    const body = {
      inTime: `${date}T${inTime}`,
      outTime: stillInside ? null : `${outDate}T${outTime}`,
    };
    const done = () => onOpenChange(false);
    if (session) update.mutate({ id: session.id, body }, { onSuccess: done });
    else add.mutate(body, { onSuccess: done });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit session' : 'Add time entry'}
      description={prettyDate(date)}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="IN" htmlFor="in-time">
            <input id="in-time" type="time" required className={inputClass + ' text-2xl font-semibold'} value={inTime} onChange={(e) => setIn(e.target.value)} />
          </Field>
          <Field label="OUT" htmlFor="out-time">
            <input
              id="out-time"
              type="time"
              autoFocus={askForOut}
              disabled={stillInside}
              className={inputClass + ' text-2xl font-semibold disabled:opacity-40'}
              value={outTime}
              onChange={(e) => setOut(e.target.value)}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={stillInside} onChange={(e) => setStillInside(e.target.checked)} />
          Still inside (no OUT yet)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-primary)]" checked={nextDay} disabled={stillInside} onChange={(e) => setNextDay(e.target.checked)} />
          OUT is on the next day
        </label>

        {duration !== null && duration > 0 && (
          <p className="num text-sm font-medium">Duration {formatDuration(duration)}</p>
        )}
        {localError && (
          <p role="alert" className="flex items-center gap-2 text-sm text-bad">
            <AlertTriangle size={16} aria-hidden /> {localError}
          </p>
        )}
        {serverError && (
          <p role="alert" className="flex items-center gap-2 text-sm text-bad">
            <AlertTriangle size={16} aria-hidden /> {serverError}
          </p>
        )}
        {!localError && !serverError && duration !== null && duration > 0 && (
          <p className="flex items-center gap-2 text-sm text-ok">
            <CheckCircle2 size={16} aria-hidden /> Looks good. The server checks for overlaps when you save.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" disabled={!canSave}>
            {mutation.isPending ? 'Saving…' : 'Save session'}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
