# Runbook: environments, accounts and secrets

Who this is for: the human doing **H-01** (create the accounts and secrets), and any developer or agent
setting up a machine. Read §1 and §2 first, then follow §4 (H-01) top to bottom.

- Variables, with one comment each: [`apps/web/.env.example`](../../apps/web/.env.example)
- Validation and the rules below, in code: [`apps/web/src/env.ts`](../../apps/web/src/env.ts)
- Vercel settings in git (region, crons): [`apps/web/vercel.json`](../../apps/web/vercel.json)
- Plan context: PLAN §17 (environments), §14 (jobs), E-06 (Vercel), E-07 (Resend, Turnstile, Upstash), D-21 (domain undecided)

Never paste a real secret into git, an issue, a PR, a chat or a screenshot. Secrets live only in Vercel
environment variables, GitHub environment secrets, a password manager, and your own `apps/web/.env.local`
(which git ignores).

---

## 1. The environments

| | Local | Preview | Staging | Production |
|---|---|---|---|---|
| What deploys | `pnpm --filter web dev` on your machine | every push to any branch except `main` (task branches and `feature/mvp`) | Vercel custom environment `staging`, from git branch `staging` | git branch `main` |
| URL | `http://localhost:3000` | `<project>-git-<branch>-<team>.vercel.app` | `staging.<domain>` once the domain exists (H-02); until then the Vercel-assigned URL | primary domain (H-02); until then `<project>.vercel.app` |
| Database | Docker Postgres 17 (or a personal Neon branch) | Neon branch `preview/<git-branch>` in the **non-prod** Neon project, made by the Neon ↔ Vercel integration | Neon branch `staging` in the **non-prod** project | Neon branch `main` in the **prod** Neon project, PITR on |
| Data | seed data (T-036) | seed data, never real customers | seed data or anonymised data | real data |
| Razorpay | test mode (optional) | test mode | test mode | **live** mode |
| Turnstile | Cloudflare test keys | Cloudflare test keys | real widget | real widget |
| Email | none or Resend sandbox | Resend sandbox / test domain | Resend, verified domain | Resend, verified domain |
| Crons | call the route by hand | do not run (Vercel runs crons on production only) | do not run; call by hand when testing | run (`vercel.json`) |
| Android flavour | `dev` → local or preview API | — | `staging` → Play internal track | `prod` → Play closed test → production |

Why two Neon projects: the Neon integration creates preview branches as copies of a parent branch. If
production lived in the same project, every preview would get a copy of real customer data. Keeping
production in its own project means previews can only ever copy seed data.

**Region.** E-06 says functions run next to the database. Neon has no Mumbai region (its closest region to
India is AWS Singapore, `aws-ap-southeast-1`), so everything runs in Singapore: Neon `aws-ap-southeast-1`,
Vercel functions `sin1` (set in `vercel.json` → `regions`), Upstash `ap-southeast-1`. If Neon ever adds
Mumbai and we move the database, change all three together (Vercel `bom1`).

## 2. What each environment must have

The app checks this for you (`apps/web/src/env.ts`):

1. **Format, always.** Any variable that is set must be valid (a URL is a URL, `RAZORPAY_KEY_ID` looks
   like `rzp_…`, secrets are long enough, paired variables are set together). A bad value stops
   `next build`, `next start` and `next dev` with an `EnvError` that names the variable (never the value).
2. **Presence, by environment.**
   - **Local and CI** (no `VERCEL_ENV`): nothing is required. `next build` works with no env at all. A
     feature that needs a variable fails with an `EnvError` when it runs.
   - **Preview and staging** (Vercel reports custom environments as `preview`): `DATABASE_URL` and
     `BETTER_AUTH_SECRET`. Checked when a server instance starts: if one is missing, every request
     returns 500 and the runtime log shows `Environment is not ready for preview` with the list.
   - **Production**: every variable marked `[prod]` in `.env.example`. Checked by **`next build`**, so
     a production deploy with a missing secret fails to build and the previous deployment stays live.
     Production must also use live Razorpay keys (`rzp_live_…`), real (not test) Turnstile keys, `https`
     URLs, and an `EMAIL_FROM` on our own verified domain (not `resend.dev`).
   - Outside production, live Razorpay keys are refused (no real money from a preview).

Staging is checked like a preview, but it should hold the full production list (with test-mode Razorpay)
so that it behaves like production. Use the "Production" column of the table in §3 as its checklist.

## 3. Variable matrix

"Integration" = set automatically by the Neon ↔ Vercel integration. "Same" = same value in every
environment where it is set. Generate random secrets with `openssl rand -base64 32` (or `-hex 32`), one
value per environment, never shared between production and anything else.

| Variable | Local | Preview | Staging | Production | Where it comes from |
|---|---|---|---|---|---|
| `DATABASE_URL` | Docker URL | integration | non-prod `staging` branch, pooled | prod project `main`, pooled | Neon → Connect (pooled) |
| `DATABASE_URL_UNPOOLED` | Docker URL | integration | non-prod `staging`, direct | prod `main`, direct | Neon → Connect (pooling off) |
| `BETTER_AUTH_SECRET` | optional | **required** | **required** | **required** | `openssl rand -base64 32` |
| `APP_BASE_URL` | `http://localhost:3000` | leave unset (branch URL is used) | staging URL | **required**, https | your domain / Vercel URL |
| `RECEIPT_BASE_URL` | unset | unset | optional | optional (defaults to `APP_BASE_URL`) | a short domain later, if any |
| `RESEND_API_KEY` | optional | optional (non-prod key) | non-prod key | **required** (prod key) | Resend → API Keys |
| `EMAIL_FROM` | sandbox sender | sandbox or test domain | verified domain | **required**, verified domain | Resend → Domains |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | test key | test key | staging widget | **required**, prod widget | Cloudflare → Turnstile |
| `TURNSTILE_SECRET_KEY` | test key | test key | staging widget | **required**, prod widget | Cloudflare → Turnstile |
| `UPSTASH_REDIS_REST_URL` | unset (in-memory) | non-prod DB | non-prod DB | **required**, prod DB | Upstash → database → REST |
| `UPSTASH_REDIS_REST_TOKEN` | unset | non-prod DB | non-prod DB | **required**, prod DB | same |
| `CRON_SECRET` | optional | optional | own value | **required** | `openssl rand -hex 32` |
| `RAZORPAY_KEY_ID` | optional, `rzp_test_` | `rzp_test_` | `rzp_test_` | **required**, `rzp_live_` | Razorpay → API Keys |
| `RAZORPAY_KEY_SECRET` | with key id | test | test | **required**, live | same |
| `RAZORPAY_WEBHOOK_SECRET` | optional | test | test | **required**, live | you choose it (`openssl rand -hex 32`) and type it into Razorpay |
| `RAZORPAY_PLAN_ID` | optional | test plan | test plan | **required**, live plan | Razorpay → Subscriptions → Plans |
| `SENTRY_DSN` | unset | non-prod or same project | same project | **required** | Sentry → project → Client Keys |
| `NEXT_PUBLIC_SENTRY_DSN` | unset | same as `SENTRY_DSN` | same | **required** | same |
| `SENTRY_ENVIRONMENT` | unset | unset | `staging` | unset | — (defaults to `VERCEL_ENV`) |
| `SENTRY_ORG`, `SENTRY_PROJECT` | unset | same | same | same | Sentry org and project slugs |
| `SENTRY_AUTH_TOKEN` | unset | same | same | same | Sentry → Settings → Auth Tokens (org token) |
| `ENABLE_EXPERIMENTAL_COREPACK` | — | `1` | `1` | `1` | Vercel build setting, see §4.1 (not read by the app) |

Vercel sets `VERCEL_ENV`, `NEXT_PUBLIC_VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL` and
`VERCEL_GIT_COMMIT_SHA` itself (enable "Automatically expose System Environment Variables", on by default).

Mark every secret as **Sensitive** in Vercel (Settings → Environment Variables → Sensitive): it can then
no longer be read back in the dashboard, only replaced.

---

## 4. H-01: create the accounts (step by step)

Do the steps in this order; each one lists the variables it produces. Keep a password-manager entry per
service with the login, 2FA recovery codes, and which environments each key went to. Turn on 2FA for every
account. Use a shared company email (not a personal one) as the owner where you can.

### 4.1 Vercel (Pro team + project)

1. Create a Vercel account and a **team** on the **Pro** plan (E-06: commercial use needs Pro, and the
   `*/2` job-worker cron needs it).
2. Connect GitHub and **import** `anmol098/cable-billing-v2`.
3. Project settings:
   - **Root Directory:** `apps/web`. Keep "Include files outside the root directory" **on** (the app
     imports `packages/*`).
   - **Framework Preset:** Next.js (also set in `vercel.json`). Leave the install and build commands at
     their defaults: Vercel installs the whole pnpm workspace and runs `next build`.
   - **Node.js Version:** 24.x.
   - **Production Branch** (Settings → Environments → Production): `main`.
   - Add the env var `ENABLE_EXPERIMENTAL_COREPACK=1` (all environments) so Vercel uses the exact pnpm
     version from the root `package.json` (`packageManager`).
   - **Function region** comes from `vercel.json` (`sin1`); nothing to set in the dashboard.
   - **Fluid compute:** on (default for new projects).
   - **Deployment Protection:** Vercel Authentication on for previews (so preview URLs are not public).
     Create a **Protection Bypass for Automation** secret for later CI Playwright runs against previews
     (T-010/T-088); store it as the GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`.
4. **Staging** (can wait until Phase 3, it is not needed for the H-01 check): Settings → Environments →
   **Create Environment** `staging`, tracking git branch `staging`. If the plan does not offer custom
   environments, use the Preview environment with variables scoped to the git branch `staging` and a
   branch domain instead.
5. Do **not** add the domain yet (D-21). When H-02 decides it: add it in Vercel → Domains, set
   `APP_BASE_URL` (and Resend, Turnstile, Razorpay webhook URLs) to it, redeploy.
6. Generate and add per environment: `BETTER_AUTH_SECRET` (Preview, Production, staging; different
   values), `CRON_SECRET` (Production, staging).

### 4.2 Neon (Postgres) + branching + Vercel integration

1. Sign up at neon.com (use the same company email). Pick a paid plan for production (PITR retention, no
   autosuspend for production, PLAN §17 backups).
2. Create project **`cable-billing-prod`**: region **AWS Asia Pacific (Singapore)** `aws-ap-southeast-1`,
   Postgres **17**. Its default branch `main` is production. Turn on the longest PITR / history retention
   the plan allows. Set compute autosuspend off (or the longest delay) for `main`.
3. Create project **`cable-billing-nonprod`**: same region, Postgres 17. Rename its default branch to
   `staging` if you like; it holds **seed data only** and is the parent of every preview branch.
4. Connection strings: Neon → project → **Connect**. With "Connection pooling" on you get the pooled URL
   (host contains `-pooler`) = `DATABASE_URL`; with it off, the direct URL = `DATABASE_URL_UNPOOLED`.
   Both must keep `?sslmode=require`.
5. **Vercel integration** (previews): Neon Console → `cable-billing-nonprod` → **Integrations → Vercel →
   Add → Install from Vercel Marketplace → Link Existing Neon Account**. Choose the Vercel project, the
   `cable-billing-nonprod` project, the database and role. Turn on **automatic deletion of obsolete
   branches**. Each preview deployment then gets a branch `preview/<git-branch>` and its own
   `DATABASE_URL` / `DATABASE_URL_UNPOOLED`.
6. The integration also writes **Production** and **Development** values pointing at the non-prod
   project. Replace them: in Vercel → Settings → Environment Variables, edit the Production-scoped
   `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the `cable-billing-prod` URLs (step 4). Re-check this
   after any "Save changes" in the integration settings or a password rotation, because the integration
   re-syncs its variables then.
7. Staging: set `DATABASE_URL` / `DATABASE_URL_UNPOOLED` on the `staging` environment to the non-prod
   `staging` branch.
8. Migrations are **not** run by the Vercel build (PLAN §17). Production and staging migrations run from
   a gated GitHub Actions workflow (later task); add `DATABASE_URL_UNPOOLED` to the GitHub environments
   `staging` and `production` (§4.10). Applying migrations and seed data to preview branches is wired up by
   the DB/CI tasks (T-020, T-036, T-010).

### 4.3 Sentry (errors, E-08)

1. Create an organisation at sentry.io (pick the **EU or US** data region once; it cannot change later).
   We send no customer personal data (see `apps/web/src/lib/sentry.ts`).
2. Create project **`cable-billing-web`** (platform: Next.js) and **`cable-billing-android`** (Android).
3. `cable-billing-web` → Settings → **Client Keys (DSN)** → copy the DSN into `SENTRY_DSN` and
   `NEXT_PUBLIC_SENTRY_DSN` (Production, Preview, staging). Sentry separates them by environment name.
4. Settings → **Auth Tokens** → create an **organisation token** → `SENTRY_AUTH_TOKEN`. Also set
   `SENTRY_ORG` (org slug) and `SENTRY_PROJECT=cable-billing-web`. Source maps upload only when the token
   is set.
5. Android DSN goes to the Android release secrets (T-071/T-073), not to Vercel.

### 4.4 Resend (email, E-07)

1. Sign up at resend.com.
2. Until the domain exists (H-02), you can only send from the sandbox `onboarding@resend.dev`, and only to
   the address you signed up with. That is enough for local and preview testing.
3. After H-02: **Domains → Add Domain** (use a subdomain such as `mail.<domain>`), region closest to India,
   add the DNS records it shows (SPF, DKIM, and a DMARC record), wait for "Verified".
4. **API Keys → Create**: one key `cable-billing-prod` (permission: sending access, limited to the domain)
   → Production `RESEND_API_KEY`; one `cable-billing-nonprod` → Preview/staging.
5. `EMAIL_FROM`: `Cable Billing <noreply@<your-verified-domain>>` in production. Production refuses the
   `resend.dev` sandbox sender.

### 4.5 Upstash Redis (rate limits, E-07)

1. Sign up at upstash.com (or Vercel → Marketplace → Upstash; either is fine, but the variable names must
   be `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. If the Marketplace creates `KV_REST_API_*`
   names, add ours by hand with the same values).
2. Create database **`cable-billing-prod`**, region **AWS ap-southeast-1 (Singapore)**, TLS on, eviction
   off. Copy **REST URL** and the **REST token** (not the read-only token) into the Production variables.
3. Create **`cable-billing-nonprod`** the same way for Preview and staging.

### 4.6 Cloudflare Turnstile (sign-up bot protection, E-07)

1. Sign up at cloudflare.com (no domain on Cloudflare needed). **Turnstile → Add widget**.
2. Widget **`cable-billing-prod`**: mode Managed, hostname = the production host (`<project>.vercel.app`
   until H-02, then the domain). Copy the **Site key** → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the
   **Secret key** → `TURNSTILE_SECRET_KEY` (Production).
3. Widget **`cable-billing-staging`** with the staging host, for the staging environment.
4. Previews and local use Cloudflare's public test keys (always pass), already in `.env.example`:
   site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`. Production refuses
   them.
5. The site key is inlined at build time: after changing it, redeploy.

### 4.7 Razorpay (our SaaS fee, D-12, D-22; test and live)

1. Sign up at razorpay.com with the business details. **Start live-mode activation (KYC) early**: it needs
   the business documents and can take days. Test mode works immediately. Tax invoices need the GSTIN
   (H-10).
2. Ask Razorpay support to enable **Subscriptions** (and UPI Autopay) on the account if it is not on.
3. In **Test mode**:
   - Account & Settings → **API Keys → Generate** → `RAZORPAY_KEY_ID` (`rzp_test_…`) and
     `RAZORPAY_KEY_SECRET` for Preview and staging (the secret is shown once).
   - Subscriptions → **Plans → Create plan**: monthly, every 1 month, amount **₹472** (₹400 + 18% GST,
     D-22), name "Cable Billing monthly". Copy `plan_…` → `RAZORPAY_PLAN_ID`.
   - Account & Settings → **Webhooks → Add**: URL `<staging APP_BASE_URL>/api/webhooks/razorpay`, secret =
     a value from `openssl rand -hex 32` → `RAZORPAY_WEBHOOK_SECRET`; events `subscription.activated`,
     `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
     `payment.failed` (PLAN §13). Previews have changing URLs, so webhooks go to staging only.
4. In **Live mode** (after activation), repeat: live keys (`rzp_live_…`), a live plan (new `plan_…` id),
   a live webhook to `<production APP_BASE_URL>/api/webhooks/razorpay` with its own secret. These four go
   to Production only.

### 4.8 Google Play Console (Android, D-19)

1. Create a developer account at play.google.com/console (one-time fee, identity verification). Prefer an
   **organisation** account (needs a D-U-N-S number): at the time of writing, new **personal** accounts
   must run a closed test with at least 12 testers for 14 days before they can publish to production.
   Check the current rule when you sign up.
2. Do not create the app until H-02 fixes the `applicationId` (currently `com.cablebilling.lineman`): it
   can never change once uploaded.
3. Later (T-073): create a service account in Google Cloud with access to the Play Console app, and an
   upload keystore. Their secrets go into the GitHub environment `production` (names set by T-073).
4. Privacy policy URL (needed by Play) comes from the marketing/legal pages (T-087).

### 4.9 Backup bucket (PLAN §17)

Create an object-storage bucket for the nightly encrypted `pg_dump` (for example S3 `ap-southeast-1`
or Cloudflare R2), with a 30-day lifecycle rule, versioning on, no public access, and an access key that
can only write to that bucket. The workflow and its secret names are defined by T-096; store the keys in
the GitHub environment `production`.

### 4.10 GitHub environments and secrets

In GitHub → repo → Settings → **Environments**, create `staging` and `production` (production: required
reviewer = the product owner). Secrets:

| Environment | Secret | Used by |
|---|---|---|
| `staging` | `DATABASE_URL_UNPOOLED` (non-prod `staging` branch) | migrations workflow |
| `production` | `DATABASE_URL_UNPOOLED` (prod `main`) | migrations workflow, backups (T-096) |
| repository | `VERCEL_AUTOMATION_BYPASS_SECRET` | Playwright against previews (T-010/T-088) |
| `production` | backup bucket keys, Play service account, keystore | T-096, T-073 (names set there) |

CI itself needs no app secrets: `pnpm build` passes with an empty environment, and integration tests use
the Postgres service container (T-010).

### 4.11 Check (H-01 acceptance)

1. Push any commit to `feature/mvp` (or redeploy its latest preview).
2. Vercel → Deployments → the preview for `feature/mvp` is **Ready**.
3. Neon → `cable-billing-nonprod` → Branches shows `preview/feature/mvp`.
4. Open `<preview URL>/api/health` (signed in to Vercel, because of Deployment Protection): it returns
   `"status":"ok"`. If it returns 500, open the deployment's runtime logs: an `EnvError` lists exactly
   which variable is missing.
5. Production (later, when `main` first deploys): the build log fails with
   `Environment is not ready for production` and a list if anything is missing; fix and redeploy.

---

## 5. Local setup

Prerequisites: Node 24 (`.nvmrc`), pnpm via Corepack (`corepack enable pnpm`), Docker.

```bash
# 1. Postgres 17 in Docker (data kept in a named volume)
docker run -d --name cb-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cable_billing \
  -p 5432:5432 -v cb-postgres-data:/var/lib/postgresql/data postgres:17

# 2. Env file (git-ignored). The defaults point at the container above.
cp apps/web/.env.example apps/web/.env.local
#    Optional: BETTER_AUTH_SECRET=$(openssl rand -base64 32), and any keys you are testing.

# 3. Install and run
pnpm install
pnpm --filter web dev        # http://localhost:3000, /api/health
```

- Next.js reads `apps/web/.env.local` itself (Next's own `.env*` loading; `.env.example` is never loaded).
- Stop / start the database: `docker stop cb-postgres` / `docker start cb-postgres`. Reset it:
  `docker rm -f cb-postgres && docker volume rm cb-postgres-data`, then step 1 again.
- Migrations and seed data: see `packages/db/README.md` (T-020) and the seed task (T-036) once they land.
- Instead of Docker you can use a personal Neon branch: Neon → `cable-billing-nonprod` → **Branches → New
  branch** from `staging`, and put its URLs in `.env.local`. Never point a local machine at production.
- `vercel env pull apps/web/.env.local` (Vercel CLI) copies the **Development** variables; check they do
  not point at production before using them.
- Crons locally: call the route yourself, e.g.
  `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/job-worker`.

---

## 6. Crons (PLAN §14)

Defined in `apps/web/vercel.json`. Schedules are **UTC**. Vercel runs them on **production deployments
only**, calls the path with `GET`, does not retry failures, may (rarely) skip or duplicate a run, so every
job must be idempotent and catch up on the next run.

| Path | UTC | IST | Owner task |
|---|---|---|---|
| `/api/cron/billing-scheduler` | `45 18 * * *` | 00:15 daily | T-044 |
| `/api/cron/job-worker` | `*/2 * * * *` | every 2 min | T-043 |
| `/api/cron/subscription-states` | `30 0 * * *` | 06:00 daily | T-085 |
| `/api/cron/session-close` | `0 19 * * *` | 00:30 daily | collections (T-062) |
| `/api/cron/invariants` | `0 21 * * *` | 02:30 daily | T-052 |
| `/api/cron/receipt-links-cleanup` | `0 22 * * 0` | Mon 03:30 weekly | receipts (T-050) |

Paths that do not exist yet just return 404 until their task lands; Vercel still calls them.

**Auth:** when `CRON_SECRET` is set in the project, Vercel sends `Authorization: Bearer <CRON_SECRET>` with
every cron call. Each cron route must compare it (constant-time) with `CRON_SECRET` and return 401 when
it is missing or wrong, and must also refuse to run when `CRON_SECRET` itself is unset
(`requireServerEnv("CRON_SECRET")`). Long jobs set `export const maxDuration = 300` in the route file
(the job-worker budget is about 240 s). Adding a cron: append one line to `crons` in `vercel.json` (shared
file, see `tasks/README.md` §6) and a row here.

---

## 7. Rotating secrets

General rules:

- Vercel only applies changed variables to **new** deployments: after changing a value, **redeploy**
  (Deployments → latest → Redeploy) every environment that uses it.
- Rotate one secret at a time, in a quiet hour (after 23:00 IST, not on the 1st of the month when billing
  runs, not during the 00:15 IST billing scheduler).
- Rotate immediately if a secret may have leaked (pasted somewhere, a laptop lost, someone left the
  team), and at least yearly otherwise.
- Write each rotation (date, secret, environments, who) in the password-manager entry.

| Secret | How | Effect |
|---|---|---|
| `BETTER_AUTH_SECRET` | New value in Vercel → redeploy | All web users must sign in again. Check the effect on Android tokens with the T-026/T-028 notes before rotating in production. |
| `CRON_SECRET` | New value → redeploy | Vercel sends the new value from the next run; nothing else to change. |
| `DATABASE_URL*` (DB password) | Neon → Roles → reset password. The integration re-syncs preview/integration variables; update production (and staging, GitHub `DATABASE_URL_UNPOOLED`) by hand → redeploy | Old connections fail at once: do it in a quiet hour; expect a minute of errors. |
| `RESEND_API_KEY` | Create a new key → update Vercel → redeploy → delete the old key | No downtime. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash → database → reset credentials → update Vercel → redeploy | The old token stops at once; rate limiting fails until the redeploy finishes. |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → widget → Rotate secret key (keep the overlap period if offered) → update Vercel → redeploy | Sign-ups may fail briefly without an overlap. The site key does not change. |
| `RAZORPAY_KEY_ID` / `_SECRET` | Razorpay → API Keys → Regenerate → update both in Vercel → redeploy | Regenerating disables the old key: checkout and reconciliation fail until the redeploy. |
| `RAZORPAY_WEBHOOK_SECRET` | Generate a new value; change it in Razorpay → Webhooks and in Vercel together → redeploy | Webhooks in between fail signature checks; Razorpay retries them, and the daily reconciliation catches anything missed. |
| `SENTRY_AUTH_TOKEN` | Create a new org token → update Vercel → revoke the old one | Only source-map uploads are affected. |
| `SENTRY_DSN` | Sentry → Client Keys → new key → update both DSN variables → redeploy → disable the old key | DSNs are not secret but can be abused for spam; rotate if that happens. |
| Play / keystore / backup keys | See T-073 / T-096 runbooks | — |

---

## 8. Adding a new variable (for developers and agents)

1. Add it to `serverSchema` (or `clientSchema` + the literal `clientSource` object for `NEXT_PUBLIC_*`) in
   `apps/web/src/env.ts`, wrapped in `optional(...)`, with a one-line comment.
2. Add it to `apps/web/.env.example` with a comment (a test fails if the two drift). Mark it `[prod]` and
   add it to `REQUIRED_IN_PRODUCTION` only if production cannot work without it (another test checks the
   markers match the list). Add it to `REQUIRED_IN_PREVIEW` only if every preview needs it.
3. Add it to `apps/web/turbo.json` → `build.env` (affects the build output, not a secret) or
   `build.passThroughEnv` (secrets and per-deployment values). A test fails otherwise.
4. Read it with `requireServerEnv("NAME")` where the feature runs, never at module top level, so builds
   and other routes keep working without it.
5. Add a row to §3 and, if a human must create it, a step in §4.
