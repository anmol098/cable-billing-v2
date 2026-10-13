---
id: T-011
title: Environment config, vercel.json and environments runbook
phase: 0
area: infra
status: claimed
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

- [ ] `src/env.ts` validates every variable in `.env.example`.
- [ ] Runbook is enough for a human to complete H-01.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/vercel.json`
- `apps/web/.env.example`
- `apps/web/src/env.ts`
- `docs/runbooks/environments.md`

## References

PLAN §17, E-06, E-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T06:06:13.112Z claimed by agent-t011
