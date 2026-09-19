import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Card } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

interface GoogleId {
  initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
  renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

function loadGoogleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(s);
  });
}

export default function Login() {
  const qc = useQueryClient();
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(CLIENT_ID ? null : 'Google sign-in is not configured (VITE_GOOGLE_CLIENT_ID is missing).');

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;
    loadGoogleScript()
      .then(() => {
        if (cancelled || !window.google || !holder.current) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: async ({ credential }) => {
            try {
              await post('/auth/google', { credential });
              await qc.invalidateQueries();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.');
            }
          },
        });
        window.google.accounts.id.renderButton(holder.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [qc]);

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary text-on-primary">
          <Clock size={28} aria-hidden />
        </div>
        <h1 className="mt-4 text-2xl font-semibold">Office Hours</h1>
        <p className="mt-1 text-sm text-ink-soft">Your personal working-hours tracker</p>
        {error && <Banner tone="bad" className="mt-4 text-left">{error}</Banner>}
        <div ref={holder} className="mt-6 flex justify-center" />
        <p className="mt-6 text-xs text-ink-soft">Only the authorised Google account can sign in.</p>
      </Card>
    </div>
  );
}
