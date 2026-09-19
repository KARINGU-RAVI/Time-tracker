export interface Config {
  port: number;
  authMode: 'dev' | 'google';
  /** Dev mode only: the account every request acts as. Not used when signing in with Google or a password. */
  allowedEmail: string;
  googleClientId?: string;
  sessionSecret?: string;
  appOrigin?: string;
  secureCookies: boolean;
}

/**
 * Reads and checks the environment. The development login (every request is the
 * owner) must never run in production: a public URL would be wide open.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = env.AUTH_MODE === 'google' ? 'google' : 'dev';
  const production = env.NODE_ENV === 'production';
  if (production && authMode === 'dev') {
    throw new Error('Refusing to start: AUTH_MODE=dev is not allowed when NODE_ENV=production.');
  }
  const allowedEmail = env.ALLOWED_EMAIL ?? '';
  if (authMode === 'dev' && !allowedEmail) throw new Error('ALLOWED_EMAIL is not set (dev mode acts as this account).');

  if (authMode === 'google') {
    if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not set.');
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be set and at least 32 characters long.');
    }
    if (production && !env.APP_ORIGIN) throw new Error('APP_ORIGIN is not set.');
  }

  return {
    port: Number(env.PORT ?? 8787),
    authMode,
    allowedEmail,
    googleClientId: env.GOOGLE_CLIENT_ID,
    sessionSecret: env.SESSION_SECRET,
    appOrigin: env.APP_ORIGIN,
    secureCookies: production,
  };
}

export interface ProductionConfig {
  googleClientId: string;
  sessionSecret: string;
  appOrigin: string;
  brevoApiKey: string;
  emailFrom: string;
  turnstileSecret: string;
  maxAccounts: number;
}

/**
 * Strict configuration for the deployed (serverless) API. It is stricter than loadConfig on purpose:
 * on a public URL there is no safe default, so anything missing or weak stops the function at start-up.
 */
export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const missing = ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'APP_ORIGIN', 'BREVO_API_KEY', 'EMAIL_FROM', 'TURNSTILE_SECRET_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}.`);
  if (env.AUTH_MODE !== 'google') throw new Error('AUTH_MODE must be "google" for the deployed API (dev sign-in is never allowed here).');
  if (env.SESSION_SECRET!.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters long.');
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN!);
  } catch {
    throw new Error('APP_ORIGIN must be a full URL such as https://your-site.netlify.app.');
  }
  if (origin.protocol !== 'https:') throw new Error('APP_ORIGIN must use https.');
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must be just the site address, without a path.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.EMAIL_FROM!)) throw new Error('EMAIL_FROM must be an email address (a sender verified with Brevo).');
  const maxAccounts = env.MAX_ACCOUNTS === undefined || env.MAX_ACCOUNTS === '' ? 200 : Number(env.MAX_ACCOUNTS);
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 100000) {
    throw new Error('MAX_ACCOUNTS must be a whole number between 1 and 100000.');
  }
  return {
    googleClientId: env.GOOGLE_CLIENT_ID!,
    sessionSecret: env.SESSION_SECRET!,
    appOrigin: origin.origin,
    brevoApiKey: env.BREVO_API_KEY!,
    emailFrom: env.EMAIL_FROM!,
    turnstileSecret: env.TURNSTILE_SECRET_KEY!,
    maxAccounts,
  };
}
