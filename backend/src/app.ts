import express, { Router } from 'express';
import helmet from 'helmet';
import type { PrismaClient } from '@prisma/client';
import { requireAuth, type Authenticator } from './auth';
import { ApiError, errorHandler } from './errors';
import { attendanceRoutes } from './routes/attendance';
import { backupRoutes } from './routes/backup';
import { authRoutes, csrfGuard, type AuthConfig } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { holidayRoutes } from './routes/holidays';
import { leaveRoutes } from './routes/leave';
import { ruleRoutes } from './routes/rules';
import { requireSetup, setupRoutes } from './routes/setup';

export interface AppDeps {
  prisma: PrismaClient;
  /** Current time in epoch ms. Injected so tests control the clock. */
  clock: () => number;
  authenticate: Authenticator;
  /** Google sign-in and cookie sessions. Omitted in dev/test mode. */
  auth?: AuthConfig;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  // Normal requests are tiny. Backup uploads are larger, but they are parsed inside the backup routes,
  // AFTER sign-in, so an anonymous caller can never make the server read a big body.
  const smallJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/backup/') ? next() : smallJson(req, res, next)));

  // Public: lets the frontend and monitoring tell whether the backend is reachable.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date(deps.clock()).toISOString() });
  });

  if (deps.auth) {
    // Public sign-in routes, then the CSRF guard for everything that writes.
    app.use('/api', csrfGuard(deps.auth.appOrigin));
    app.use('/api', authRoutes(deps.prisma, deps.auth, deps.authenticate, deps.clock));
  }

  const api = Router();
  api.use(requireAuth(deps.authenticate));
  // The setup wizard is the only thing a new account can reach; everything below needs setup to be finished.
  api.use(setupRoutes(deps));
  api.use(requireSetup);
  api.use(attendanceRoutes(deps));
  api.use(backupRoutes(deps));
  api.use(dashboardRoutes(deps));
  api.use(ruleRoutes(deps));
  api.use(holidayRoutes(deps));
  api.use(leaveRoutes(deps));
  api.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'That endpoint does not exist.')));
  app.use('/api', api);

  app.use(errorHandler);
  return app;
}
