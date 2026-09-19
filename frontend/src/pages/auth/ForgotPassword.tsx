import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { Turnstile, turnstileRequired } from '@/components/auth/Turnstile';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/form';
import { Banner } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/forgot-password', { email, turnstileToken: token ?? undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      setResetSignal((n) => n + 1);
    }
  }

  return (
    <AuthLayout subtitle="Reset your password.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 className="text-xl font-semibold">Reset your password</h2>
        <p className="text-sm text-ink-soft">Enter your email and we will send a reset link.</p>
        {sent && (
          <Banner tone="ok">If an account exists for this email, a reset link is on its way.</Banner>
        )}
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Email">
          {(a11y) => (
            <TextInput {...a11y} type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
          )}
        </Field>
        <Turnstile onToken={setToken} resetSignal={resetSignal} />
        <Button type="submit" size="lg" disabled={busy || !email || (turnstileRequired && !token)}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <Link to="/" className="text-center text-sm font-medium text-primary">
          Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
