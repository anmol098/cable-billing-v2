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
| `DATABASE_URL` | Docker URL | integration (owner role) | non-prod `staging` branch, pooled, **role `cb_app`** (§4.12) | prod project `main`, pooled, **role `cb_app`** (§4.12) | Neon → Connect (pooled), user and password swapped for `cb_app` |
| `DATABASE_URL_UNPOOLED` | Docker URL | integration (owner role) | **not in Vercel** after §4.12 (owner URL only in the GitHub environment, §4.10) | **not in Vercel** after §4.12 (same) | Neon → Connect (pooling off) |
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
   The owner URLs on staging and production are temporary: after the first migration, §4.12 swaps
   `DATABASE_URL` for the non-owner role `cb_app` and removes `DATABASE_URL_UNPOOLED` from Vercel.
8. Migrations are **not** run by the Vercel build (PLAN §17). Production and staging migrations run from
   a gated GitHub Actions workflow (later task); add `DATABASE_URL_UNPOOLED` to the GitHub environments
   `staging` and `production` (§4.10). Seed data reaches preview branches by inheritance from `staging`
   (§4.13); applying migrations to preview branches is wired up by the DB/CI tasks (T-020, T-010).

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
| `staging` | `DATABASE_URL_UNPOOLED` (non-prod `staging` branch, owner role, direct) | migrations workflow |
| `production` | `DATABASE_URL_UNPOOLED` (prod `main`, owner role, direct) | migrations workflow, backups (T-096) |
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

### 4.12 Runtime database role `cb_app` (staging and production, after the first migration)

**Why.** Every URL Neon gives you logs in as the database **owner** (`neondb_owner`), which owns every
table. Row-level security (RLS) does not bind a table's owner, so with an owner URL, tenant isolation
rests on the app always going through `withTenant` / `withPlatform` (`@cb/db` "shape A"). On staging
and production the app instead logs in as **`cb_app`**: a role that owns nothing, is not a superuser,
has no BYPASSRLS / CREATEROLE / CREATEDB, and can only switch into the two app roles `app_rw` and
`app_platform` ("shape B", `packages/db/README.md` → "Who connects as whom"). Then even a query that
skipped `withTenant` can't read tenant data: it gets `permission denied`. Migrations keep running as
the owner.

| Where | Runtime `DATABASE_URL` (Vercel) | Migrations (`DATABASE_URL_UNPOOLED`) |
|---|---|---|
| Local, CI | owner (Docker / service container) | owner |
| Previews | owner, written by the Neon integration (**shape A**: leave it, nothing to do) | owner (integration) |
| Staging | **`cb_app`**, pooled, non-prod `staging` branch | owner, direct, only in the GitHub environment `staging` |
| Production | **`cb_app`**, pooled, prod `main` branch | owner, direct, only in the GitHub environment `production` |

Do this once per branch: on the prod project's `main`, and on the non-prod project's `staging`.
Roles live inside a Neon branch, so preview branches created from `staging` later contain a copy of
`cb_app` too. Previews still use the owner URL, which is fine (seed data only).

**Before you start:** the first migration (`0000_foundation`) must have run on that branch (it creates
`app_rw` and `app_platform`). Have the owner's **direct** URL ready (Neon → Connect, pooling off, role
`neondb_owner`): the same one the migrations workflow uses.

1. **Generate the password** on your machine and save it straight into the password-manager entry
   "Neon `<project>/<branch>` cb_app":
   ```bash
   openssl rand -hex 32     # 64 hex characters = 256 bits; nothing to URL-encode
   ```
2. **Create the role** with `psql` from your machine. Not in the Neon SQL Editor (it keeps query
   history), and not in Neon Console → Roles (roles made there get extra rights, e.g. membership of
   `neon_superuser`, CREATEDB and CREATEROLE).
   ```bash
   read -rs OWNER_URL && export OWNER_URL     # paste the owner's direct URL (not echoed, not in history)
   HISTFILE=/dev/null psql "$OWNER_URL"
   ```
   ```sql
   CREATE ROLE cb_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
     IN ROLE app_rw, app_platform;
   \password cb_app
   -- paste the password twice; psql sends only a SCRAM hash, so it never reaches server logs
   ```
   - `IN ROLE app_rw, app_platform` makes `cb_app` a member, so `withTenant` / `withPlatform` can
     switch to those roles inside each transaction (`SET LOCAL ROLE`).
   - **NOINHERIT on purpose** (stricter than the `INHERIT` sketch in T-020): `cb_app` has no table
     rights of its own, only after switching. With INHERIT, a raw query would still see zero tenant
     rows, but **every** row of the tables that have an `app_platform` policy (`operators`, `users`,
     `sessions`, `accounts`, …). Both behaviours are tested in `packages/db/src/runtime-role.test.ts`.
   - Grant it nothing else, ever: no table grants, no ownership, no `CREATE`. Tables that later
     migrations create are covered by migration 0000's default privileges (tested), as long as every
     migration runs as the same owner role.
   - If Neon refuses `\password` (it checks password strength on plain text), run
     `ALTER ROLE cb_app PASSWORD '<password>';` in the same session instead (`HISTFILE=/dev/null`
     keeps it out of psql's history file).
   - `ERROR: permission denied to grant role "app_rw"`: you are not connected as the owner role that
     ran migration 0000.
3. **Build the runtime URL**: take the owner's **pooled** URL from Neon → Connect (host contains
   `-pooler`), replace user and password, keep every query parameter:
   ```text
   postgresql://cb_app:<password>@ep-…-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```
4. **Verify before switching**, from a checkout of this repo (`pnpm install` done). It prints the
   report and exits non-zero unless the role is safe:
   ```bash
   read -rs DATABASE_URL && export DATABASE_URL    # paste the cb_app URL from step 3
   pnpm --silent --filter @cb/db exec tsx -e 'import { checkRuntimeRole, createDb } from "@cb/db"; const db = createDb({ connectionString: process.env.DATABASE_URL }); checkRuntimeRole(db).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exitCode = r.ok ? 0 : 1; }, (e) => { console.error(e); process.exitCode = 1; }).finally(() => db.end());'
   unset DATABASE_URL OWNER_URL
   ```
   Expect `"ok": true`, `"sessionUser": "cb_app"`, `"issues": []`. Each `error` issue says what is
   wrong (the owner URL, for comparison, reports `owns_objects`, `createrole`, …). Optional extra
   check: `psql "<cb_app URL>" -c 'SELECT count(*) FROM operators'` must fail with
   `permission denied for table operators`.
5. **Switch Vercel** (Settings → Environment Variables), for that environment only (Production for
   prod `main`; `staging` for the non-prod `staging` branch):
   - `DATABASE_URL` = the `cb_app` URL from step 3 (Sensitive).
   - **Delete** `DATABASE_URL_UNPOOLED` there. The app doesn't read it at runtime; migrations run from
     GitHub Actions with the owner URL kept only in the GitHub environment (§4.10). If a runtime
     feature ever needs a direct connection, give it `cb_app`'s direct URL, never the owner's.
   - Leave Preview and Development alone (owner URLs from the integration, shape A).
   - Redeploy. Re-check both variables after any "Save changes" in the Neon integration settings,
     which can re-sync them.
6. **Confirm** after the deploy: `/api/health` returns `ok`; once apps/web runs `checkRuntimeRole` at
   boot (T-025 / apps/web), the runtime log shows no unsafe-role error; and as the owner,
   `SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1` shows the app's connections as
   `cb_app`.

**Rotating the `cb_app` password (no downtime).** Changing a role's password breaks every running
instance that still uses the old one, so rotate by moving to a second role:

1. Steps 1–4 with a new role name, `cb_app_v2` (next time `cb_app_v3`, …), same
   `CREATE ROLE … NOINHERIT … IN ROLE app_rw, app_platform`.
2. Step 5 with the new URL, then redeploy. Old and new instances work side by side meanwhile.
3. When the old role has no connections left (wait at least an hour; as the owner:
   `SELECT count(*) FROM pg_stat_activity WHERE usename = 'cb_app'`), disable it:
   `ALTER ROLE cb_app NOLOGIN;` (reversible: `ALTER ROLE cb_app LOGIN;`).
4. A day later: `DROP ROLE cb_app;`. It owns nothing and holds no grants, so this just works; if it
   reports dependent objects, stop and find out who granted it something.
5. Vercel deployments keep the variables they were built with: once the old role is disabled, an
   **Instant Rollback** to a deployment from before the switch can't connect. Redeploy that commit
   instead (it picks up the current variables).
6. Record the rotation in the password-manager entry (§7).

If the password may have leaked: do steps 1–2 at once, then `ALTER ROLE <old> NOLOGIN;` and end its
sessions straight away (`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename =
'<old>';`, or restart the compute in Neon), accepting a minute of errors on instances that haven't
picked up the new deployment.

### 4.13 Seed data on staging and preview branches (T-036)

Non-production databases hold **fake data only**, made by the seed generator
(`packages/db/src/seed`). It is deterministic (same `--seed` and `--as-of` → same rows), uses made-up
Hindi and English names and phone numbers in the fictional `555xxxxxxx` range, and builds 12–23 months of
bills, payments, adjustments and reversals through the real billing rules (every account passes
`checkLedger`).

| Scale | Operators / customers / months | Rough size | Time (local Postgres 17) |
|---|---|---|---|
| `small` (default) | 3 / 150 / 12 | 1.5k bills, 1.1k payments | ~1 s |
| `legacy` | 8 / 7,616 / 23 | 148k bills, 108k payments | 30–40 s (busy 4-CPU machine) |
| `10x` | 80 / 76,160 / 23 | ~1.5M bills | not measured; expect ~10× `legacy` |

**Neon previews get `small` automatically, by inheritance.** The Neon ↔ Vercel integration creates every
preview branch as a copy of `staging` (§4.2), so seeding `staging` once gives every later preview the same
`small` data with no per-preview step. After `staging` is migrated (and again whenever it is re-created):

```bash
# DATABASE_URL_UNPOOLED = the staging branch's direct (owner) URL, from Neon → Connect
DATABASE_URL_UNPOOLED='postgres://…' pnpm db:seed --scale small --allow-remote --if-empty
```

- `--allow-remote` is required for any non-local host. `--if-empty` exits 0 without writing when the
  database already has operators, so the same command is safe in an automated step (for example a CI job
  that runs it against a fresh preview branch after its migrations, if a preview branch is ever created
  from an empty parent). Without `--if-empty` a non-empty database is refused (exit 2).
- **Never production:** the seed refuses when `VERCEL_ENV=production` or `CB_SEED_FORBIDDEN=1` (set the
  latter in any production shell or GitHub environment), and it refuses any database that already holds
  operators, so a production URL is refused even with `--allow-remote`. Nothing runs it automatically on
  production builds.
- It writes only through `withTenant` (RLS on), so it also works with the `cb_app` role, but staging and
  previews normally use the owner URL. It never updates or deletes rows (append-only triggers untouched).
- To start over on `staging`, drop and re-create its database (it holds no real data), migrate, seed.
- Sign-in on seeded environments (web: T-026; Android: T-028): `seed-op01-owner`, `seed-op01-staff1`,
  `seed-op01-lineman01` … (`opNN` = operator number), password `seed-dev-password`. Operators 1 and 2 are
  both called "Shiv Cable Network" on purpose (names are not unique, FR-002). `--no-password` creates the
  users without passwords; `CB_SEED_PASSWORD_HASH` sets another (argon2id) hash.

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
- Migrations and seed data: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/cable_billing pnpm
  db:seed --migrate` applies the migrations to that empty database and fills it with the `small` dataset
  (§4.13; the variable must be set in the shell, `.env.local` is not read). `pnpm db:seed --help` lists
  the options.
  Schema details: `packages/db/README.md`.
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

All six routes exist (T-043). Until its owner task lands, a scheduler route is a stub that checks the
secret, logs `cron.not_implemented` and answers **501**. `job-worker` runs every `defineJob(...)` exported
by `@cb/core`; failed jobs email the active platform admins and the tenant's owners (Resend; without
`RESEND_API_KEY`/`EMAIL_FROM` the email is only logged as `email.not_sent_no_provider`).
`invariants` queues the `invariants.check` job (T-052): a breach in any tenant's books fails that job
with `last_error = permanent: invariant_breach` (so the admins get the job-failure email); the tenants and
rows are in the `invariant_checks` table and the `invariants.breach` log lines (ids and counts only).

**Auth:** when `CRON_SECRET` is set in the project, Vercel sends `Authorization: Bearer <CRON_SECRET>` with
every cron call. Each cron route must compare it (constant-time) with `CRON_SECRET` and return 401 when
it is missing or wrong, and must also refuse to run when `CRON_SECRET` itself is unset
(503 `CRON_NOT_CONFIGURED`). `cronRoute(...)` in `apps/web/src/app/api/cron/_lib/cron.ts` does all of this. Long jobs set `export const maxDuration = 300` in the route file
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
| `DATABASE_URL` on staging/production (role `cb_app`) | Switch to a new role (`cb_app_v2`), then disable and drop the old one: §4.12 "Rotating" | No downtime. |
| Owner password (GitHub `DATABASE_URL_UNPOOLED`, preview URLs) | Neon → Roles → reset password. The integration re-syncs the preview variables; update the GitHub environments' `DATABASE_URL_UNPOOLED` by hand | Migrations and open preview connections fail until updated. The staging/production app (`cb_app`) is not affected. |
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
