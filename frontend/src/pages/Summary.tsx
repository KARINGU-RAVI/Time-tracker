import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { formatDuration } from '@oht/engine';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Card, Chip, ErrorState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { addDays, dayLabel, monthTitle, shiftMonth, shortDate, todayIst } from '@/lib/dates';
import { useMonth, useWeek } from '@/lib/queries';
import { dayStatus } from '@/lib/status';
import type { Period } from '@/lib/types';

export default function Summary() {
  const today = todayIst();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(today);
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));

  const week = useWeek(anchor);
  const month = useMonth(ym.year, ym.month);
  const q = mode === 'week' ? week : month;
  const p: Period | undefined = q.data;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Summary</h1>
        <div role="tablist" aria-label="Period" className="inline-flex rounded-full border border-line bg-card p-1">
          {(['week', 'month'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('rounded-full px-4 py-1.5 text-sm font-medium capitalize', mode === m ? 'bg-primary text-on-primary' : 'text-ink-soft')}
            >
              {m}
            </button>
          ))}
        </div>
      </header>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="icon"
          aria-label={`Previous ${mode}`}
          onClick={() => (mode === 'week' ? setAnchor((a) => addDays(a, -7)) : setYm((v) => shiftMonth(v.year, v.month, -1)))}
        >
          <ChevronLeft size={18} />
        </Button>
        <p className="num text-base font-medium">
          {mode === 'week' && p ? `${shortDate(p.start)} – ${shortDate(p.end)} ${p.end.slice(0, 4)}` : mode === 'week' ? '' : monthTitle(ym.year, ym.month)}
        </p>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Next ${mode}`}
          onClick={() => (mode === 'week' ? setAnchor((a) => addDays(a, 7)) : setYm((v) => shiftMonth(v.year, v.month, 1)))}
        >
          <ChevronRight size={18} />
        </Button>
      </div>

      {q.isError ? (
        <ErrorState message={q.error?.message ?? "Can't load the summary."} onRetry={() => q.refetch()} />
      ) : q.isLoading || !p ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Required" value={formatDuration(p.requiredMinutes)} />
            <StatCard label="Worked" value={formatDuration(p.workedMinutes)} />
            <StatCard label="Balance" value={formatDuration(p.balanceMinutes, { signed: true })} tone={p.balanceMinutes < 0 ? 'warn' : 'ok'} />
            <StatCard label={mode === 'week' ? 'Weekly overtime' : 'Overtime'} value={formatDuration(p.periodOvertimeMinutes)} />
          </div>
          {(p.counts.leaveDays > 0 || p.counts.holidays > 0) && mode === 'week' && (
            <p className="flex items-center gap-2 text-sm text-ink-soft">
              <Info size={16} aria-hidden /> Required is {formatDuration(p.requiredMinutes)} because of {p.counts.leaveDays + p.counts.holidays} leave/holiday day(s).
            </p>
          )}
          {mode === 'month' && (p.lopDays ?? 0) > 0 && (
            <p className="text-sm font-medium text-bad">Unpaid (LOP) this month: {p.lopDays} day(s)</p>
          )}

          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-soft">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-2 py-3 font-medium">Status</th>
                  <th className="px-2 py-3 text-right font-medium">Worked</th>
                  <th className="px-2 py-3 text-right font-medium">Required</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {p.days
                  .filter((d) => d.kind !== 'BEFORE_TRACKING' && (mode === 'week' || d.kind !== 'WEEKLY_OFF'))
                  .map((d) => {
                    const st = dayStatus(d);
                    return (
                      <tr key={d.date} className="border-b border-line last:border-0 hover:bg-muted/60">
                        <td className="whitespace-nowrap px-4 py-3 font-medium">
                          <Link to={`/day/${d.date}`}>{dayLabel(d.date)}</Link>
                        </td>
                        <td className="px-2 py-3">
                          <StatusPill status={st} />
                          {d.isIncomplete && <div className="mt-0.5 text-xs text-bad">Missing OUT time</div>}
                        </td>
                        <td className="num whitespace-nowrap px-2 py-3 text-right">{d.requiredMinutes === 0 ? '–' : formatDuration(d.workedMinutes)}</td>
                        <td className="num whitespace-nowrap px-2 py-3 text-right text-ink-soft">{formatDuration(d.requiredMinutes)}</td>
                        <td
                          className={cn(
                            'num whitespace-nowrap px-4 py-3 text-right font-medium',
                            d.balanceMinutes !== null && d.balanceMinutes < 0 && 'text-[#8a6300]',
                            d.balanceMinutes !== null && d.balanceMinutes > 0 && 'text-ok',
                          )}
                        >
                          {d.balanceMinutes === null ? 'n/a' : formatDuration(d.balanceMinutes, { signed: true })}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Chip>Working {p.counts.working}</Chip>
            <Chip>Leave {p.counts.leaveDays}</Chip>
            <Chip>WFH {p.counts.wfh}</Chip>
            <Chip>Holiday {p.counts.holidays}</Chip>
            <Chip>Weekly off {p.counts.weeklyOffs}</Chip>
          </div>
          <p className="text-xs text-ink-soft">Short days are not made up on the same day. Only the weekly balance counts.</p>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <Card>
      <div className="text-xs text-ink-soft">{label}</div>
      <div className={cn('num text-2xl font-semibold', tone === 'warn' && 'text-[#8a6300]', tone === 'ok' && 'text-ok')}>{value}</div>
    </Card>
  );
}
