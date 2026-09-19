import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banner } from '@/components/ui/primitives';
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

/** Google's own button. Signing in or signing up is the same call: the server creates the account when needed. */
export function GoogleButton({ text }: { text: 'signin_with' | 'signup_with' | 'continue_with' }) {
  const qc = useQueryClient();
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

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
              setError(e instanceof ApiError ? e.message : 'Google sign-in failed. Please try again.');
            }
          },
        });
        window.google.accounts.id.renderButton(holder.current, { theme: 'outline', size: 'large', shape: 'pill', text, width: 300 });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [qc, text]);

  if (!CLIENT_ID) return null;
  return (
    <div className="flex flex-col gap-3">
      <div ref={holder} className="flex min-h-[44px] justify-center" />
      {error && <Banner tone="bad">{error}</Banner>}
    </div>
  );
}

export const googleConfigured = Boolean(CLIENT_ID);
