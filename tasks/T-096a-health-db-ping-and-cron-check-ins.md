---
id: T-096a
title: Health DB ping and Sentry check-ins for the crons
phase: 5
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-096]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/api/health/**, apps/web/src/lib/health.ts, apps/web/src/lib/health.test.ts, apps/web/src/app/api/cron/_lib/**, docs/runbooks/monitoring/**, docs/runbooks/monitoring.md]
---

# T-096a — Health DB ping and Sentry check-ins for the crons

**Phase** 5 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-096

## Goal

The uptime check notices a dead database, and a cron that silently stops running raises an alert.

## Scope

- `/api/health`: replace T-005's placeholder with a real DB check (`select 1` through `@cb/db`, short
  timeout such as 2 s, no tenant data, nothing in the response but the status) so `db` is `ok`/`error`
  and the route answers 503 when the database is unreachable. Keep it cheap: it is called every minute.
- Cron routes: wrap `cronRoute` with Sentry cron check-ins (`Sentry.withMonitor` or `captureCheckIn`
  with `in_progress` / `ok` / `error`) for `billing_scheduler`, `job_worker`, `invariants`,
  `subscription_states` (and `session_close` once T-062a lands), only when a DSN is set.
- Add matching `cronMonitors` to `docs/runbooks/monitoring/alerts.json` (schedules from
  `apps/web/vercel.json`) and extend `alerts.test.mjs` so every monitored cron's schedule equals
  `vercel.json`'s; update `docs/runbooks/monitoring.md` §1 ("Known gaps") and §6.

## Out of scope

- New alert channels; the Sentry account itself (H-01).

## Acceptance criteria

- [ ] `/api/health` reports `db: error` and 503 when the database is down (tested with an unreachable URL), `ok` and 200 when it is up.
- [ ] Each cron route checks in with Sentry when a DSN is set and does nothing extra without one (tested with a fake).

## Tests required

- Unit tests for the health check (up, down, timeout) and the check-in wrapper; `node --test docs/runbooks/monitoring/alerts.test.mjs`.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/health/**`, `apps/web/src/lib/health.ts` (+ test)
- `apps/web/src/app/api/cron/_lib/**`
- `docs/runbooks/monitoring/**`, `docs/runbooks/monitoring.md`

## References

PLAN §17 (observability), PRD §11, T-096 completion notes, `docs/runbooks/monitoring.md`.

## Completion notes

_The agent fills this in before opening the PR._
