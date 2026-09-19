import { useEffect, useState } from 'react';
import { DataCard } from '@/components/DataCard';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, ErrorState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { post } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useRules, useSession } from '@/lib/queries';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Theme = 'light' | 'dark' | 'system';

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem('oht-theme');
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function initTheme() {
  applyTheme(loadTheme());
}

export default function Settings() {
  const rules = useRules();
  const session = useSession();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem('oht-theme', theme);
    } catch {
      /* private mode: the theme still applies for this visit */
    }
  }, [theme]);

  const current = rules.data?.rules.find((r) => r.effectiveTo === null) ?? rules.data?.rules[0];

  async function signOut() {
    await post('/auth/logout');
    await qc.invalidateQueries();
    window.location.assign('/');
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardTitle>Account</CardTitle>
        {session.data?.mode === 'google' ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">Signed in with Google</p>
            <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Development mode: sign-in is off.</p>
        )}
      </Card>

      <Card>
        <CardTitle>Work rule</CardTitle>
        {rules.isError ? (
          <ErrorState message={rules.error.message} onRetry={() => rules.refetch()} />
        ) : !current ? (
          <Skeleton className="h-20" />
        ) : (
          <>
            <p className="num text-sm">
              {current.dailyRequiredMinutes / 60}h per day, {current.weeklyRequiredMinutes / 60}h per week,{' '}
              {current.workingDays.map((d) => DAYS[d - 1]?.slice(0, 3)).join(', ')}, week starts {DAYS[current.weekStartsOn - 1]}, effective from {current.effectiveFrom}.
            </p>
            <p className="mt-2 text-xs text-ink-soft">A new version is created when the rule changes, and past dates keep the old rule.</p>
          </>
        )}
      </Card>

      <Card>
        <CardTitle>Appearance</CardTitle>
        <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full border border-line p-1">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              onClick={() => setTheme(t)}
              className={cn('rounded-full px-4 py-1.5 text-sm font-medium capitalize', theme === t ? 'bg-primary text-on-primary' : 'text-ink-soft')}
            >
              {t}
            </button>
          ))}
        </div>
      </Card>

      <DataCard />
    </div>
  );
}
