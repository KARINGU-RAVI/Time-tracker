import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDuration } from '@oht/engine';
import { StatusIcon } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Card, Chip, ErrorState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { WEEKDAY_LABELS, firstDayOfMonth, lastDayOfMonth, monthGrid, monthTitle, shiftMonth, todayIst } from '@/lib/dates';
import { useMonth, useRange } from '@/lib/queries';
import { dayStatus, toneClasses } from '@/lib/status';
import type { Day } from '@/lib/types';

const LEGEND = [
  { label: 'Target met', tone: 'ok', icon: 'check' },
  { label: 'Short', tone: 'warn', icon: 'clock' },
  { label: 'WFH', tone: 'wfh', icon: 'home' },
  { label: 'Leave', tone: 'leave', icon: 'leave' },
  { label: 'Holiday', tone: 'holiday', icon: 'star' },
  { label: 'Weekly off', tone: 'off', icon: 'off' },
  { label: 'Needs fix', tone: 'bad', icon: 'warning' },
] as const;

export default function Calendar() {
  const today = todayIst();
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));
  const start = firstDayOfMonth(ym.year, ym.month);
  const end = lastDayOfMonth(ym.year, ym.month);
  const range = useRange(start, end);
  const month = useMonth(ym.year, ym.month);

  const byDate = new Map<string, Day>((range.data?.days ?? []).map((d) => [d.date, d]));
  const rows = monthGrid(ym.year, ym.month);
  const m = month.data;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{monthTitle(ym.year, ym.month)}</h1>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, -1))}>
            <ChevronLeft size={18} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setYm({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })}>
            Today
          </Button>
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, 1))}>
            <ChevronRight size={18} />
          </Button>
        </div>
      </header>

      {m && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" aria-label="Month totals">
          <Chip>Worked {formatDuration(m.workedMinutes)}</Chip>
          <Chip>Required {formatDuration(m.requiredMinutes)}</Chip>
          <Chip className={m.balanceMinutes < 0 ? 'text-[#8a6300]' : 'text-ok'}>Balance {formatDuration(m.balanceMinutes, { signed: true })}</Chip>
          <Chip>Overtime {formatDuration(m.periodOvertimeMinutes)}</Chip>
          <Chip>Leave {m.counts.leaveDays}</Chip>
          {m.counts.birthdayDays > 0 && <Chip>Birthday {m.counts.birthdayDays}</Chip>}
          <Chip>WFH {m.counts.wfh}</Chip>
          <Chip>Holiday {m.counts.holidays}</Chip>
          <Chip>Unpaid (LOP) {m.lopDays ?? 0}</Chip>
        </div>
      )}

      {range.isError ? (
        <ErrorState message={range.error?.message ?? "Can't load the calendar."} onRetry={() => range.refetch()} />
      ) : range.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <Card className="p-2 md:p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-ink-soft md:gap-2">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1 md:gap-2">
            {rows.flat().map((date, i) => {
              if (!date) return <div key={`e${i}`} />;
              const d = byDate.get(date);
              const st = d ? dayStatus(d) : null;
              const isToday = date === today;
              const showTime = d && d.requiredMinutes > 0 && d.workedMinutes > 0;
              return (
                <Link
                  key={date}
                  to={`/day/${date}`}
                  aria-label={`${date}${st ? `: ${st.label}` : ''}`}
                  className={cn(
                    'flex min-h-14 flex-col items-center justify-between gap-0.5 rounded-lg p-1 text-center md:min-h-20 md:p-2',
                    st ? toneClasses[st.tone] : 'bg-muted text-ink-soft',
                    d?.isUnrecorded && 'border border-dashed border-bad/60',
                    isToday && 'ring-2 ring-primary',
                  )}
                >
                  <span className="num text-sm font-semibold">{Number(date.slice(8))}</span>
                  {st && <StatusIcon icon={st.icon} size={16} />}
                  <span className="num hidden text-[11px] md:block">{showTime ? formatDuration(d.workedMinutes) : st?.label === 'Weekly off' ? 'Off' : ''}</span>
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      <ul className="flex flex-wrap gap-2 text-xs" aria-label="Legend">
        {LEGEND.map((l) => (
          <li key={l.label} className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium', toneClasses[l.tone])}>
            <StatusIcon icon={l.icon} size={12} />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
