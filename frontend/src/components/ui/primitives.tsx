import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-[var(--radius-card)] border border-line bg-card p-4 shadow-sm', className)} {...props} />;
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-ink">{children}</h2>
      {right}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-muted', className)} />;
}

const bannerTone = {
  bad: 'border-bad/30 bg-bad/10 text-bad',
  warn: 'border-warn/40 bg-warn/10 text-[#7a5500]',
  info: 'border-line bg-muted text-ink-soft',
  ok: 'border-ok/30 bg-ok/10 text-ok',
} as const;

export function Banner({
  tone = 'info',
  children,
  action,
  className,
}: {
  tone?: keyof typeof bannerTone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-xl border p-3 text-sm', bannerTone[tone], className)}>
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Shown when a request fails: says what happened and offers a retry (never a blank screen). */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="mx-auto mt-10 max-w-md text-center">
      <AlertTriangle className="mx-auto text-bad" aria-hidden />
      <p className="mt-2 font-medium">{message}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Card>
  );
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'h-12 w-full rounded-xl border border-line bg-card px-3 text-base num focus-visible:outline-2 focus-visible:outline-primary';

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-medium num', className)}>{children}</span>;
}
