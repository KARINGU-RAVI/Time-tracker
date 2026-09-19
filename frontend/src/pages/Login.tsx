import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { googleConfigured, GoogleButton } from '@/components/auth/GoogleButton';
import { PasswordField } from '@/components/auth/PasswordField';
import { Turnstile, turnstileRequired } from '@/components/auth/Turnstile';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/form';
import { Banner } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';
import { cn } from '@/lib/cn';
import CheckEmail from '@/pages/auth/CheckEmail';

type Mode = 'signin' | 'signup';

export default function Login() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo) return <CheckEmail email={sentTo} onBack={() => setSentTo(null)} />;

  const signup = mode === 'signup';

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setConfirmError(null);
    setPassword('');
    setConfirm('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConfirmError(null);
    if (signup && password !== confirm) {
      setConfirmError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (signup) {
        await post('/auth/register', { email, password, turnstileToken: token ?? undefined });
        setSentTo(email.trim());
      } else {
        await post('/auth/login', { email, password });
        await qc.invalidateQueries();
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        setSentTo(email.trim());
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
      if (signup) setResetSignal((n) => n + 1);
    }
  }

  const blocked = busy || !email || !password || (signup && (!confirm || (turnstileRequired && !token)));

  return (
    <AuthLayout>
      <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 rounded-full bg-muted p-1">
        {(['signin', 'signup'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            className={cn('h-10 rounded-full text-sm font-medium', mode === m ? 'bg-card text-primary shadow-sm' : 'text-ink-soft')}
          >
            {m === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      {googleConfigured && (
        <>
          <div className="mt-5">
            <GoogleButton text={signup ? 'signup_with' : 'signin_with'} />
          </div>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-soft" aria-hidden>
            <span className="h-px flex-1 bg-line" /> or use your email <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <form onSubmit={submit} className={cn('flex flex-col gap-4', !googleConfigured && 'mt-5')} noValidate>
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Email">
          {(a11y) => (
            <TextInput {...a11y} type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
          )}
        </Field>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          email={email}
          checklist={signup}
          autoComplete={signup ? 'new-password' : 'current-password'}
        />
        {!signup && (
          <div className="-mt-2 text-right">
            <Link to="/forgot-password" className="text-sm font-medium text-primary">
              Forgot password?
            </Link>
          </div>
        )}
        {signup && <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={confirmError} />}
        {signup && <Turnstile onToken={setToken} resetSignal={resetSignal} />}
        <Button type="submit" size="lg" disabled={blocked}>
          {busy ? (signup ? 'Creating account…' : 'Signing in…') : signup ? 'Create account' : 'Sign in'}
        </Button>
        {signup && (
          <p className="text-center text-xs text-ink-soft">
            We will email you a link to verify your address. After that you will set up your work hours and leave.
          </p>
        )}
        <p className="text-center text-xs text-ink-soft">
          By continuing you agree to how your data is stored. You can delete your account and data any time.{' '}
          <Link to="/privacy" className="font-medium text-primary underline">Privacy</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
