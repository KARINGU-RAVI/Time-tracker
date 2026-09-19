# Office Hours Tracker

Personal office-hours tracker. Records raw IN/OUT sessions and calculates everything else on read.

## Layout

```
docs/                     design documents (domain rules, ER design, Stitch prompts and status)
packages/engine/          pure TypeScript calculation engine (no dependencies), fully unit-tested
apps/api/                 (next) Express + Prisma + PostgreSQL, runs as a Netlify Function
apps/web/                 (next) React + Vite + Tailwind + shadcn/ui
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

Rule IDs (R-01 ...) in `docs/01-domain-screens-er.md` map to the tests in `packages/engine/tests`.

## Commands

```
npm install
npm test            # run all tests
npm run typecheck
```
