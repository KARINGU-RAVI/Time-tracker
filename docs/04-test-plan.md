# Test Plan and Traceability

Status (19 Sep 2026): **343 automated tests, all passing.** Typecheck clean.

| Package | Tests | Line coverage | Runs against |
|---|---|---|---|
| `shared/engine` | 100 | 99.7% | pure functions |
| `backend` | 138 | 97.5% (`server.ts` entry point not covered) | real PostgreSQL 18 + full Express app (supertest) |
| `frontend` | 105 | 95.5% (`main.tsx` not covered) | React Testing Library + jsdom, API mocked |

Run everything: `npm test` (needs the local PostgreSQL from `backend/.env`). Coverage: `npx vitest run --coverage` in a package.

## 1. Spec section 28: the 25 edge cases

| # | Edge case | Where it is tested |
|---|---|---|
| 1 | Forgot to check out | engine `sessions` (open session on a past day is incomplete), `day` (unclosed past session); backend `api` ("repairs a forgotten OUT", check-out days later is refused); frontend `Today` (refusal shows a "Fix it" link), `DayDetail` ("Add OUT time" opens the editor) |
| 2 | Forgot to check in | backend `api` (manual session on a past date), frontend `AddSessionDialog` |
| 3 | Multiple breaks | engine `sessions` (unlimited sessions), `invariants` (300 random days) |
| 4 | Very short break | engine `sessions` (2-minute gap) |
| 5 | Midnight crossing | engine `sessions`; backend `constraints` (blocks next day's early hours), `edge` #5; frontend `AddSessionDialog` ("OUT is on the next day") |
| 6 | Editing historical records | engine `day` (correction recalculates); backend `edge` #6 (edit into an overlap is refused) |
| 7 | Deleting a session | backend `api` (last session removed makes the day unrecorded); frontend `DayDetail` (asks before deleting) |
| 8 | Invalid IN/OUT sequence | engine `sessions` (OUT before IN, zero length, too long); backend `constraints`, `api`; frontend `AddSessionDialog` |
| 9 | Duplicate IN | engine `MULTIPLE_OPEN`; backend `constraints` (one open per user), `api` ("You are already checked in since 08:02.") |
| 10 | Duplicate OUT | backend `api`, `edge` #10 ("No active session to check out.", same-minute OUT) |
| 11 | Overlapping sessions | engine `sessions`; backend `constraints` (exclusion constraint), `api`; frontend `AddSessionDialog` (shows the server message) |
| 12 | Holiday | engine `day`, `period`; backend `edge`; frontend `Today`, `Calendar`, `Summary`, `DayDetail` (no missing-hours warning) |
| 13 | Weekly off | engine `day` (work on a day off is excluded); frontend `Summary`, `Calendar`, `DayDetail` |
| 14 | Leave | engine `day`, `period`; backend `api`, `edge`; frontend `Leave`, `DayDetail` |
| 15 | WFH | engine `day`; backend `api` |
| 16 | Company rule change | engine `period` (mid-week change), `invariants` (boundary dates); backend `api` (versioned rules) |
| 17 | Daylight/timezone consistency | engine `invariants` (identical results in 6 device timezones), `time-format` |
| 18 | Browser refresh | backend `edge` #18 (open session survives a brand-new server instance) |
| 19 | Network failure | frontend `Today`, `Calendar`, `Summary`, `Leave`, `Holidays`, `DayDetail`, `App` (message plus retry), `lib` (`toApiError`) |
| 20 | Backend unavailable | same tests as 19, plus the offline banner in `App` |
| 21 | Duplicate API requests | backend `constraints`, `api`, `edge` #21 (simultaneous requests: exactly one wins); frontend `Today` (button disabled while pending) |
| 22 | Accidental page close | backend `edge` #18 (state lives on the server) |
| 23 | Current active session | engine `day`, `live`; backend `api` |
| 24 | User changes timezone | engine `invariants` (the device timezone never matters; the app is IST only by design) |
| 25 | Historical recalculation | engine `day`, `invariants` (deterministic, order independent, never mutates input) |

## 2. Spec section 34: required engine cases

8h exactly, 7h 30m, 8h 30m, multiple sessions, multiple breaks, open session, holiday, leave, WFH, weekly balance, rule change, invalid session, overlapping sessions, midnight session, historical calculation: all in `shared/engine/tests/day.test.ts`, `period.test.ts`, `sessions.test.ts`, with random-input invariants in `invariants.test.ts`.

## 3. Other areas

| Area | Tests |
|---|---|
| Database integrity (rules the DB enforces itself) | `backend/tests/constraints.test.ts` (25) |
| Authentication and security | `backend/tests/auth.test.ts` (17): forged, tampered, expired, unsigned tokens; wrong Google account; different Google identity; CSRF; production config guard |
| User isolation (multi-user readiness) | `backend/tests/edge.test.ts` ("users are isolated") |
| Leave policy | engine `leave` (14); backend `api`, `edge` (LOP, carry-forward, year rollover, bereavement limit) |
| Error handling and no leakage | backend `unit` (500s never expose SQL or secrets) |
| Holiday import | backend `unit` (CSV and date formats), `api`, `edge`; frontend `Holidays` |
| Backup, restore and CSV report | `backend/tests/backup.test.ts` (25): round trip into another account, damaged/edited/oversized files, atomic rollback, checksum, isolation, formula-injection guard; `frontend/src/components/DataCard.test.tsx` (14): guarded restore flow |
| Everything on screen | one test file per screen in `frontend/src/pages` |

## 4. Mutation checks (deliberately breaking the code to confirm tests notice)

| Broken on purpose | Result |
|---|---|
| Year-end lapse cap off by one | caught (`year rollover`) |
| Owner-only sign-in check removed | **first missed** (a second defence masked it); test strengthened, then caught |
| Attendance loaded without the user filter | caught by 3 tests |
| 6th bereavement day allowed | caught |
| Check Out button not disabled while pending | caught |
| Backup checksum verification skipped | caught |
| Export leaks other users' holidays | caught by 4 tests |
| Restore forgets to clear old holidays | caught by 3 tests |
| Restore without typing REPLACE | caught |
| Unpaid-leave warning hidden | caught |

## 5. Not covered (be aware)

- **Real Google tokens.** Verification is tested with a fake Google, and the wrapper with a mocked library. It has never seen a real token.
- **Real browser end-to-end tests** (Playwright or similar). The frontend is tested in jsdom, not a real browser, so layout, responsiveness and touch behaviour are unverified.
- **Visual correctness** against the Stitch designs, and the **dark theme**.
- **Accessibility audit** (only roles and labels are checked by the tests).
- **Neon and Netlify.** Everything ran on a local PostgreSQL 18; the `btree_gist` extension on Neon and the Netlify function wrapper are untested (the wrapper does not exist yet).
- **Refetch-on-focus and the 60-second refresh** are not unit-tested.
- **Performance and load.**
- The backend `server.ts` entry point.

## 6. Test conventions

- A test that fails must be understood before it is changed. Two of this round's failures were wrong expectations in the tests (and were fixed there); one earlier failure exposed a real bug ("Sept" vs "Sep" on some devices).
- Every rule in `docs/01-domain-screens-er.md` should map to at least one test; new rules need a new test first.
- Tests never depend on the real date: the clock is injected (backend, engine) or Date is faked (frontend).
