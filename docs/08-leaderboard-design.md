# Leaderboard (opt-in, "closest to goal" ranking)

Status: DESIGN, nothing built yet.

## 0. Why this shape

The obvious version — rank everyone by raw hours worked — turns a personal tracker into a
surveillance tool and rewards unhealthy overwork (staying latest wins). Two decisions fix that:

1. **Opt-in, not default-on.** A user who never touches the setting is invisible to the
   leaderboard, in both directions: they don't appear in it, and calling the endpoint doesn't
   leak anyone else's data to them either (see §4).
2. **Rank by "% of goal met", not raw minutes.** Someone who does exactly their required 40h
   ranks above someone who did 55h in a way that reads as `100%` vs `137%`, not `2400 min` vs
   `3300 min`. This is the same number people already see on their own dashboard
   (`balanceMinutes` relative to `requiredMinutes`), just compared across people. It stops the
   leaderboard from being "who stayed latest" and keeps it "who's on track."

Everything else below follows from those two rules.

## 1. Data model

Add one column, no new table. Multi-user auth already exists (`User.passwordHash`,
`setupCompletedAt`, `isAdmin` — see `backend/prisma/schema.prisma`), so this only needs the
opt-in flag plus a display name people are fine showing to colleagues:

```prisma
model UserSettings {
  // ...existing fields...
  leaderboardOptIn    Boolean @default(false)
  leaderboardDisplayName String? // falls back to User.name, then "Anonymous"
}
```

No new table because the leaderboard has no state of its own — it's a live read over
`Attendance` / `AttendanceSession`, computed with the same `@oht/engine` functions every other
view uses. Nothing to keep in sync, nothing that can drift.

## 2. Computation

Reuse `calculateWeeklyAttendance` / `calculateMonthlyAttendance` exactly as
`backend/src/routes/dashboard.ts` does today, just looped over every opted-in user instead of
`currentUser(req)`:

```
for each opted-in user:
  cfg = loadUserConfig(prisma, userId, now)     // existing helper, services/engineData.ts
  records = loadRecords(prisma, userId, start, end)
  period = calculateWeeklyAttendance(anchor, records, cfg.ctx)   // or Monthly
  pct = period.requiredMinutes > 0 ? period.workedMinutes / period.requiredMinutes : null
```

`pct === null` (no required minutes yet — e.g. before their tracking start date, or a period
that's entirely holidays/leave) is excluded from ranking, not shown as 0%.

This is an N-user fan-out of existing single-user queries. At the scale this app runs at
(colleagues, not a company-wide product), that's fine — no caching layer needed yet. If the
opted-in count grows past maybe 50, batch the Attendance/AttendanceSession reads with a single
`WHERE userId IN (...)` query instead of one round trip per user; the engine calculation itself
is pure and cheap either way.

## 3. API

`GET /api/leaderboard/week?date=YYYY-MM-DD` (and `/leaderboard/month?year=&month=`), same query
shape as the existing `/summary/week` and `/summary/month`.

Response:
```json
{
  "period": { "start": "...", "end": "...", "throughDate": "..." },
  "you": { "optedIn": false, "pct": 0.92, "rank": null },
  "entries": [
    { "rank": 1, "displayName": "Priya", "pct": 1.05, "isYou": false },
    { "rank": 2, "displayName": "Ravi",  "pct": 0.98, "isYou": true  }
  ]
}
```

Rules:
- `entries` includes only opted-in users, sorted by `pct` descending.
- `you` is always computed and returned even if not opted in, with `rank: null` — so a user can
  see "you'd be #2" as an incentive to opt in, without ever appearing to others uninvited.
- No raw `workedMinutes`, no session times, no leave type, no incomplete/unrecorded flags in the
  response — `pct` and a name are the entire payload. Someone opted in is trusting colleagues
  with one number, not their attendance record.
- 403 nothing special needed beyond the normal auth middleware; this is authenticated-users-only,
  same as every other route.

## 4. Privacy edges to get right

- Turning `leaderboardOptIn` off must remove the user from `entries` on the very next request —
  no cached snapshot, no "last week you were still visible" lag, since there's no stored
  leaderboard state to go stale (see §1).
- Deleting the account (`docs/07-multi-user-design.md` §5) already cascades everything; nothing
  extra to clean up here.
- `leaderboardDisplayName` is free text but never an email or employee ID by default, so opting
  in doesn't accidentally publish PII beyond a name the user chose to show.
- Admins (`isAdmin`) get no special leaderboard visibility. Being an admin of the shared holiday
  calendar is unrelated to seeing everyone's numbers — don't conflate the two.

## 5. Frontend

- **Settings:** one toggle ("Show me on the team leaderboard") + optional display-name field,
  next to the existing profile fields from the setup wizard.
- **New Leaderboard view:** a simple ranked list, week/month toggle (mirrors the existing
  dashboard's week view), your own row highlighted. If not opted in, show your computed `pct`
  and rank-if-you-joined inline with a one-line opt-in prompt, not a separate empty state.
- No push notifications, no "X just overtook you" alerts — those are exactly the mechanic that
  turns this into a pressure tool instead of a lightweight nudge.

## 6. Build order

1. Migration: `leaderboardOptIn`, `leaderboardDisplayName` on `UserSettings` (both default off /
   null, so existing users are unaffected and invisible until they opt in).
2. `GET /api/leaderboard/week` — loop + `pct` computation, tests for: nobody opted in → empty
   `entries`; a period with `requiredMinutes === 0` → excluded, not zero; toggling opt-in off
   removes you immediately.
3. `GET /api/leaderboard/month`, same logic, different period function.
4. Settings toggle + display name field.
5. Leaderboard page.
