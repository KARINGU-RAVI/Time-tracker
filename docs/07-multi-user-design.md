# Multi-user design (open sign-up, Google or email + password, setup wizard)

Status: DESIGN, nothing built yet. Decisions so far: anyone can sign up (any email); sign-in by Google or by email + password; first sign-in goes through a setup wizard with company defaults, editable; the existing account and its data stay exactly as they are.

## 1. What changes
| Today | After |
|---|---|
| One allowed email (`ALLOWED_EMAIL`) | Anyone may register |
| Google only | Google, or email + password |
| Account created by seed script | Account created at first sign-in, then a setup wizard |
| Rules, policy, balances seeded | Entered in the wizard, pre-filled with defaults |
| Data isolation is not a risk (one user) | Data isolation is the most important property |

The existing account (`karinguravi307@gmail.com`, id `0c75c875...`) is marked `setupComplete = true` by the migration, so it never sees the wizard and none of its data is touched.

## 2. Accounts and sign-in
- `User` gets: `passwordHash` (nullable), `emailVerifiedAt`, `setupCompletedAt`, `failedLogins`, `lockedUntil`.
- Same email = same account. Google sign-in on an email that already has a password account is allowed only when Google says the email is verified, and it links to that account. A password sign-up on an email that has a Google account is refused with a neutral message ("use Google, or reset your password").
- **Passwords:** hashed with `scrypt` from Node's built-in `crypto` (no native modules to break on Netlify), random salt, tuned cost, constant-time comparison. Minimum 10 characters, a short list of common passwords refused, maximum 128.
- **Email verification is required** before a password account can sign in (a link with a random single-use token, stored hashed, expiring in 24h). Google accounts arrive verified.
- **Password reset:** the same token mechanism, 1 hour expiry, single use, invalidates other sessions. The response never reveals whether an email exists.
- **Sessions:** unchanged (signed HttpOnly SameSite=Lax cookie); adding a `sessionVersion` on the user so a reset or "sign out everywhere" invalidates old cookies.
- **Abuse protection** (needed because sign-up is open on a free database):
  - Rate limits stored in the database (a serverless function has no shared memory): per IP and per email, for sign-up, sign-in, reset and verification requests.
  - Account lockout after repeated failures (temporary, 15 min).
  - A bot check (Cloudflare Turnstile, free) on sign-up and reset. Needs a Cloudflare account and a site key.
  - Cap on total accounts (default 200, an environment variable) so a flood cannot fill the 0.5 GB Neon database. Unverified accounts are deleted after 3 days.

## 3. Email sending (a hard requirement)
Verification and reset need real email. Options, all free tiers:
| Provider | Free | Needs |
|---|---|---|
| Resend | 100/day, 3000/month | A domain you own to send to anyone. Without one it only sends to your own address. |
| Brevo | 300/day | A verified sender address; works without owning a domain but mail from a Gmail address often lands in spam. |
| Gmail SMTP with an app password | about 500/day | Works, looks personal, spam risk, ties the app to your Gmail. |
Decision needed: which one, and whether you own a domain.

## 4. Setup wizard
State machine: `setupCompletedAt = null` means every API route except `/api/setup/*`, `/api/auth/*`, `/api/health` and `/api/me` returns 403 `SETUP_REQUIRED`; the frontend routes to `/setup`.
Steps (defaults pre-filled, all editable, validated by the server with zod):
1. **Profile:** name, employee ID, designation, business unit (optional).
2. **Work rules:** daily minutes (default 480), weekly (2400), working days (Mon-Fri), week start (Monday), tracking start date (default: next Monday), timezone (default Asia/Kolkata; the engine is currently fixed to IST, so other zones are refused for now).
3. **Leave policy and opening balances:** entitlement 21, monthly credit 1.75, carry cap 3, optional quota 2, bereavement 5, annual leaves carried in, annual used so far this year, optional used this year. A live preview shows the computed balance before saving.
4. **Holidays:** the shared company calendar (copied to the user), or their own CSV upload, or empty.
Saving is one database transaction: profile, settings, work rule, policy, opening ledger, holidays, `setupCompletedAt`. It is idempotent (second call after completion is refused), and a failed transaction leaves nothing half-created.
Later, the same values are editable in Settings (rule changes create a new effective-dated rule, as now).

## 5. Data isolation
Every query already filters by `userId`. New guarantees:
- All resource lookups by id use `where: { id, userId }` (never `id` alone). A grep-based test fails the build if a Prisma call on a user-owned model lacks `userId`.
- A cross-user test suite: user B tries to read, edit, delete and restore user A's records by id, on every route, and must always get 404, never 403 (so ids are not confirmed to exist).
- Backup and restore stay per user. Restore replaces only the caller's data.
- **Delete my account:** removes the user and everything under it (cascade), after re-entering the password or a fresh Google sign-in. **Export my data** is the existing backup.

## 6. Shared company holidays
A user with `isAdmin = true` (you) manages a shared calendar table. The wizard copies it to the new user; later changes to the shared calendar do not silently alter people's own copies (a "sync from company calendar" button offers to add missing dates).

## 7. Operating limits and honest risks
- Netlify free plan (300 credits a month, about 15 per deploy) and Neon free plan (0.5 GB, compute hours) are shared by all users. The account cap protects the database.
- Google consent screen must be published to production so non-test users can sign in (no verification needed for basic sign-in scopes, but users see an "unverified" hint until reviewed).
- You are now holding other people's attendance data. A short privacy note, the delete-my-data option, and telling colleagues that you can technically see the database are the honest minimum.
- Open sign-up with passwords is the largest security change to date. It gets its own tests: brute force, enumeration, token reuse and expiry, session invalidation, rate limits, and the isolation suite above.

## 8. Build order (each step tested and confirmed before the next)
1. Migration: user columns, `setupCompletedAt` backfilled for the existing account, rate-limit and token tables.
2. Password auth API (sign-up, verify, sign-in, reset) + email sender interface (with a fake for tests) + rate limits + lockout.
3. Google sign-in opened to any verified email (replaces the allowlist).
4. Setup gate + wizard API + balance preview.
5. Frontend: sign-in/sign-up/reset screens, wizard, Settings changes.
6. Isolation suite + delete-my-data + shared holiday admin.
7. Deploy: environment variables, Turnstile, email provider, publish Google consent screen, smoke test extended.
