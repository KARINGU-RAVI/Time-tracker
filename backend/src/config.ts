export interface Config {
  port: number;
  authMode: 'dev' | 'google';
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
  const allowedEmail = env.ALLOWED_EMAIL;
  if (!allowedEmail) throw new Error('ALLOWED_EMAIL is not set.');

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
  allowedEmail: string;
  googleClientId: string;
  sessionSecret: string;
  appOrigin: string;
}

/**
 * Strict configuration for the deployed (serverless) API. It is stricter than loadConfig on purpose:
 * on a public URL there is no safe default, so anything missing or weak stops the function at start-up.
 */
export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const missing = ['DATABASE_URL', 'ALLOWED_EMAIL', 'GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'APP_ORIGIN'].filter((k) => !env[k]);
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
  return {
    allowedEmail: env.ALLOWED_EMAIL!,
    googleClientId: env.GOOGLE_CLIENT_ID!,
    sessionSecret: env.SESSION_SECRET!,
    appOrigin: origin.origin,
  };
}
