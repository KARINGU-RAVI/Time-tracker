# Netlify Deployment Plan

Status: PLAN. Nothing is deployed and no deployment files exist yet.

## 1. Target architecture

```
Browser ──HTTPS──> Netlify (one site, one origin: https://<site>.netlify.app)
                     ├─ static files: frontend/dist        (React + Vite build)
                     ├─ /api/*  ──rewrite──> Netlify Function "api"  (Express via serverless-http)
                     │                          └── Prisma ──> Neon PostgreSQL (pooled connection)
                     └─ /*      ──rewrite──> /index.html   (single-page-app fallback)
Google Identity Services (browser) ──ID token──> POST /api/auth/google ──> signed HttpOnly cookie
```

Why one origin: the session cookie is `SameSite=Lax` and `HttpOnly`. With the API on the same origin there is
no CORS, no third-party cookie problem, and the CSRF Origin check in `backend/src/routes/auth.ts` works as designed.

## 2. What already exists (no work needed)

- Express app built as `createApp(deps)`, so it can be wrapped without changes.
- Prisma `binaryTargets` already includes `rhel-openssl-3.0.x` (the Netlify/AWS Lambda runtime).
- Google sign-in with allowlist, signed cookie, CSRF guard, and a startup guard that refuses dev auth in production.
- Health endpoint `GET /api/health`.
- 175+ automated tests.

## 3. Work to do before the first deploy (I do this; it needs none of your accounts)

| # | Task | Notes |
|---|---|---|
| 1 | `netlify.toml` at the repo root | Build command, publish dir `frontend/dist`, functions dir, redirects, security headers |
| 2 | `netlify/functions/api.ts` | `serverless-http` wrapper around `createApp`; one `PrismaClient` reused across warm invocations |
| 3 | Prisma `directUrl` | Neon needs the direct (non-pooled) URL for migrations, the pooled URL for the app |
| 4 | Function bundling for Prisma | `external_node_modules` and `included_files` so the Prisma engine and `schema.prisma` ship with the function |
| 5 | Redirects | `/api/*` to the function, everything else to `index.html` |
| 6 | Security headers | CSP allowing only our origin and `accounts.google.com`, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'` |
| 7 | GitHub Actions | Run typecheck and all tests on every push; deploy only when they pass |
| 8 | Production `.env.example` and a deploy checklist | Exact list of variables |
| 9 | Post-deploy smoke script | Health check, unauthenticated request is refused, sign-in page loads |
| 10 | JSON backup and CSV export | Recommended before go-live: Neon's free history is short, so this is the real safety net |
| 11 | Function test | Invoke the wrapped handler locally with a Netlify-style event and confirm responses and cookies |

## 4. Environment variables (set in the Netlify UI, never in git)

| Variable | Value | Scope |
|---|---|---|
| `DATABASE_URL` | Neon **pooled** URL (`...-pooler...?sslmode=require&connect_timeout=15`) | Functions |
| `DIRECT_URL` | Neon **direct** URL (migrations only, from your own computer or CI) | Not needed at runtime |
| `AUTH_MODE` | `google` | Functions |
| `ALLOWED_EMAIL` | your Google address | Functions |
| `GOOGLE_CLIENT_ID` | OAuth client id | Functions |
| `VITE_GOOGLE_CLIENT_ID` | same client id | Build (baked into the frontend) |
| `SESSION_SECRET` | 48+ random characters | Functions |
| `APP_ORIGIN` | `https://<your-site>.netlify.app` (or custom domain) | Functions |
| `NODE_ENV` | `production` | Functions |

Rotating `SESSION_SECRET` signs everyone out (there is only you), which is the "revoke all sessions" switch.

## 5. Deployment order (go-live day)

1. Push the repository to a **private** GitHub repo.
2. Create the Neon project (one branch `main`). Run `CREATE EXTENSION btree_gist` is inside the migration; Neon allows it.
3. From your computer, with `DIRECT_URL` in `backend/.env`: `npm run db:deploy -w @oht/backend` then `npm run db:seed -w @oht/backend`.
4. Create the Google OAuth client with the Netlify URL as an authorised JavaScript origin.
5. Create the Netlify site from the GitHub repo and set the variables above.
6. First deploy. Run the smoke script.
7. Sign in with Google, confirm `12.75` annual and `1` optional, record a test session, delete it.
8. Add an uptime check on `/api/health`.

## 6. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| **Free-plan hard limit.** Free is 300 credits a month with no overage; production deploys cost about 15 credits each and function compute is metered. The site stops if the pool runs out. | A personal app uses very little traffic. Avoid many deploys: run tests in GitHub Actions, deploy only from `main`, disable deploy previews. Watch the usage page once a month. |
| **10-second function timeout on free.** | Every endpoint does a few queries; fine. Cold start plus Neon wake-up can take 1 to 3 seconds. |
| **Cold starts and Neon auto-suspend.** First request after idle is slower. | Acceptable for one user. The frontend shows skeletons and retries network errors. |
| **Region latency.** Function and database should be close. | Choose the Neon region nearest your Netlify function region; check both at setup. |
| **Prisma engine missing in the bundle.** The classic Netlify failure. | Task 4 above, and the function test (task 11) catches it before deploy. |
| **Migrations are forward-only.** | Take a Neon branch (instant copy) before every migration. Never migrate automatically on each build. |
| **Data loss.** | JSON export (task 10) plus Neon point-in-time history. Export weekly. |
| **Secrets leaking.** | Only the Netlify UI holds secrets. `.env` is git-ignored. Regenerate the Stitch key that was pasted in chat. |
| **Deploy previews hitting the real database.** | Turn deploy previews off (single environment). |

## 7. Rollback

- App: Netlify keeps every deploy; "Publish deploy" on the previous one restores it in seconds.
- Database: restore from the Neon branch taken before the migration.
- Sessions: change `SESSION_SECRET`.

## 8. What I need from you

### Accounts (all have free tiers)
1. **GitHub** account with a new private repository (`Ravi-kairos/office-hours-tracker` or another name).
2. **Netlify** account, signed in with GitHub.
3. **Neon** account.
4. **Google Cloud** project with an OAuth client (type: Web application). Consent screen "External", add your own email as a test user. Only the client id is needed.

### Decisions
1. The exact Google account that may sign in.
2. Site name (the URL will be `<name>.netlify.app`) or a custom domain, if you own one.
3. Confirm one environment only (production), with deploy previews off.
4. Confirm the tracking start date (currently 21 Sep 2026) and that opening balances (12.75 annual, 1 optional) are correct for production.
5. Region preference, if you have one (nearest to you is the default).

### Actions only you can do
1. Create the four accounts above.
2. Put the Neon `DIRECT_URL` into `backend/.env` on your computer (not in chat) so migrations can run from here, or run the two commands yourself.
3. Paste the environment variables into the Netlify UI.
4. Regenerate the Stitch API key.

### Not blockers (can happen after go-live)
Deleting duplicate Stitch screens, dark-theme review, a custom domain.

## Sources
- Netlify free plan and limits (2026): https://netli.fyi/blog/netlify-free-plan-limits-2026 and https://www.netlify.com/pricing/
- Netlify monorepo configuration: https://docs.netlify.com/build/configure-builds/monorepos/
- Prisma on Netlify example: https://github.com/prisma/deployment-example-netlify
