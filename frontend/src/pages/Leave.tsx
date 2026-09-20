import { useState } from 'react';
import { Cake, Palmtree, Plus, Star } from 'lucide-react';
import { EarlierLeaveCard, LeaveForm } from '@/components/LeaveForm';
import { Button } from '@/components/ui/button';
import { Banner, Card, CardTitle, Chip, ErrorState, Skeleton, inputClass } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { shortDate, todayIst } from '@/lib/dates';
import { useAddBereavementEvent, useLeave } from '@/lib/queries';

// Plain names for the kinds of row in the leave history (shown when a row has no note of its own).
const KIND_LABEL: Record<string, string> = {
  OPENING: 'Brought from last year',
  ACCRUAL: 'Leave added for the month',
  GRANT: 'Yearly allowance',
  LAPSE: 'Lost at year end',
  ADJUSTMENT: 'Correction',
  USAGE: 'Leave taken',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Leave() {
  const q = useLeave();
  const addEvent = useAddBereavementEvent();
  const today = todayIst();
  const [relation, setRelation] = useState('');

  if (q.isLoading) return <div className="flex flex-col gap-4" aria-busy="true"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <ErrorState message={q.error?.message ?? "Can't load leave."} onRetry={() => q.refetch()} />;
  const d = q.data;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Leave</h1>

      {d.yearEnd && d.yearEnd.willLapse > 0 && (
        <Banner tone="warn">
          Only {d.yearEnd.carryForward.toFixed(2)} days can be kept for next year. {d.yearEnd.willLapse.toFixed(2)} will be lost on 31 Dec.
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
              <dt className="text-ink-soft">From last year</dt>
              <dd className="font-medium">{d.annual.carriedIn.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">Added so far</dt>
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
          <p className="mt-1 text-xs text-ink-soft">Half a day each year, separate from your yearly leave. It cannot be kept for next year.</p>
        </Card>

        <Card>
          <div className="text-sm font-medium text-ink-soft">Bereavement leave</div>
          <p className="mt-1 text-xs text-ink-soft">Up to {d.bereavement.maxDaysPerEvent} days per event, separate from annual leave. You can take them on any dates, not only in a row.</p>
          {d.bereavement.events.length === 0 ? (
            <p className="mt-2 text-sm">No events added yet.</p>
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

      <LeaveForm d={d} />

      <EarlierLeaveCard d={d} />

      <Card>
        <CardTitle>Unpaid days by month</CardTitle>
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
                <td className="py-2">{r.note ?? KIND_LABEL[r.kind] ?? r.kind}</td>
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
