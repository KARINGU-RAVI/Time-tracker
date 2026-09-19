import { Coffee, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { formatDuration } from '@oht/engine';
import { cn } from '@/lib/cn';
import { minutesBetween } from '@/lib/status';
import type { Session } from '@/lib/types';
import { Button } from './ui/button';

interface Props {
  sessions: Session[];
  /** True when the sessions belong to today, so an open session reads "now" and ticks. */
  isToday: boolean;
  /** Current time (ms) used to count today's open session. Pass a ticking value to keep it live. */
  nowMs?: number;
  onEdit?: (s: Session) => void;
  onDelete?: (s: Session) => void;
}

/** Sessions in order, with the time spent outside shown between them. */
export function SessionList({ sessions, isToday, nowMs, onEdit, onDelete }: Props) {
  if (sessions.length === 0) {
    return <p className="py-3 text-sm text-ink-soft">No sessions recorded.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((s, i) => {
        const prev = sessions[i - 1];
        const gap = prev?.outTime ? minutesBetween(prev.outTime, s.inTime) : 0;
        const open = s.outTime === null;
        const stale = open && !isToday; // an unclosed session on a past day
        const minutes = s.outTime
          ? minutesBetween(s.inTime, s.outTime)
          : isToday
            ? minutesBetween(s.inTime, new Date(nowMs ?? Date.now()).toISOString())
            : null;
        return (
          <li key={s.id} className="flex flex-col gap-2">
            {gap > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-ink-soft">
                <Coffee size={14} aria-hidden />
                <span className="num">Outside {formatDuration(gap)}</span>
                <span className="num ml-auto text-xs">
                  {prev?.outClock} – {s.inClock}
                </span>
              </div>
            )}
            <div
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-3',
                stale ? 'border-bad/40 bg-bad/5' : 'border-line bg-card',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="num text-base font-medium">
                  {s.inClock} <span className="text-ink-soft">→</span>{' '}
                  {open ? (
                    <span className={stale ? 'text-bad' : 'text-ok'}>{isToday ? 'now' : 'no OUT'}</span>
                  ) : (
                    s.outClock
                  )}
                </div>
                {stale && (
                  <div className="mt-0.5 flex items-center gap-1 text-xs text-bad">
                    <AlertTriangle size={12} aria-hidden /> No OUT recorded, not counted
                  </div>
                )}
              </div>
              {minutes !== null && <div className="num text-base font-semibold">{formatDuration(minutes)}</div>}
              {onEdit && (
                <Button variant="ghost" size="icon" aria-label={`Edit session ${s.inClock}`} onClick={() => onEdit(s)}>
                  <Pencil size={16} />
                </Button>
              )}
              {onDelete && (
                <Button variant="destructiveText" size="icon" aria-label={`Delete session ${s.inClock}`} onClick={() => onDelete(s)}>
                  <Trash2 size={16} />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
