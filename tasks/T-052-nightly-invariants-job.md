---
id: T-052
title: Nightly invariants job
phase: 2
area: core
status: done
owner: agent-t052
claimed_at: 2026-10-13T14:46:56.987Z
branch: task/T-052-nightly-invariants-job
depends_on: [T-043, T-044, T-046]
review: self
claimable_by: agent
size: S
paths: [packages/core/src/invariants/**, apps/web/src/app/api/cron/invariants/**]
---

# T-052 — Nightly invariants job

**Phase** 2 · **Area** core · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-043, T-044, T-046

## Goal

Detect any accounting drift the same night.

## Scope

- Per tenant: Σ ledger = customer_balances, allocations ≤ sources, no overlapping assignments, invoice uniqueness; store results; alert on breach.

## Acceptance criteria

- [x] Injected corruption in a test DB is reported.

## Tests required

- Integration test with deliberately broken data.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/invariants/**`
- `apps/web/src/app/api/cron/invariants/**`

## References

PLAN §14, PLAN §8.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/invariants/` (exported from `@cb/core` by one appended line `export * from "./invariants";`) | `checkTenantInvariants(tx, operatorId, { sampleLimit?, statementTimeoutMs? })` → `TenantInvariantReport { operatorId, violationCount, counts, samples }`; codes `INVARIANT_CODES` / `LEDGER_INVARIANT_CODES`, `InvariantViolation`; the platform job `invariantsCheckJob` (`invariants.check`), `createInvariantsCheckJob(settings)` (tests), `enqueueInvariantsCheck(db)` (dedupe key `invariants.check`), error codes `INVARIANT_BREACH_ERROR` (`invariant_breach`) and `INVARIANT_CHECK_INCOMPLETE_ERROR` (`invariant_check_incomplete`). |
| `packages/db/src/schema/invariants.ts` + migrations `0008_invariant_checks` (generated) and `0009_invariant_checks_append_only` (custom, `appendOnlyTriggerSql` output) | Table `invariant_checks`: one row per tenant and run (UNIQUE `(operator_id, run_id)`, `run_id` = the job id), `checked_at`, `status ok\|breach` (CHECK: `ok` iff `violation_count = 0`), `counts` jsonb (code → count), `samples` jsonb (≤ 20 rows per code: code, entity type/id, customer id, paise amounts and ids only), `duration_ms`. Tenant table with the standard tenant policy and **no** `app_platform` policy; append-only (UPDATE/DELETE/TRUNCATE → CB001 for every role). |
| `apps/web/src/app/api/cron/invariants/route.ts` | T-043's stub replaced: `cronRoute("invariants", …)` enqueues the job (CRON_SECRET bearer auth, 503 without a secret, 401 on a wrong header). The `job-worker` cron runs it (picked up automatically from `@cb/core`'s exports). |

**What is checked** (per tenant, in one read-only set-based SQL statement, so one snapshot: a payment or bill committing meanwhile can't cause a false alarm)

- PLAN §8.4 invariants with T-041 `checkLedger`'s codes and exact definitions: `ALLOCATIONS_EXCEED_PAYMENT` (1), `CREDIT_MISMATCH` (2: stored credit = Σ unallocated remainders of non-reversed payments + credit adjustments), `LEDGER_MISMATCH` (3: Σ ledger = Σ invoice charges − Σ payments − Σ credit adj + Σ reversed payments), `NEGATIVE_OUTSTANDING` (4: Σ allocations of an invoice ≤ its charges), plus `ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT`, `NEGATIVE_SOURCE_ALLOCATIONS`, `REVERSED_PAYMENT_STILL_ALLOCATED`, `NEGATIVE_ALLOCATION_WITHOUT_REVERSAL`, `OUTSTANDING_EXCEEDS_CHARGES`, and PLAN §14's `BALANCE_MISMATCH` (Σ ledger = `customer_balances.balance_paise`).
- PLAN §14's tenant-level rules: `OVERLAPPING_ASSIGNMENTS` (same VC, inclusive date ranges, NULL end = open: the same semantics as the `vc_assignments_no_overlap` EXCLUDE) and `DUPLICATE_REGULAR_INVOICE` (more than one `regular` invoice per customer and period, void ones included, as the RULE-05 index).
- Not computed in SQL: `checkLedger`'s `UNKNOWN_INVOICE`, `UNKNOWN_SOURCE`, `DUPLICATE_ID`, `INVALID_AMOUNT` (composite FKs, PKs, bigint and `> 0` CHECKs make them impossible).
- Cost: each tenant table is scanned once through its `operator_id` index; no per-customer round trips. On T-036's `legacy` seed (8 tenants, 7,616 customers, ~260k ledger rows, ~150k allocations) each tenant took 70–190 ms and the whole job 1.2 s, with zero violations (no false positives on realistic data).

**Job flow and alerting** (`invariants.check`, platform scope, `maxAttempts` 3): list operators by id in `withPlatform` (200 per page) → per tenant: `withTenant(op, check, { accessMode: "read only" })` → store the row in a second `withTenant` transaction (`ON CONFLICT DO NOTHING` on `(operator_id, run_id)`, so a lease-expiry re-run doesn't store a tenant twice) → on a breach `log.error("invariants.breach", { operator_id, run_id, violation_count, counts })`. `shouldYield()` is checked before each tenant → `continueLater` with the cursor and running totals in the payload. A tenant whose check throws is logged (`invariants.tenant_check_failed`, error type/SQLSTATE only) and counted; the other tenants still run. At the end: any breach → `PermanentJobError("invariant_breach")`; otherwise any failed tenant → `PermanentJobError("invariant_check_incomplete")`; otherwise `invariants.finished` (info). The failed job goes through T-043's existing alert path: `jobs.last_error = "permanent: invariant_breach"`, a Sentry `job.failed` event, and an email to every active platform admin (tenant owners are not emailed for a platform job). Nothing is ever written to financial tables.

**Decisions (reviewer please check)**

1. **Alert = permanent job failure.** Reuses T-043's notifier (email + Sentry) instead of a second alert channel; the failed job row is also what the admin console (T-086) will list. Trade-off: on a night with a breach the job reads "failed" although the check itself worked; the `invariants.finished` log line has `outcome: breach | incomplete | ok`.
2. **SQL, not a per-customer `checkLedger` loop** (set-based, as instructed). `checkLedger` stays the specification: the tests compare, customer by customer, the SQL's ledger codes with `checkLedger(readLedgerState(...))`, for healthy books and after every injected corruption.
3. **Results table** `invariant_checks` is tenant-scoped (not platform-only): it is written from the tenant's own transaction, so no new `app_platform` policy was needed. Append-only: a result is evidence of the books' state at that time. One row per tenant per run, `ok` rows included (it shows when each tenant was last checked).
4. **Statement settings** (transaction-local): `statement_timeout` 60 s per tenant; `jit = off` (Postgres 17 JIT-compiled this plan for ~2 s on a 1,000-customer tenant whose execution takes ~0.1 s).
5. Every operator is checked, including suspended and read-only ones (their books must hold too).
6. Samples hold ids and paise amounts only; logs and alerts hold ids and counts only.

**Deviations / shared files**

- Outside the owned paths: `packages/db/src/schema/invariants.ts` (+ its test), `packages/db/src/schema/index.ts` (one appended export line), migrations `0008`/`0009` + `meta/` (shared, §6), `packages/core/src/index.ts` (one appended export line), `docs/runbooks/environments.md` §6 (three lines on what an invariants alert means).
- The new table (the coordinator allowed it: "if a results table is needed, add a Drizzle migration").

**Follow-ups / open questions**

- **T-086 (admin console):** a cross-tenant "books health" view needs a reviewed `app_platform` SELECT policy on `invariant_checks` (or reads per tenant). Re-running a check on demand = `enqueueInvariantsCheck`.
- **T-096 (monitoring/runbooks):** a runbook for "invariant breach": find the tenant in `invariant_checks` (latest `breach` row), read `samples`, correct only through reversals/adjustments (append-only rules).
- Possible extra checks not in PLAN §14 (left out on purpose): a regular invoice's `charges_paise` = Σ its lines (test seeders and migrated invoices may have no lines), `customer_balances.oldest_due_period` consistency, exactly one ledger entry per document.
- Retention: `invariant_checks` grows by one row per tenant per night (append-only, no cleanup); fine for years, revisit with a reviewed policy if needed.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; DB suites really ran)

- `packages/core/src/invariants/invariants.test.ts` (12): healthy books built through the real services (`postPayment`, `reversePayment`, T-044/T-046 seeders: partial payment, advance + credit application, reversed payment, credit adjustment, a VC reused the day after a disconnection) report nothing and write nothing (row snapshot); **9 injected corruptions**, each reported with exact counts and the right entity id and amounts: drifted balance, drifted credit, an unexplained ledger entry, a payment's ledger entry deleted with triggers off, an over-allocated payment, a credit adjustment over-allocated beyond its bill, a reversed payment still paying a bill, a reversal row cancelling more than was paid (trigger bypassed), a negative allocation no reversal explains (trigger + FK bypassed); after each, the SQL agrees with `checkLedger` for all 5 customers and a clean tenant next door reports 0. **Isolation:** two tenants corrupted differently each report only their own customer, and a check for tenant B run inside A's transaction sees nothing. Exact counts with capped samples (limits 2 and 0).
- `constraints.test.ts` (2): with `vc_assignments_no_overlap` and `invoices_one_regular_per_period` dropped in that file's own throwaway DB, 3 overlapping pairs (inclusive ends, open-ended) are reported and touching ranges are not; a duplicate regular invoice is reported, an opening-balance invoice in the same period is not.
- `job.test.ts` (4, real worker, injected clocks): enqueue dedupe; a clean night → `succeeded`, one `ok` row per tenant, no alert; a breach → `ok`/`breach` rows with samples, one `invariants.breach` log line (error level, ids + counts), job `failed` with `permanent: invariant_breach`, **alert email to the platform admin only** (not the tenants' owners), Sentry capture, ledger and balances unchanged; yield/resume over 3 invocations (2 pauses, each tenant stored once, totals carried); a tenant check error → `invariant_check_incomplete` alert with `notifyOwner: false`.
- `packages/db/src/schema/invariants.test.ts` (4): RLS (another tenant and the platform see nothing; a cross-tenant insert → 42501), append-only for the app role and the owner (UPDATE/DELETE/TRUNCATE → CB001), UNIQUE per run, CHECKs, the migration = `appendOnlyTriggerSql` output.
- `apps/web/src/app/api/cron/invariants/route.test.ts` (5): runtime/maxDuration, 503 without `CRON_SECRET`, 401 for 5 wrong headers (nothing queued), 200 `{ jobId, created }` with the secret, 500 without details + Sentry when queueing fails.
- Mutation checks (reverted): counting reversed payments in the credit remainder → 10 tests fail; disabling the balance and overlap checks → 7 fail; not failing the job on a breach → 2 job tests fail.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; core 34 files / 471 tests, db 29 / 250, web 13 / 96), `TURBO_FORCE=1 pnpm build` (9/9) without `DATABASE_URL`/`CRON_SECRET`, `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `pnpm --filter @cb/db db:check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T14:46:56.988Z claimed by agent-t052
- 2026-10-13T15:11:00.275Z completed on task/T-052-nightly-invariants-job
