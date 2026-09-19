import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { PasswordField } from '@/components/auth/PasswordField';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

/** The page the emailed reset link opens. */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    if (password !== confirm) {
      setConfirmError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reset-password', { token, password });
      await qc.invalidateQueries();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  const linkProblem = !token || error?.code === 'INVALID_TOKEN';

  return (
    <AuthLayout subtitle="Choose a new password.">
      {linkProblem ? (
        <div className="flex flex-col gap-4">
          <Banner tone="bad">This link has expired or was already used.</Banner>
          <Link to="/forgot-password" className="inline-flex h-14 items-center justify-center rounded-full bg-primary px-6 font-semibold text-on-primary">
            Request a new link
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <h2 className="text-xl font-semibold">Choose a new password</h2>
          {error && <Banner tone="bad">{error.message}</Banner>}
          <PasswordField label="New password" value={password} onChange={setPassword} checklist autoComplete="new-password" />
          <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={confirmError} />
          <Button type="submit" size="lg" disabled={busy || !password || !confirm}>
            {busy ? 'Updating…' : 'Update password'}
          </Button>
          <p className="text-center text-xs text-ink-soft">You will be signed out on other devices.</p>
        </form>
      )}
    </AuthLayout>
  );
}
