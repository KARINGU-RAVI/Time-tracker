import { AlertTriangle, CheckCircle2, CircleHelp, Clock, Home, Moon, Palmtree, Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { toneClasses, type IconName, type StatusInfo } from '@/lib/status';

const icons = {
  check: CheckCircle2,
  clock: Clock,
  home: Home,
  leave: Palmtree,
  star: Star,
  off: Moon,
  warning: AlertTriangle,
  help: CircleHelp,
  dot: () => <span className="inline-block h-2 w-2 rounded-full bg-current" />,
} satisfies Record<IconName, unknown>;

export function StatusIcon({ icon, size = 14 }: { icon: IconName; size?: number }) {
  const Icon = icons[icon] as React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  return <Icon size={size} aria-hidden />;
}

/** Icon + text on a tinted background: colour is never the only signal. */
export function StatusPill({ status, className, pulse }: { status: StatusInfo; className?: string; pulse?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', toneClasses[status.tone], className)}>
      {pulse && <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-current" aria-hidden />}
      {!pulse && <StatusIcon icon={status.icon} />}
      {status.label}
    </span>
  );
}
