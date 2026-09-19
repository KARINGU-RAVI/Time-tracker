import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { Card } from '@/components/ui/primitives';

/** The shared frame for every signed-out screen: app mark, name, a card, and the privacy note. */
export function AuthLayout({ children, subtitle = 'Track your hours, leave and balance.' }: { children: ReactNode; subtitle?: string }) {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <div className="text-center">
          <Logo size={56} className="mx-auto" />
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
