---
id: T-043
title: Job queue, cron endpoints and failure alerts
phase: 2
area: core
status: claimed
owner: agent-t043
claimed_at: 2026-10-13T13:12:14.680Z
branch: task/T-043-job-queue-cron-endpoints-and-failure-ale
depends_on: [T-023, T-025]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/jobs/**, apps/web/src/app/api/cron/**, apps/web/vercel.json]
---

# T-043 — Job queue, cron endpoints and failure alerts

**Phase** 2 · **Area** core · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-023, T-025

## Goal

Reliable background work on Vercel.

## Scope

- DB queue: enqueue (dedupe key), claim with `FOR UPDATE SKIP LOCKED`, time-budgeted worker loop, exponential backoff, max attempts → failed.
- Handler registry (`registerJob(type, handler)`) so feature tasks add handlers in their own folders.
- Cron routes protected by `CRON_SECRET`: `job-worker` (every 2 min) and stubs for scheduler routes owned by other tasks.
- Failure notification hook: email platform admin + tenant owner (Resend), logged and Sentry-captured.

## Acceptance criteria

- [ ] Two concurrent workers never process the same job.
- [ ] A job exceeding the budget is resumed by the next invocation.

## Tests required

- Integration tests for claim concurrency, retry/backoff and dedupe.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/jobs/**`
- `apps/web/src/app/api/cron/**`
- `apps/web/vercel.json`

## References

PLAN §14 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:12:14.680Z claimed by agent-t043
