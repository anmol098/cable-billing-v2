---
id: T-096a
title: Health DB ping and Sentry check-ins for the crons
phase: 5
area: web
status: done
owner: agent-t096a
claimed_at: 2026-10-14T20:07:30.560Z
branch: task/T-096a-health-db-ping-and-sentry-check-ins-for
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

- [x] `/api/health` reports `db: error` and 503 when the database is down (tested with an unreachable URL), `ok` and 200 when it is up.
- [x] Each cron route checks in with Sentry when a DSN is set and does nothing extra without one (tested with a fake). (The four crons in scope; `session-close` and `receipt-links-cleanup` are not monitored, see Decisions 6. Not tested against a real Sentry org: H-01.)

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

**What exists**

| Where | What |
|---|---|
| `apps/web/src/lib/health.ts` | `getHealth({ commit, now, pingDb })` (unchanged shape: `status` `ok`/`degraded`, `version`, `commit`, `time`, `checks.db.status` `ok`/`error`/`not_configured`). New: `databasePing(url, { timeoutMs = DB_PING_TIMEOUT_MS = 2000 })` → `() => Promise<CheckStatus>`; `pingDatabase(db)` = `select 1` in a **read-only `withPlatform`** transaction (no table read, so no tenant data; also proves the role switch every request needs works); `withTimeout(promise, ms)`; `closeDatabasePings()` (tests). Its own pool per URL, `max: 2`, created on first call (never at import). Concurrent requests share the in-flight ping; a ping slower than the timeout reports `error` and the next request starts a new one. No URL → `not_configured` (200, as before: only local builds; deployments refuse to boot without `DATABASE_URL`). |
| `apps/web/src/app/api/health/route.ts` | Passes `databasePing(serverEnv.DATABASE_URL)`. 200 when the DB answers, **503 `degraded` + `db: error`** when it refuses, fails or takes > 2 s. The body is statuses only (no error text, host or timing; tested). |
| `apps/web/src/app/api/cron/_lib/monitor.ts` | `CRON_MONITORS` (cronRoute name → slug): `billing_scheduler` → `cron-billing-scheduler`, `job_worker` → `cron-job-worker`, `invariants` → `cron-invariants`, `subscription_states` → `cron-subscription-states`. `CheckInSink` (`capture`, `flush`), `sentryCheckIns` = `Sentry.captureCheckIn` / `Sentry.flush` (the documented cron-monitor API of the installed `@sentry/nextjs` 11.6.0, read from `@sentry/core`'s `monitor.d.ts` / `checkin.d.ts`), `defaultCheckIns()` = Sentry only when `SENTRY_DSN` is set, `startCronMonitor(name, sink, log, clock?)` → `{ monitored, finish(status) }`. |
| `apps/web/src/app/api/cron/_lib/cron.ts` | `cronRoute(name, run, { secret?, checkIns? })`: after the secret check, a monitored cron checks in `in_progress`; when the run ends, `ok` for a 2xx answer and `error` for anything else (exception → 500, a stub's 501), with the `in_progress` id and the duration in seconds, then one flush. Unauthenticated / no-secret calls never check in. Unmonitored crons and no DSN: nothing extra (the old exception flush stays). |
| `docs/runbooks/monitoring/alerts.json` | Four new `cronMonitors` (id = slug, `cron`, `path`, schedule copied from `apps/web/vercel.json`, margin, `maxRuntimeMinutes: 6` (> the routes' 300 s `maxDuration`), `failureIssueThreshold`). `/api/health`'s `why` mentions the 2 s DB ping. |
| `docs/runbooks/monitoring/sentry-alerts.mjs` | `failure_issue_threshold` comes from the monitor (default 1); `--cron-url` prints only workflow monitors (the Vercel crons check in through the SDK). |
| `docs/runbooks/monitoring/alerts.test.mjs` | Backup check limited to `workflow` monitors. New: every Vercel-cron monitor's `path` is in `vercel.json` with the **same schedule**; the monitored set equals `CRON_MONITORS` (same slugs, both directions); its route is `cronRoute("<cron>"` and `maxRuntimeMinutes · 60 > maxDuration`; the job-worker payload (threshold 3). 17 tests. |
| `docs/runbooks/monitoring.md` | §1: four rows for the monitors, `health` row mentions the DB ping; "Known gaps" replaced by what now exists + the remaining gaps; §2 step 6 (the monitors, per-monitor notification check); §5 step 1 (2 s); §6 is now "during hypercare, or while Sentry is not set up"; new §8 "A cron missed a run or reported an error" (error / missed / timeout, what to look at, calling a cron by hand). |

**Severities and thresholds (proposals, like T-096's):** `cron-billing-scheduler` P1 (margin 30 min), `cron-job-worker` P1 (margin 2 min, **3 consecutive** misses/failures ≈ 6 min before an issue, so one blip doesn't page), `cron-invariants` P2 and `cron-subscription-states` P2 (margin 30 min). All `max_runtime` 6 min, `recovery_threshold` 1, timezone UTC (vercel.json schedules are UTC).

**Decisions**

1. **Check-ins carry only the slug** (no `monitor_config` upsert): the monitor definition lives in one place, `alerts.json`, applied by `sentry-alerts.mjs --apply` (which already upserted cron monitors for T-096). Consequence: the monitors must exist before check-ins count, so `--apply` is part of H-01 (monitoring.md §1/§2 say so). The alternative (upsert from code) would put the schedules in a second place and overwrite `--apply`'s settings on every run.
2. A run's monitor status follows the **HTTP answer** (2xx = ok), so a 501 stub or `subscription_states`' 500 after a partial failure is an `error`.
3. Sentry can never change a cron's answer: `captureCheckIn` is synchronous fire-and-forget (wrapped in try/catch), the final flush is capped at `CHECK_IN_FLUSH_MS` (2 s) plus our own 0.5 s race in case a transport ignores it; failures log `cron.check_in_failed` / `cron.check_in_not_flushed` (slug and error type only). If `in_progress` could not be captured, the run closes with a plain heartbeat check-in.
4. When monitored, the one flush after the closing check-in also sends `cronRoute`'s captured exception, so a failed monitored run does not wait for two flushes.
5. Health keeps `not_configured` → 200 (unchanged; only reachable in local builds). The health pool is separate from the cron/auth pools (the route needs no `BETTER_AUTH_SECRET`), and is at most 2 connections per instance.
6. `session-close` (a 501 stub until T-062a) and the weekly `receipt-links-cleanup` are **not** monitored (task scope); adding one = one line in `CRON_MONITORS` + one `alerts.json` entry (the tests enforce both).

**Outside the owned paths (small, owners done)**

- `apps/web/e2e/smoke.spec.ts` (T-005/T-088): the health smoke test now expects `db: ok` (the e2e server runs with the migrated Postgres service), instead of the placeholder's `not_configured`.
- `.github/workflows/web.yml` (T-010): a comment that said `/api/health` reports `not_configured` (comment only).
- `apps/web/src/app/api/cron/_lib/monitor.test.ts` and `monitor.sentry.test.ts` are new files inside `_lib/**`.

**Not done / needs H-01:** nothing was sent to a real Sentry (no account): the check-ins were checked with a fake sink, a mocked SDK, and the **real** `@sentry/nextjs` SDK with its documented `transport` option capturing envelopes (two `check_in` items, same `check_in_id`, `in_progress` then `ok`/`error`, plus the exception event). Monitor creation (`--apply`), per-monitor notification settings and the first green check-ins need H-01. Previews never check in (Vercel runs crons on production only).

**Verification** (Node 24.21.0, pnpm 12.11.2, Postgres 17)

- New tests: `src/lib/health.test.ts` (14: getHealth; the 2 s timeout with fake timers; `select 1` in
  a read-only platform tx; unreachable URL → `error`; a TCP server that accepts and never answers →
  `error` after the timeout, concurrent calls share one ping, the next call starts a new one; a real
  migrated DB → `ok` as the owner **and** as a `cb_app`-shaped login role; the route: 200 + `db: ok`,
  and 503 + `db: error` with exactly the five keys and no host/driver text). `_lib/monitor.test.ts`
  (fake sink + mocked SDK: no DSN → no check-in and no flush; DSN → `Sentry.captureCheckIn`
  `in_progress` then `ok` with its id, `flush(2000)`; `error` on throw and on a 501; nothing on
  401/503 or for an unmonitored cron; a throwing/rejecting Sentry leaves 200/500 unchanged; a flush
  that never settles is abandoned at 2.5 s (fake timers); every `CRON_MONITORS` name is the
  `cronRoute` name of a `vercel.json` cron). `_lib/monitor.sentry.test.ts` (real SDK, `transport`
  hook: the `check_in` envelope items, an error run's event + `error` check-in, and a DSN pointing at
  a closed port still answers 200).
- Mutations (reverted): monitor always `ok` / no DSN gate → 4 web tests fail; timeout resolving
  `ok` / no ping sharing → 2 health tests fail; a changed schedule in `alerts.json` or a slug removed
  from `CRON_MONITORS` → `alerts.test.mjs` fails.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (forced), `TURBO_FORCE=1 pnpm test
  --concurrency=1` with `DATABASE_URL` (10/10; web 66 files; only the existing opt-in skips: the
  MariaDB suite and a bench), `TURBO_FORCE=1 pnpm build` without `DATABASE_URL` (10/10), `pnpm
  generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`,
  `node --test docs/runbooks/monitoring/alerts.test.mjs` (17/17), `sentry-alerts.mjs` dry run.
- `pnpm --filter web test:e2e` on a scratch migrated DB (dropped afterwards): **116 passed**,
  including the health smoke test now expecting `db: ok`.
- By hand: `next start` with `DATABASE_URL` on a closed port → `/api/health` answered `503
  {"status":"degraded",…,"checks":{"db":{"status":"error"}}}` in 43 ms.

## Board log

- 2026-10-14T20:07:30.566Z claimed by agent-t096a
- 2026-10-14T20:35:54.757Z completed on task/T-096a-health-db-ping-and-sentry-check-ins-for
