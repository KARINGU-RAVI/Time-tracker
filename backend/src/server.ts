import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { devAuthenticator } from './auth';
import { loadConfig } from './config';
import { BrevoEmailSender, ConsoleEmailSender } from './email';
import { createGoogleVerifier } from './google';
import { sessionAuthenticator } from './routes/auth';
import { allowAllTurnstile, createTurnstileVerifier } from './turnstile';

const config = loadConfig();
const prisma = new PrismaClient();

const app =
  config.authMode === 'google'
    ? createApp({
        prisma,
        clock: () => Date.now(),
        authenticate: sessionAuthenticator(prisma, config.sessionSecret!),
        auth: {
          // Local runs print emails to the terminal unless Brevo is configured.
          email: process.env.BREVO_API_KEY && process.env.EMAIL_FROM
            ? new BrevoEmailSender(process.env.BREVO_API_KEY, { email: process.env.EMAIL_FROM, name: 'Office Hours' })
            : new ConsoleEmailSender(),
          verifyTurnstile: process.env.TURNSTILE_SECRET_KEY ? createTurnstileVerifier(process.env.TURNSTILE_SECRET_KEY) : allowAllTurnstile,
          maxAccounts: Number(process.env.MAX_ACCOUNTS ?? 200),
          verifyGoogle: createGoogleVerifier(config.googleClientId!),
          sessionSecret: config.sessionSecret!,
          secureCookies: config.secureCookies,
          appOrigin: config.appOrigin,
        },
      })
    : createApp({
        prisma,
        clock: () => Date.now(),
        authenticate: devAuthenticator(prisma, config.allowedEmail),
      });

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Office Hours API (${config.authMode} auth) on http://127.0.0.1:${config.port}`);
});
