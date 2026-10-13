---
id: T-043
title: Job queue, cron endpoints and failure alerts
phase: 2
area: core
status: done
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

- [x] Two concurrent workers never process the same job.
- [x] A job exceeding the budget is resumed by the next invocation.

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

**What exists**

| File | What |
|---|---|
| `packages/core/src/jobs/definition.ts` | `defineJob({ type, scope: "tenant"\|"platform", payload: zod, maxAttempts?, notifyOwner?, run })` → frozen `JobDefinition`; `continueLater({ payload?, delayMs? })`; `PermanentJobError(code)`; `isJobDefinition`, `isJobType`. |
| `registry.ts` | `createJobRegistry(defs?)` → `{ register, registerJob(type, def), get, has, types }` (duplicate type throws); `collectJobDefinitions(moduleExports)`. |
| `queue.ts` | `enqueueJob(tx, def \| type, payload, { operatorId?, dedupeKey?, runAfter?, maxAttempts? })` → `{ jobId, created }`; worker steps `claimJobs`, `completeJob`, `requeueJob`, `failJob`, `failExpiredLeases` (exported for tests and admin tooling). |
| `worker.ts` | `runJobWorker({ db, registry, logger?, clock?, budgetMs = 240 s, yieldReserveMs = 30 s, leaseMs = 300 s, maxJobs = 500, workerId?, requestId?, backoff?, onFailure? })` → `JobWorkerReport { claimed, succeeded, continued, retried, failed, leaseLost, stoppedBy, durationMs }`. |
| `context.ts` | Job (system) context: `TenantJobContext` / `PlatformJobContext`, `buildJobContext` (exported for handler unit tests). |
| `backoff.ts` | `backoffDelayMs(attempt, { baseMs = 30 s, maxMs = 1 h, random })`: exponential with equal jitter (`cap/2 + random·cap/2`). |
| `failure.ts` | `JobFailure`, `JobFailureHook`, `JOB_FAILURE_REASONS` (`max_attempts`, `permanent`, `lease_expired`), `jobErrorSummary(e)` (safe `last_error`). |
| `alerts.ts` | `createJobFailureNotifier({ db, transport, render, logger, capture? })`, `findJobAlertRecipients`; transports `createResendEmailTransport({ apiKey, from, fetch? })` (REST API, `Idempotency-Key`, no SDK), `createRecordingEmailTransport()` (test double), `createLogOnlyEmailTransport(logger)`; `EmailSendError`. |
| `apps/web/src/app/api/cron/_lib/` | `auth.ts` (`checkCronAuthorization`, constant-time), `cron.ts` (`cronRoute(name, run)`, `cronStub(name, ownerTask)`, `cronDb()`, `createCronLogger()` = JSON lines + Sentry breadcrumbs), `alerts.ts` (`renderJobAlert` from the i18n namespace `job_alerts`, `formatAlertTime` in IST). |
| `apps/web/src/app/api/cron/job-worker/route.ts` | The worker cron. Registry = every `defineJob` exported by `@cb/core`; Resend transport when `RESEND_API_KEY` + `EMAIL_FROM` are set, else log-only; Sentry `captureMessage` per failure; `maxDuration = 300`. |
| `…/cron/{billing-scheduler,subscription-states,session-close,invariants,receipt-links-cleanup}/route.ts` | Stubs: authenticated, log `cron.not_implemented`, answer **501** naming the owner task (T-044, T-085, T-062, T-052, T-050). |

**How to add a job (T-044, T-052, T-050, T-085, T-062 …)**

```ts
// packages/core/src/billing/jobs.ts: your own folder, re-exported by `export * from "./billing"`
export const billingRunJob = defineJob({
  type: "billing.run",               // dotted snake_case, unique
  scope: "tenant",                   // tenant: runs in withTenant(jobs.operator_id); platform: cross-tenant
  payload: z.object({ period: z.iso.date(), cursor: z.uuid().optional() }), // ids/periods only, no PII
  maxAttempts: 5,                    // default 5 (stored on the row at enqueue)
  async run({ payload, withTenant, audit, shouldYield, log, now }) {
    for (const batch of batches(payload.cursor)) {
      if (shouldYield()) return continueLater({ payload: { ...payload, cursor: batch.first } });
      await withTenant(async (tx) => {
        /* … */
        await audit(tx, { action: "billing.run_batch", entityType: "billing_run", entityId });
      });
    }
  },
});
// enqueue inside the service's own transaction (atomic with its change):
await enqueueJob(tx, billingRunJob, { period }, { dedupeKey: `billing.run:${period}` });
// platform fan-out (a scheduler cron or a platform job):
await db.withPlatform((tx) => enqueueJob(tx, billingRunJob, { period }, { operatorId, dedupeKey }));
```

- **Nothing to register by hand.** The job-worker route builds its registry with
  `collectJobDefinitions(core)`, so any `defineJob` value exported from `@cb/core` is picked up. Web-only
  handlers: `registry.register(def)` in the route.
- **Enqueue with the definition** (not the type string): it validates the payload (stored as parsed, so
  schemas must be idempotent), enforces the scope and stores the definition's `maxAttempts`. In a tenant
  transaction `operatorId` defaults to that tenant (`app.current_operator()`); another tenant's id, or a
  platform job, is refused by RLS (42501). On the platform path a tenant job needs `operatorId`.
  **Dedupe:** one live (`queued`/`running`) job per (tenant, `dedupeKey`); a duplicate returns
  `{ jobId: <the live job>, created: false }` (tested with 8 concurrent enqueues).
- **Handler outcomes:** return nothing → `succeeded`. `return continueLater({ payload, delayMs })` → back to
  `queued` **without using an attempt**, with an optional new payload (validated), resumed by the next
  invocation. Throw → retry with backoff (30 s, 60 s, 2 min … with jitter) until `max_attempts`, then
  `failed` + alert. `throw new PermanentJobError("snake_code")` → `failed` at once (also used for
  `invalid_payload` and `scope_mismatch`). `jobs.last_error` = `jobErrorSummary(e)`: the error type, the
  SQLSTATE/constraint for DB errors (their messages quote values, so they are dropped), otherwise a
  PII-scrubbed message.
- **Handlers must be idempotent:** a run killed by the function time limit runs again after its lease expires.

**Job (system) context** (answers T-025's open question; lives in `jobs/context.ts`, not `context/`)

- A job has no user, so it doesn't call `defineService` services (they need a `TenantContext` issued by
  `resolveTenantContext`). Handlers work with the transactions their context gives them:
  - **tenant job:** `ctx.operatorId` (from the `jobs` row, never the payload) and `ctx.withTenant(fn, opts)`
    bound to it. No `withPlatform` and no other tenant, so a tenant job can't cross tenants.
  - **platform job:** `ctx.db.withPlatform` / `ctx.db.withTenant(operatorId, …)` (fan-out per tenant).
- `ctx.audit(tx, { action, entityType, entityId?, before?, after? })` writes `audit_events` as the
  **system** (`actor_id` and `actor_role` NULL, `request_id` = the run's id). Platform jobs also pass
  `operatorId` (NULL in a `withPlatform` tx, the tenant's id in that tenant's `withTenant` tx).
- Also: `ctx.job` (`id`, `type`, `operatorId`, `attempt`, `maxAttempts`, `createdAt`), `payload`, `log`
  (job_id, job_type, operator_id, attempt, worker_id, request_id set; PII refused as everywhere), `now`,
  `clock()`, `deadline`, `timeLeftMs()`, `shouldYield()`.
- Read-only mode (D-13): the system actor has no capability list. Jobs that must skip read-only tenants
  (T-044 billing runs) call `readTenantMode(tx)` themselves.

**Worker semantics** (`runJobWorker`)

1. Fails `running` jobs whose lease expired on their last attempt (`last_error = lease_expired…`) and alerts.
2. Loop: stop when fewer than `yieldReserveMs` (30 s) of the budget (240 s) remain, when the queue is empty,
   or after `maxJobs`. Otherwise claim **one** job of a registered type (T-023's claim SQL: `FOR UPDATE SKIP
   LOCKED`; `queued` and due, or `running` with an expired lease and attempts left) with a 300 s lease
   (≥ the route's `maxDuration`), run it, record the outcome. Types without a handler are never claimed
   (they stay queued, e.g. during a deploy).
3. Every outcome update is **lease-guarded** (`status = 'running' AND locked_by AND attempts`): a worker
   whose job was re-claimed after its lease expired gets `leaseLost` and changes nothing.
4. All times come from the injected clock (SQL parameters, not `now()`); production uses `new Date()`.

**Failure alerts** (PLAN §14, Q-11 default). On `failed` the hook logs `job.failure_alert` (ids, type,
reason, safe error) and calls `capture` (route: `Sentry.captureMessage("job.failed", { tags: job_type and
reason, extra: ids })`). Then it emails every **active platform admin** with an email and, for tenant jobs
with `notifyOwner` (default true), the tenant's **active owners** with an email, each in their
`users.language`. Admin email: job type, ids, tries, reason, last error, time (IST). Owner email: plain
words, the time and a reference id, no error text. Words come from the i18n namespace `job_alerts` (en + hi,
Hindi in `_review`). A failed send is logged (`job.alert_send_failed`, user id only) and captured; alerts
never make the worker fail. Resend `Idempotency-Key = job-failed/<job>/<user>`.

**Cron route conventions** (`apps/web/src/app/api/cron/<name>/route.ts`)

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds; never a `functions` block in vercel.json
export const GET = cronRoute("billing_scheduler", async ({ db, log, requestId }) => {
  const created = await db().withPlatform(async (tx) => /* enqueueJob(...) per tenant */ 0);
  return { created };             // → 200 JSON; return a Response for anything else
});
```

- `cronRoute` checks `Authorization: Bearer <CRON_SECRET>` (sha256 of both sides + `timingSafeEqual`):
  **503 `CRON_NOT_CONFIGURED` when the secret is unset** (nothing runs), 401 on a missing or wrong header.
  It logs `cron.started`/`cron.finished`; an exception → `cron.failed` log, `Sentry.captureException`, 500
  without details. The DB client is created lazily (`requireServerEnv("DATABASE_URL")` on first use); nothing
  is read at import.
- The owner task **replaces the stub file** of its route (T-044 billing-scheduler, T-052 invariants, T-085
  subscription-states own those folders). `session-close` and `receipt-links-cleanup` are in no task's
  paths: T-062/T-050 should edit those stub files (T-043 is done, small change, README §7). Scheduler crons
  should only enqueue jobs (fast, idempotent through `dedupeKey`) and let `job-worker` do the work.
- `vercel.json` is unchanged (T-011 already lists the six crons; no `functions` key). A test checks that every
  cron path has a route module with `GET`, `runtime = "nodejs"` and `0 < maxDuration ≤ 300`.

**Decisions**

1. Definitions are values collected from `@cb/core`'s exports, not import-time `registerJob` calls (T-025's
   no-side-effect rule; it also means a handler can't be missing from one bundle only).
2. One job per claim, processed in order: simple fair scheduling; a long job holds only its own lease.
3. Lease 300 s = route `maxDuration`; budget 240 s; reserve 30 s (PLAN §14 "about 240 s").
4. `continueLater` gives the attempt back (it isn't a failure); a lease expiry uses one (the run may have crashed).
5. Alert recipients come from the DB (`users.role = 'platform_admin'`, owners), not a new env variable, so
   the env schema is unchanged. Sending needs `RESEND_API_KEY` + `EMAIL_FROM` (already `[prod]`), else log-only.
6. Stub routes answer 501 (honest in the Vercel cron log) instead of 200.
7. `failExpiredLeases` fails exhausted jobs of any type, registered or not: a job stuck `running` forever
   would otherwise be invisible.

**Deviations / shared files**

- The scope's `registerJob(type, handler)` is `registry.registerJob(type, definition)`; the normal path is
  `defineJob` + export (above).
- Outside the owned paths (small, needed): `packages/core/src/index.ts` (one `export * from "./jobs";`),
  `apps/web/package.json` (+`@cb/core`, `@cb/db`), `apps/web/next.config.ts` (`transpilePackages` +
  `@cb/core`, `@cb/db`, `@cb/domain`), `pnpm-lock.yaml`, the i18n namespace
  `packages/i18n/messages/{en,hi}/job_alerts.json` + regenerated `apps/web/messages/*.json`,
  `docs/runbooks/environments.md` §6 (routes exist now: 501 stubs, 503 without secret, alert emails), and the
  deleted placeholder `apps/web/src/app/api/cron/.gitkeep`.
- apps/web has no shared server runtime yet (T-026 is in flight), so the cron routes create their own lazy
  `createDb` singleton in `_lib/cron.ts`. When T-026 adds a shared runtime/db module, switch `cronDb()` to it.

**Follow-ups / open questions**

- Retention of finished `jobs` rows: `app_platform` has no DELETE policy (T-023); a cleanup needs a reviewed
  policy (e.g. succeeded jobs older than 90 days).
- Admin job monitor (PLAN §12.4, T-086): list `failed` jobs and re-enqueue them (as a new job; failed rows stay).
- Per-type owner wording ("your bill run for October") can be added to `job_alerts` once T-044 lands.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core` jobs tests: 4 files, 31 tests, DB suites ran (no skips).
  - **Claim concurrency:** 8 concurrent claimers over 24 jobs never share a job and every job is claimed
    once; **3 concurrent `runJobWorker`s over 30 jobs: each handler ran exactly once**, all `succeeded`, no
    lease lost.
  - **Budget:** 100 s jobs with a 240 s budget → 3 claimed, `stoppedBy: budget`; the next invocation does the rest.
  - **Resume:** a handler that yields at the budget (`continueLater` with a cursor) is resumed by the next
    invocation from the cursor, with `attempts` unchanged until success. **Lease expiry:** a job whose
    invocation died is not claimed while leased (+120 s) and is resumed after 300 s as attempt 2; an
    exhausted last attempt is failed with `lease_expired` and alerted.
  - **Retry/backoff:** deterministic jitter → `run_after` exactly +750 ms, then +1500 ms; not claimable 1 ms
    early; `failed` at max attempts with one alert; `last_error` scrubbed (no phone number).
    `PermanentJobError`, an invalid payload and a scope mismatch fail at once; a throwing alert hook is logged.
  - **Dedupe:** per tenant, platform jobs among themselves, finished jobs don't block, 8 concurrent enqueues → 1 row.
  - Enqueue scope/payload/RLS refusals; lease-guarded completion (a late worker can't overwrite).
  - Contexts: a tenant job's `withTenant` sees `app.current_operator()` = its tenant and none of the other
    tenant's jobs; system audit row (`actor_id`/`actor_role` NULL); a platform job fans out tenant jobs that
    the same invocation runs. Alerts: admins + the failed tenant's active owners with an email, in their
    language (not staff, not disabled admins, not other tenants' owners); captured event; no `@` in logs;
    one failed send doesn't stop the others. Resend request shape; errors carry the status only.
- **Mutation checks** (reverted): removing `FOR UPDATE SKIP LOCKED` and the lease guard → both concurrency
  tests and the guard test fail; not giving the attempt back on `continueLater` → the resume test fails.
- `apps/web` cron tests (10): bearer check (9 wrong shapes), 503 without secret, 401, 200 JSON, 500 without
  details + Sentry, stub 501, every `vercel.json` cron has a route, alert emails in en/hi.
- Manual run (`next start` on a scratch DB migrated with `db:migrate`, dropped afterwards):
  `/api/cron/job-worker` → 401 without or with a wrong header; 200 report with the secret (an expired
  last-attempt job was failed and logged `job.alert_no_recipients`); `/api/cron/invariants` → 501; without
  `CRON_SECRET` → 503.
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; core 16 files / 308 tests,
  web 8 files / 69 tests), `TURBO_FORCE=1 pnpm build` (9/9) with no `DATABASE_URL`/`CRON_SECRET`,
  `pnpm generate` (no diff), `pnpm --filter web test:e2e` (9 passed), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:12:14.680Z claimed by agent-t043
- 2026-10-13T13:31:48.564Z completed on task/T-043-job-queue-cron-endpoints-and-failure-ale
