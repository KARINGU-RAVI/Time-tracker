# Deployment runbook (Netlify + Neon + Google sign-in)

Do the steps in order. Every step says how to check it worked. Nothing here needs a paid plan.

## 0. What you need to decide first
| Item | Suggested |
|---|---|
| Your Google account email (the only one allowed in) | the one you use daily |
| Site name | e.g. `my-office-hours` → `https://my-office-hours.netlify.app` |
| Tracking start date | 2026-09-21 |
| Opening balance | 12.75 annual, 1 optional (already in the seed) |
| Neon region | closest to you (Singapore / Mumbai if offered) |

## 1. Put the code on a private GitHub repository
1. Create a **private** repo (empty, no README).
2. In the project folder: `git init`, `git add .`, `git commit -m "Initial commit"`, `git branch -M main`, add the remote, `git push -u origin main`.
3. Check: `backend/.env` is **not** in the repo (it is git-ignored). If it is, stop and tell me.

## 2. Database on Neon
1. Create a project at neon.tech. Note two connection strings: **pooled** (host contains `-pooler`) and **direct**.
2. Run migrations from your own computer (never from Netlify):
   ```
   cd backend
   set DIRECT_URL=<direct string>      (PowerShell: $env:DIRECT_URL="...")
   set DATABASE_URL=<direct string>
   npx prisma migrate deploy
   ```
   Check: the output lists `init` and `integrity_constraints` as applied. If `btree_gist` fails, tell me; Neon supports it, but this is unverified.
3. Seed your account (once): set `ALLOWED_EMAIL` and `SEED_TRACKING_START=2026-09-21`, then `npx tsx prisma/seed.ts`. It is safe to re-run.

## 3. Google sign-in
1. Google Cloud Console → APIs & Services → Credentials → Create **OAuth client ID** → type **Web application**.
2. **Authorized JavaScript origins**: `https://<site-name>.netlify.app` (and `http://localhost:5173` for local tests). No redirect URIs are needed.
3. Copy the Client ID (`…apps.googleusercontent.com`). It is not a secret.

## 4. Netlify site
1. Add new site → Import from GitHub → pick the repo. Netlify reads `netlify.toml`; change nothing in the build settings.
2. Site settings → Environment variables. Use `deploy/netlify.env.example` as the list:
   `DATABASE_URL` (pooled), `AUTH_MODE=google`, `ALLOWED_EMAIL`, `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`, `SESSION_SECRET` (generate: `openssl rand -base64 48`), `APP_ORIGIN=https://<site-name>.netlify.app`.
3. Site settings → Build & deploy → turn **off** deploy previews and branch deploys (the config also fails them on purpose, so previews can never run with production secrets).
4. Deploy. Free plan: each production deploy costs about 15 of 300 monthly credits, so avoid pushing many small commits.

## 5. Verify the live site
```
node scripts/smoke.mjs https://<site-name>.netlify.app
```
All checks must pass. Then open the site, sign in with Google, and confirm: Today shows "Tracking starts on 21 Sep 2026" until then, Leave shows 12.75 annual and 1 optional.

If sign-in says "credential refused", `APP_ORIGIN` or the authorized origin does not match the address exactly.

## 6. Everyday operation
- **Health**: `https://<site>/api/health` returns `{"ok":true,...}`.
- **Backup**: More → Settings → Data → Download backup, at least monthly. Keep the file somewhere other than this computer.
- **Restore**: same screen, upload the file, type `REPLACE` to confirm.
- **Rollback**: Netlify → Deploys → pick the last good deploy → Publish deploy. Database migrations are not rolled back; ask me before changing the schema.
- **Rotate the session secret** (signs you out everywhere): change `SESSION_SECRET`, redeploy.

## 7. Not verified until you run it
Netlify itself, real Google tokens, Neon (extension support, cold-start time), the GitHub Actions workflow, and the app in a real phone browser. The automated tests simulate all of these, and the smoke script checks the live result in step 5.

## 8. Security to do now
The Stitch API key pasted earlier in chat must be revoked and regenerated.
