import { useEffect, useRef } from 'react';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

interface TurnstileApi {
  render: (el: HTMLElement, o: { sitekey: string; callback: (t: string) => void; 'expired-callback': () => void; 'error-callback': () => void }) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function load(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the human check.'));
    document.head.appendChild(s);
  });
}

/** True when a token is required before a form may be sent (a site key is configured). */
export const turnstileRequired = Boolean(SITE_KEY);

/**
 * The "are you human" check. Reports a token (or null when it expires or fails). Without a site key (local
 * development) it renders nothing, and the local server, which is then also unconfigured, does not ask for one.
 */
export function Turnstile({ onToken, resetSignal = 0 }: { onToken: (token: string | null) => void; resetSignal?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;
    load()
      .then(() => {
        if (cancelled || !window.turnstile || !holder.current) return;
        widget.current = window.turnstile.render(holder.current, {
          sitekey: SITE_KEY,
          callback: (t) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, []);

  // A token works once; after each submit the parent bumps resetSignal to get a fresh one.
  useEffect(() => {
    if (resetSignal > 0 && widget.current && window.turnstile) {
      cb.current(null);
      window.turnstile.reset(widget.current);
    }
  }, [resetSignal]);

  if (!SITE_KEY) return null;
  return <div ref={holder} className="flex min-h-[65px] justify-center" aria-label="Human check" />;
}
