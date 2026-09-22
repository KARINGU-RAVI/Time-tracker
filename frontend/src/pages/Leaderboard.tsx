import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Crown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner, Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { addDays, monthTitle, shiftMonth, shortDate, todayIst } from '@/lib/dates';
import { useLeaderboardMonth, useLeaderboardWeek, type LeaderboardEntry } from '@/lib/queries';

const RANK_BADGE: Record<number, string> = {
  1: 'bg-warn/15 text-[#8a6300] border-warn/40',
  2: 'bg-muted text-ink-soft border-line',
  3: 'bg-[#e8762b]/10 text-[#a15a1f] border-[#e8762b]/30',
};

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function Row({ rank, displayName, pct: p, isYou, ghost }: LeaderboardEntry & { ghost?: boolean }) {
  const width = `${Math.min(p, 1) * 100}%`;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3',
        ghost ? 'border-dashed border-line text-ink-soft' : isYou ? 'border-primary/40 bg-primary-soft/40' : 'border-transparent',
      )}
    >
      <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-semibold', RANK_BADGE[rank] ?? 'border-line bg-muted text-ink-soft')}>
        {rank === 1 && !ghost ? <Crown size={14} aria-hidden /> : rank}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {displayName}
          {isYou && !ghost && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">You</span>}
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', ghost ? 'bg-line' : p >= 1 ? 'bg-ok' : 'bg-primary')} style={{ width }} />
        </div>
      </div>
      <div className={cn('num shrink-0 text-sm font-semibold', ghost && 'text-ink-soft')}>{pct(p)}</div>
    </div>
  );
}

export default function Leaderboard() {
  const today = todayIst();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(today);
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));

  const week = useLeaderboardWeek(anchor);
  const month = useLeaderboardMonth(ym.year, ym.month);
  const q = mode === 'week' ? week : month;
  const board = q.data;

  // Not opted in: show where you'd land, without ever adding you to what colleagues see.
  const ghostIndex =
    board && !board.you.optedIn && board.you.pct !== null ? board.entries.findIndex((e) => e.pct < board.you.pct!) : -1;
  const rows: Array<LeaderboardEntry & { ghost?: boolean }> = board
    ? board.you.optedIn || board.you.pct === null
      ? board.entries
      : (() => {
          const withRank = board.entries.map((e) => ({ ...e }));
          const insertAt = ghostIndex === -1 ? withRank.length : ghostIndex;
          const ghostRow = { rank: insertAt + 1, displayName: 'Your spot', pct: board.you.pct!, isYou: false, ghost: true };
          const before = withRank.slice(0, insertAt).map((e, i) => ({ ...e, rank: i + 1 }));
          const after = withRank.slice(insertAt).map((e, i) => ({ ...e, rank: insertAt + 2 + i }));
          return [...before, ghostRow, ...after];
        })()
    : [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Leaderboard</h1>
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
          {mode === 'week' && board ? `${shortDate(board.period.start)} – ${shortDate(board.period.end)}` : mode === 'week' ? '' : monthTitle(ym.year, ym.month)}
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
        <ErrorState message={q.error?.message ?? "Can't load the leaderboard."} onRetry={() => q.refetch()} />
      ) : q.isLoading || !board ? (
        <Skeleton className="h-72" />
      ) : (
        <>
          {board.you.optedIn ? (
            <Banner tone="info">
              Ranked by % of {mode}ly goal met, not raw hours. Only colleagues who opt in appear here.
            </Banner>
          ) : (
            <Banner tone="warn" action={<Link to="/settings"><Button size="sm">Show me</Button></Link>}>
              You're not on the leaderboard yet. Turn it on in Settings to be ranked.
            </Banner>
          )}

          <Card className="flex flex-col gap-2">
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-soft">No one is on the leaderboard for this {mode} yet.</p>
            ) : (
              rows.map((r) => <Row key={r.ghost ? 'ghost' : `${r.displayName}-${r.rank}`} {...r} />)
            )}
          </Card>
        </>
      )}
    </div>
  );
}
