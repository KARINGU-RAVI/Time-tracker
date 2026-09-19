import { Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { Turnstile, turnstileRequired } from '@/components/auth/Turnstile';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

const COOLDOWN_SECONDS = 60;

/** Shown after sign-up (or a sign-in attempt on an unverified account): the link is on its way. */
export default function CheckEmail({ email, onBack }: { email: string; onBack: () => void }) {
  const [seconds, setSeconds] = useState(COOLDOWN_SECONDS);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  async function resend() {
    setBusy(true);
    setNote(null);
    try {
      await post('/auth/resend-verification', { email, turnstileToken: token ?? undefined });
      setNote({ tone: 'ok', text: 'A new link is on its way.' });
      setSeconds(COOLDOWN_SECONDS);
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not send the email. Please try again.' });
    } finally {
      setBusy(false);
      setResetSignal((n) => n + 1);
    }
  }

  const mm = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <AuthLayout subtitle="Verify your email to continue.">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-primary-soft text-primary">
          <Mail size={30} aria-hidden />
        </div>
        <h2 className="text-xl font-semibold">Check your email</h2>
        <p className="text-sm text-ink-soft">
          We sent a verification link to <strong className="text-ink">{email}</strong>. It works for 24 hours and can be used once.
        </p>
        {note && <Banner tone={note.tone} className="w-full text-left">{note.text}</Banner>}
        <Turnstile onToken={setToken} resetSignal={resetSignal} />
        <Button variant="outline" size="lg" onClick={resend} disabled={busy || seconds > 0 || (turnstileRequired && !token)}>
          {seconds > 0 ? `Resend in ${mm}` : busy ? 'Sending…' : 'Resend email'}
        </Button>
        <button type="button" onClick={onBack} className="text-sm font-medium text-primary">
          Use a different email
        </button>
        <p className="text-xs text-ink-soft">Can’t find it? Check your spam folder.</p>
      </div>
    </AuthLayout>
  );
}
