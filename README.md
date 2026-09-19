# Office Hours Tracker

Personal office-hours tracker. Records raw IN/OUT sessions and calculates everything else on read.

## Layout

```
docs/                     design documents (domain rules, ER design, Stitch prompts and status)
shared/engine/          pure TypeScript calculation engine (no dependencies), fully unit-tested
backend/                 Express + Prisma + PostgreSQL REST API (dev auth only so far; runs as a Netlify Function later)
frontend/                 (next) React + Vite + Tailwind + shadcn/ui
```

## Engine

`@oht/engine` is the source of truth for every number in the app. It is deterministic: the current
time is always passed in (`ctx.now`), never read from the clock.

| Area | Functions |
|---|---|
| Day | `calculateDailyAttendance`, `calculateOvertime`, `calculateRemainingMinutes` |
| Sessions | `validateSessions`, `calculateWorkedMinutes`, `calculateOutsideMinutes` |
| Periods | `calculateWeeklyAttendance`, `calculateMonthlyAttendance`, `calculatePeriod` |
| Live | `calculateExpectedCheckout`, `canILeaveNow` |
| Leave | `allocateLeave`, `leaveBalanceAt`, `previewLeave`, `lopByMonth`, `yearEndLapse`, `missingMonthlyAccruals` |
| Format | `formatDuration`, `formatLeaveDays` |

Rule IDs (R-01 ...) in `docs/01-domain-screens-er.md` map to the tests in `shared/engine/tests`.

## Commands

```
npm install
npm test            # run all tests
npm run typecheck
```

## API (backend)

Requires a migrated PostgreSQL: copy `backend/.env.example` to `.env`, then
`npm run db:migrate -w @oht/backend` and `npm run db:seed -w @oht/backend`. Start with
`npx tsx src/server.ts` (dev auth: every request is the owner, refused in production).

| Area | Endpoints |
|---|---|
| Live | `POST /api/attendance/check-in`, `POST /api/attendance/check-out`, `GET /api/attendance/today`, `GET /api/dashboard` |
| Days | `GET /api/attendance?startDate&endDate`, `GET/PUT/DELETE /api/attendance/:date` |
| Sessions | `POST /api/attendance/:date/sessions`, `PUT/DELETE /api/sessions/:id` |
| Summaries | `GET /api/summary/week?date=`, `GET /api/summary/month?year&month` |
| Rules | `GET /api/rules`, `POST /api/rules` (versioned, no PUT) |
| Holidays | `GET/POST /api/holidays`, `PUT/DELETE /api/holidays/:id`, `POST /api/holidays/import/preview`, `POST /api/holidays/import/commit` |
| Leave | `GET /api/leave`, `POST /api/leave/preview`, `POST /api/leave/apply`, `POST /api/leave/bereavement-events` |
| Backup | `GET /api/backup` (download), `POST /api/backup/validate` (checks a file, saves nothing), `POST /api/backup/restore` (needs `confirm: "REPLACE"`, atomic) |
| Reports | `GET /api/export/csv?startDate&endDate&type=daily\|sessions` |
| Public | `GET /api/health` |

Errors are always `{ "error": { "code", "message" } }` with the messages from the design document.

## Frontend (frontend)

React 18 + TypeScript + Vite + Tailwind (v4) with shadcn-style components, TanStack Query and Axios.
Screens: Today, Day Detail, Calendar, Summary, Leave, Holidays (with CSV import), Settings, Login.
It uses the same `@oht/engine` for formatting, so numbers always match the backend.

## Run it locally

```
# 1. a migrated PostgreSQL and backend/.env (see backend/.env.example), then:
npm run db:migrate -w @oht/backend
npm run db:seed -w @oht/backend

# 2. two terminals
cd backend  && npx tsx src/server.ts      # API on http://127.0.0.1:8787 (dev auth)
cd frontend && npm run dev                # app on http://127.0.0.1:5173 (proxies /api)
```

For Google sign-in set `AUTH_MODE=google` (see `backend/.env.example`) and `VITE_GOOGLE_CLIENT_ID` in
`frontend/.env`.

## Not built yet

Excel/PDF report export, the Netlify function wrapper and deployment.
