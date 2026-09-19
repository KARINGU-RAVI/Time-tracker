import type { Handler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import serverless from 'serverless-http';
import { createApp } from './app';
import { loadProductionConfig } from './config';
import { BrevoEmailSender, type EmailSender } from './email';
import { createGoogleVerifier, type GoogleVerifier } from './google';
import { sessionAuthenticator } from './routes/auth';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile';

/**
 * Where Netlify puts the function. Depending on how a request reaches it (the /api/* rewrite or a direct
 * call) the path can arrive as /api/x, /.netlify/functions/api/x or /.netlify/functions/api/api/x.
 * All three must reach the same Express route, which is mounted under /api.
 */
export function normalisePath(path: string): string {
  const stripped = path.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '');
  if (stripped === '' || stripped === '/') return '/api';
  return stripped.startsWith('/api') ? stripped : `/api${stripped}`;
}

export interface LambdaOverrides {
  prisma?: PrismaClient;
  verifyGoogle?: GoogleVerifier;
  email?: EmailSender;
  verifyTurnstile?: TurnstileVerifier;
  clock?: () => number;
}

/**
 * Builds the serverless handler. Everything expensive (config, Prisma client, Express app) is created ONCE
 * here, at cold start, and reused by every warm invocation.
 * Any configuration problem throws immediately, so a broken deployment fails loudly instead of running unsafely.
 */
export function createHandler(env: NodeJS.ProcessEnv = process.env, overrides: LambdaOverrides = {}): Handler {
  const config = loadProductionConfig(env);
  const prisma = overrides.prisma ?? new PrismaClient();

  const app = createApp({
    prisma,
    clock: overrides.clock ?? (() => Date.now()),
    authenticate: sessionAuthenticator(prisma, config.sessionSecret),
    auth: {
      verifyGoogle: overrides.verifyGoogle ?? createGoogleVerifier(config.googleClientId),
      sessionSecret: config.sessionSecret,
      // Always Secure: this only ever runs behind HTTPS, and it must not depend on NODE_ENV being set.
      secureCookies: true,
      appOrigin: config.appOrigin,
      email: overrides.email ?? new BrevoEmailSender(config.brevoApiKey, { email: config.emailFrom, name: 'Office Hours' }),
      verifyTurnstile: overrides.verifyTurnstile ?? createTurnstileVerifier(config.turnstileSecret),
      maxAccounts: config.maxAccounts,
    },
  });

  const inner = serverless(app, {
    // Netlify sends Set-Cookie as one value per header; keep them separate.
    binary: false,
  }) as unknown as Handler;

  return (event, context, callback) => {
    const e = event as { path?: string; rawUrl?: string };
    const patched = { ...event, path: normalisePath(e.path ?? '/') };
    // Do not wait for the event loop to drain: the database pool must not keep the function alive.
    (context as { callbackWaitsForEmptyEventLoop?: boolean }).callbackWaitsForEmptyEventLoop = false;
    return inner(patched, context, callback);
  };
}
