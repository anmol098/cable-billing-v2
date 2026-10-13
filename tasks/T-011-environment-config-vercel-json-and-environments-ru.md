---
id: T-011
title: Environment config, vercel.json and environments runbook
phase: 0
area: infra
status: done
owner: agent-t011
claimed_at: 2026-10-13T06:06:13.112Z
branch: task/T-011-environment-config-vercel-json-and-envir
depends_on: [T-005]
review: self
claimable_by: agent
size: S
paths: [apps/web/vercel.json, apps/web/.env.example, apps/web/src/env.ts, docs/runbooks/environments.md]
---

# T-011 — Environment config, vercel.json and environments runbook

**Phase** 0 · **Area** infra · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-005

## Goal

Document and encode every environment variable and the Vercel/Neon setup so humans can create the accounts (H-01) and agents can run things locally.

## Scope

- `.env.example` listing all variables with comments (DATABASE_URL pooled + DATABASE_URL_UNPOOLED, BETTER_AUTH_SECRET, RESEND_API_KEY, EMAIL_FROM, TURNSTILE keys, UPSTASH_REDIS_*, SENTRY_DSN, CRON_SECRET, RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET, RAZORPAY_PLAN_ID, APP_BASE_URL, RECEIPT_BASE_URL).
- `vercel.json`: functions region placeholder, crons from PLAN §14 (paths can 404 until their tasks land).
- `docs/runbooks/environments.md`: local setup (Docker Postgres), Neon project + branching + Vercel integration, preview/staging/prod mapping, how to rotate secrets.
- Domain is undecided (D-21): every URL comes from env; no hard-coded hostnames.

## Acceptance criteria

- [x] `src/env.ts` validates every variable in `.env.example`.
- [x] Runbook is enough for a human to complete H-01.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/vercel.json`
- `apps/web/.env.example`
- `apps/web/src/env.ts`
- `docs/runbooks/environments.md`

## References

PLAN §17, E-06, E-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

- `apps/web/.env.example`: every app variable with a comment, grouped by service; `[prod]` marks the ones
  production requires. Local defaults: Docker Postgres URLs, `APP_BASE_URL=http://localhost:3000`, Resend
  sandbox sender, Cloudflare's public Turnstile **test** keys. Vercel system vars are listed as comments.
- `apps/web/src/env.ts`: schema for all of them (format checks: postgres URLs, origin-only base URLs,
  `re_…`, `rzp_(test|live)_…`, `plan_…`, secret minimum lengths, `Name <addr>` sender, https Upstash URL,
  bare-host `VERCEL_URL`; pairs `UPSTASH_REDIS_REST_URL`+`_TOKEN` and `RAZORPAY_KEY_ID`+`_SECRET` must be
  set together) plus presence rules per deployment and helpers (below).
- `apps/web/vercel.json`: `framework: nextjs`, `regions: ["sin1"]`, the six PLAN §14 crons
  (`/api/cron/{billing-scheduler,job-worker,subscription-states,session-close,invariants,receipt-links-cleanup}`;
  cleanup weekly `0 22 * * 0` = Mon 03:30 IST). Paths 404 until their tasks land.
- `docs/runbooks/environments.md`: environment table (local/preview/staging/prod), presence policy,
  variable × environment matrix, H-01 step by step (Vercel Pro project, Neon two projects + integration,
  Sentry, Resend, Upstash, Turnstile, Razorpay test+live incl. plan and webhook, Play Console, backup bucket,
  GitHub environments, acceptance check), local Docker setup, crons + `CRON_SECRET` auth, rotation per
  secret, "adding a variable" checklist.

**Env policy (decision)** — two layers so `next build` works with no env (local, CI):

1. Format: always; any set variable must be valid (`""` = unset). Fails `next build/start/dev`.
2. Presence by target (`deploymentTarget(env)` from `VERCEL_ENV`): local/CI (no `VERCEL_ENV`, or
   `vercel dev`) → nothing required; **preview** (incl. custom env staging) → `REQUIRED_IN_PREVIEW`
   (`DATABASE_URL`, `BETTER_AUTH_SECRET`), checked at server boot in `instrumentation.ts` (not at build:
   the Neon integration's preview vars may not be there yet when the build starts) → 500 + `EnvError` in the
   runtime log, also sent to Sentry; **production** → `REQUIRED_IN_PRODUCTION` (all `[prod]` vars),
   checked when `next.config.ts` loads on a `VERCEL_ENV=production` build (a broken prod deploy never goes
   live) and again at boot. Extra rules: production must use `rzp_live_`, real Turnstile keys, https base
   URLs, an `EMAIL_FROM` not on `resend.dev`; non-production must never use `rzp_live_`.

**Interfaces for later tasks** (`import … from "@/env"`)

- `serverEnv` / `clientEnv` as before (T-005). New: `requireServerEnv("DATABASE_URL", …)` returns the values
  typed non-optional or throws `EnvError` naming every missing one. **Call it where the feature runs**, not
  at module top level. `requireEnv(env, keys)` is the pure version (use with `clientEnv`).
- `baseUrls()` → `{ app, receipt }` origins, no trailing slash: `APP_BASE_URL`, else on previews
  `https://${VERCEL_BRANCH_URL ?? VERCEL_URL}`, else locally `http://localhost:3000`; receipt defaults to
  app. Pure: `resolveBaseUrls(env)`. Use for Better Auth `baseURL` (T-026), email links (T-027), receipt
  links `${receipt}/r/<token>` (T-050), Razorpay callback (T-085). E2E against `next start` on another port
  should set `APP_BASE_URL`.
- `deploymentEnvProblems(env)`, `assertDeploymentEnv(env)`, `deploymentTarget(env)`, `isNextBuildPhase()`,
  `REQUIRED_IN_PREVIEW`, `REQUIRED_IN_PRODUCTION`, `type AppEnv = ServerEnv & ClientEnv`.
- **Adding a variable:** schema (`optional(...)`, comment; client vars also in `clientSource`) →
  `.env.example` (with `[prod]` iff added to `REQUIRED_IN_PRODUCTION`) → `apps/web/turbo.json`
  `build.env` (non-secret, affects output) or `build.passThroughEnv` (secrets / per-deploy) → runbook §3/§4.
  Tests fail on any drift between these.
- **Crons (T-043 etc.):** Vercel sends `Authorization: Bearer <CRON_SECRET>` on production only; routes must
  reject missing/wrong headers and refuse when `CRON_SECRET` is unset (`requireServerEnv("CRON_SECRET")`).
  Set `export const maxDuration = 300` in the route file (no `functions` block in `vercel.json`: Vercel fails
  the build when a `functions` glob matches no file). Add crons as one line each in `vercel.json` + a row in
  runbook §6.
- Rate limiting: `UPSTASH_REDIS_REST_URL`/`_TOKEN` are the names `Redis.fromEnv()` reads.

**Deviations / decisions**

- **Region `sin1`, not Mumbai:** Neon has no Mumbai region (closest is AWS Singapore
  `aws-ap-southeast-1`), and E-06 co-locates functions with the DB, so Vercel `sin1` and Upstash
  `ap-southeast-1`. PLAN §17 allowed this ("else Singapore").
- Two Neon projects (prod / non-prod) so preview branches can never copy real customer data; the runbook
  says to replace the Production DB vars the integration writes. Staging = Vercel custom environment on
  git branch `staging` (fallback: branch-scoped preview vars).
- Variables not in the task's list but needed: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`
  (the "TURNSTILE keys"), `UPSTASH_REDIS_REST_URL`/`_TOKEN`, Vercel system vars `VERCEL_URL`,
  `VERCEL_BRANCH_URL`, and the Sentry build vars (`SENTRY_ORG/PROJECT/AUTH_TOKEN`) moved into the schema.
  No platform-admin alert address was added (T-043 decides where it comes from).
- Shared/other-task files touched (small, needed): `apps/web/next.config.ts` (production presence check;
  Sentry build options read from `serverEnv`), `apps/web/src/instrumentation.ts` (boot-time check after
  `Sentry.init`), `apps/web/turbo.json` (all vars listed for strict env mode), `apps/web/src/env.test.ts`
  (extended), new `apps/web/src/vercel-config.test.ts`.

**Follow-ups (no new task files)**: applying migrations + seed to Neon preview branches (T-020/T-036/T-010);
GitHub `DATABASE_URL_UNPOOLED` per environment for the migration workflow; production Resend domain,
Turnstile hostnames and `APP_BASE_URL` wait for the domain (H-02).

**Verification** (Node v24.21.0, pnpm 12.11.2, no app env set)

- `pnpm lint` clean; `pnpm typecheck` 9/9; `pnpm test` 9/9 (web: 6 files, 54 tests — env schema, bad values →
  `EnvError` naming the key (12 cases), values never echoed, pairs, `.env.example` keys ⊆ schema and schema ⊆
  `.env.example`, `.env.example` parses as a valid local env, `[prod]` markers = `REQUIRED_IN_PRODUCTION`,
  turbo.json lists every var, presence rules per target, `requireEnv`, `resolveBaseUrls`, vercel.json
  region/cron shape/§14 jobs); `TURBO_FORCE=1 pnpm build` 9/9 with no env; `pnpm generate` leaves no diff;
  `pnpm --filter web test:e2e` 5 passed; `node scripts/tasks.mjs check --local` OK.
- Probes: `VERCEL_ENV=production next build` with no env fails listing all 16 missing vars; with a complete
  fake production env it builds. `VERCEL_ENV=preview next build` succeeds; `next start` with
  `VERCEL_ENV=preview` and no vars → `/api/health` 500 with `Environment is not ready for preview:
  DATABASE_URL, BETTER_AUTH_SECRET`; with those two set → 200.

## Board log

- 2026-10-13T06:06:13.112Z claimed by agent-t011
- 2026-10-13T06:21:02.235Z completed on task/T-011-environment-config-vercel-json-and-envir
