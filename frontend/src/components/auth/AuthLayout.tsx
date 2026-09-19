import { Clock, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/primitives';

/** The shared frame for every signed-out screen: app mark, name, a card, and the privacy note. */
export function AuthLayout({ children, subtitle = 'Track your hours, leave and balance.' }: { children: ReactNode; subtitle?: string }) {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <div className="text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary">
            <Clock size={28} aria-hidden />
          </div>
          <h1 className="mt-3 text-2xl font-semibold">Office Hours</h1>
          <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>
        </div>
        <div className="mt-6">{children}</div>
        <p className="mt-6 flex items-center justify-center gap-2 border-t border-line pt-4 text-xs text-ink-soft">
          <Lock size={14} aria-hidden /> Your data is private to your account.
        </p>
      </Card>
    </div>
  );
}
