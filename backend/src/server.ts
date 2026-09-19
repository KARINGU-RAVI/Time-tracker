import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { devAuthenticator } from './auth';
import { loadConfig } from './config';
import { createGoogleVerifier } from './google';
import { sessionAuthenticator } from './routes/auth';

const config = loadConfig();
const prisma = new PrismaClient();

const app =
  config.authMode === 'google'
    ? createApp({
        prisma,
        clock: () => Date.now(),
        authenticate: sessionAuthenticator(prisma, config.sessionSecret!),
        auth: {
          allowedEmail: config.allowedEmail,
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
