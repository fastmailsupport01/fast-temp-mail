# Fast Temp Mail — deploy checklist ($0 stack: Render + Supabase)

Work through this top to bottom. Check each box before going live.

## 1. Supabase (free PostgreSQL — no credit card)

- [ ] Created a free Supabase account and a new project (`fasttempmail`).
- [ ] Saved the database password somewhere safe (password manager).
- [ ] Copied the **Connection string → URI** from Project Settings → Database.
- [ ] Using the **pooler** host (`:6543`) with `?pgbouncer=true&sslmode=require` appended.
- [ ] Did **NOT** use Render's free Postgres (it expires after the trial).

## 2. Code on GitHub

- [ ] Pushed this folder's contents (including `render.yaml`, `Dockerfile`, `drizzle/`) to a GitHub repo.
- [ ] No `.env` file or real secrets committed (`.env.example` only).

## 3. Render web service (free — no credit card)

- [ ] Created a free Render account.
- [ ] **New → Blueprint** → connected the repo → **Apply** (plan shows `free`).
- [ ] Set `DATABASE_URL` to the Supabase string.
- [ ] Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (min 10 characters).
- [ ] `SESSION_SECRET` generated (Render does this via `generateValue`).
- [ ] `MAIL_DOMAIN` set (default `fasttempmail.site`; change when you own a domain).
- [ ] `DEMO_MODE` left `true` for testing (`false` for production).
- [ ] (Optional) `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- [ ] (Optional) `RESEND_API_KEY`, `RESEND_FROM`.

## 4. First deploy

- [ ] Build succeeded; service is **Live** (green).
- [ ] Logs show `[db] applied migration 0000_*.sql` (all statements, no errors).
- [ ] Logs show `[db] admin account created for <ADMIN_EMAIL>`.
- [ ] Logs show `[db] default plan settings seeded`.
- [ ] `https://<name>.onrender.com/health` returns `{"ok": true, ...}`.

## 5. App verification

- [ ] Home page shows **Generate Email**; address generates, copies, inbox refreshes, expiry countdown ticks.
- [ ] "Simulate incoming mail" button appears (demo mode) and delivers a labeled demo message.
- [ ] Signed up → demo OTP code shown on screen → verified → wallet shows **$0.00** in top bar.
- [ ] Deposit via Crypto ($3+) → stays **pending** (honest gap, shown in-app).
- [ ] Pricing section shows Free vs Gmail ($2.50/mo) vs Pro ($3/mo) clearly.
- [ ] Signed in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` → Administration shows metrics, plan settings, Google sign-in.
- [ ] No dev bypass / preview buttons exist anywhere.

## 6. Custom domain (later — Hostinger)

- [ ] Render → service → **Settings → Custom Domains** → added your domain; noted the DNS records.
- [ ] Hostinger hPanel → **DNS records** → added exactly Render's records.
- [ ] DNS propagated; Render issued the free HTTPS certificate.
- [ ] (If using Google login) updated `GOOGLE_REDIRECT_URI` and Google Cloud Console's Authorized redirect URIs.

## 7. Google OAuth (optional)

- [ ] Copied the redirect URI from Administration → Google sign-in (`https://<name>.onrender.com/oauth/callback`).
- [ ] Added it **exactly** to Google Cloud Console → OAuth client → Authorized redirect URIs.
- [ ] Pasted Client ID + Secret in the app (or via env vars + redeploy).
- [ ] Badge shows **Live**; test login with a Google account works.

## 8. Resend (optional)

- [ ] Domain verified in Resend; API key created.
- [ ] `RESEND_API_KEY` + `RESEND_FROM` set in Render; redeployed.
- [ ] Test signup receives the OTP email from sender name **Fast Temp Mail**.

## 9. Know the limits

- [ ] Aware the free service **sleeps after 15 min idle** (first load ~30–60 s).
- [ ] Aware of 750 hrs/month and 512 MB RAM limits.
- [ ] Aware the **inbox is simulated** — real inbound mail needs a domain + inbound provider.
- [ ] Aware deposits stay **pending** until manually verified (no crypto provider wired).
- [ ] Aware Gmail/Pro upgrades are **manual** until a payment provider is connected.
- [ ] Bookmarked Supabase dashboard for database backups/monitoring.

## Rollback / recovery

- Render keeps every deploy: **Deploys → ⋯ → Rollback** on the service page.
- Database lives in Supabase independently — redeploys and rollbacks never touch it.
- Lost admin password? Sign-up is open: create a user, then in Supabase SQL editor run
  `UPDATE users SET role='admin' WHERE email='you@example.com';`
