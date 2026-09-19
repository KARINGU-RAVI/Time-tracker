/**
 * Cloudflare Turnstile bot check (free). The browser gets a token from the widget; the server confirms
 * it with Cloudflare. Injected as a function so tests never call the network.
 */
export type TurnstileVerifier = (token: string | undefined, ip: string | undefined) => Promise<boolean>;

export function createTurnstileVerifier(secret: string, fetchImpl: typeof fetch = fetch): TurnstileVerifier {
  return async (token, ip) => {
    if (!token || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set('remoteip', ip);
      const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { success?: boolean };
      return json.success === true;
    } catch {
      return false; // If the check cannot be completed, the answer is "not verified".
    }
  };
}

/** Local development and tests only: accepts everything. Never used when a secret is configured. */
export const allowAllTurnstile: TurnstileVerifier = async () => true;
