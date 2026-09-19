import { CheckCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/button';
import { Banner, Skeleton } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

/** The page the emailed link opens. It uses the single-use token once, which also signs the person in. */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    // React may run this effect twice in development; the link works only once, so guard it.
    if (started.current) return;
    started.current = true;
    if (!token) {
      setState('failed');
      setMessage('This link is incomplete. Open it again from the email.');
      return;
    }
    post('/auth/verify-email', { token })
      .then(() => setState('done'))
      .catch((e) => {
        setState('failed');
        setMessage(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      });
  }, [token]);

  async function next() {
    await qc.invalidateQueries();
    navigate('/', { replace: true });
  }

  return (
    <AuthLayout subtitle="Verify your email.">
      {state === 'working' && (
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <p className="text-sm text-ink-soft">Verifying your email…</p>
        </div>
      )}
      {state === 'done' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-ok/10 text-ok">
            <CheckCircle2 size={30} aria-hidden />
          </div>
          <h2 className="text-xl font-semibold">Email verified</h2>
          <p className="text-sm text-ink-soft">Next, set up your work hours and leave so your balances are right from day one.</p>
          <Button size="lg" onClick={next}>
            Continue to setup
          </Button>
        </div>
      )}
      {state === 'failed' && (
        <div className="flex flex-col gap-4">
          <Banner tone="bad">{message}</Banner>
          <Link to="/" className="text-center text-sm font-medium text-primary">
            Back to sign in
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
