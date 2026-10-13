---
id: T-044
title: Billing run service (preview, run, retry, catch-up)
phase: 2
area: core
status: done
owner: agent-t044
claimed_at: 2026-10-13T13:37:57.794Z
branch: task/T-044-billing-run-service-preview-run-retry-ca
depends_on: [T-040, T-041, T-043, T-023]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/billing/**, apps/web/src/app/api/cron/billing-scheduler/**]
---

# T-044 — Billing run service (preview, run, retry, catch-up)

**Phase** 2 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-040, T-041, T-043, T-023

## Goal

Monthly bills are generated exactly once per customer per month.

## Scope

- `previewBillingRun(period)` (read-only, totals + problems), `startBillingRun(period, trigger)`, batch job handler (200 customers/tx), `retryFailedItems(runId)`.
- Invoice numbering via counters (`INV-YYMM-NNNNN`), invoice + lines + ledger + customer_balances update + credit application in one tx per customer.
- Scheduler cron: on IST day 1 enqueue runs for billable tenants; other days catch up missing runs for the current period; read_only tenants recorded as skipped.
- `missedRuns(operator)` lists skipped periods for manual run after reactivation (never automatic, D-25).

## Acceptance criteria

- [x] Running the same period twice concurrently creates no duplicates (PRD §15 #4).
- [x] Opening balance of period N+1 = closing balance of N (FR-012).

## Tests required

- Integration tests with seeded scenarios; concurrency test; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/billing/**`
- `apps/web/src/app/api/cron/billing-scheduler/**`

## References

PLAN §8.2, PLAN §14, FR-009, FR-011, FR-012, J-03, B-006, D-13, D-25 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/core/src/billing/**`, exported from `@cb/core` through one line
`export * from "./billing";`; the cron route `apps/web/src/app/api/cron/billing-scheduler/route.ts`)

| Export | What |
|---|---|
| `previewBillingRun` | Service `billing.preview`, capability `billing.preview` (Owner, Staff; read, READ ONLY tx; works in read-only mode). Input `{ period: "YYYY-MM-01" }` → `BillingPreview { period, tenantMode, run: BillingRunView \| null, customerCount, willBillCount, totalChargesPaise, alreadyBilledCount, nothingToBillCount, problems: { customerId, reason, details }[] }`. Same candidates, same loaders and T-040 `buildInvoice` as the run; opening balance from `customer_balances`. Writes and locks nothing. |
| `startBillingRun` | Service `billing.start_run`, capability `billing.run` (Owner; TENANT_READ_ONLY in read-only mode). Input `{ period }` → `{ outcome: "started" \| "already_running", run: BillingRunView }`. Creates the period's run (`trigger = 'manual'`, `actor_id`) or restarts a finished / skipped one (same row); queues the `billing.run` job. This is the D-25 "run a missed run" path. |
| `retryFailedItems` | Service `billing.retry_failed`, capability `billing.run`. Input `{ runId }` → `{ outcome: "started" \| "already_running" \| "nothing_to_retry", run, failedCount }`. Re-runs **only** the run's `failed` items (job mode `retry`). NOT_FOUND for another tenant's run; CONFLICT `details.reason = "run_skipped"` for a skipped run (start it instead). |
| `missedRuns` | Service `billing.missed_runs`, capability `billing.preview`. Input `{}` → `MissedRun[] { runId, period, skipReason, skippedAt }` (status `skipped`, oldest first). Never billed automatically (D-25); a run leaves the list once the Owner starts it. |
| `billingRunJob` | `defineJob({ type: "billing.run", scope: "tenant" })`, payload `BillingRunJobPayload { runId, period, mode: "run" \| "retry", cursor? }`. Picked up by the job-worker route automatically (`collectJobDefinitions(core)`). |
| `scheduleBillingRuns({ db, now, log, requestId? })` | → `BillingScheduleReport { period, billingDay, tenants, outcomes, errors }`; throws `BillingScheduleError` (with the report) after the pass if any tenant failed. Called by the `billing-scheduler` cron. |
| also | `formatInvoiceNumber(prefix, period, seq)`, `BILLING_BATCH_SIZE` (200), input schemas (`BillingPeriodInput`, `PreviewBillingRunInput`, `StartBillingRunInput`, `RetryFailedItemsInput`, `MissedRunsInput`), types `BillingRunView`, `BillingItemResult`, `BillingProblem`, `BillingScheduleOptions/Outcome/Report`. All names are billing-specific (no `export *` collisions with jobs/payments/auth). |

Internal: `customer.ts` (`billCustomerInTx` / `billCustomer`: one customer in one transaction), `inputs.ts`
(row → T-040 mapping), `runs.ts` (run/item rows, candidate list, period rule), `job.ts`, `scheduler.ts`,
`test-support.ts`.

**Per customer, one READ COMMITTED transaction** (PLAN §8.2 inner loop, §8.5):
lock `customer_balances` (T-046's `lockCustomerBalance`) → item of this run already billed → done → regular
invoice for (customer, P) exists → item `already_exists` → books check (Σ ledger = `balance_paise`, Σ unallocated
credit sources = `credit_paise`, else item `failed` `balance_mismatch` / `credit_mismatch`) → T-040 `buildInvoice`
with opening = the locked balance (`err` → `failed` with `details.reason`; `nothing_to_bill` → `skipped`) →
`nextCounter(invoice)` (taken late) → invoice `{prefix}-{YYMM of P}-{seq:05}` → `adjustments.invoice_id` set, then
lines → ledger `invoice` (+charges) → T-041 `applyCredit` (payment remainders by `posted_at`, credit-adjustment
remainders by `created_at`; rows `kind = 'credit_application'` with `outstanding_after_paise`) →
`customer_balances` (balance += charges, credit −= applied, `oldest_due_period`) → item `created`.
- 23505 on `invoices_one_regular_per_period` (a writer that skipped the lock) → the transaction rolls back (number
  included) and `already_exists` is recorded in a fresh one. Deadlock / serialisation / connection errors are
  re-thrown (the job retries with backoff and resumes from its cursor). Anything else → item `failed`
  `internal_error` with `{ errorType, sqlstate, constraint }` (no messages).
- Items: `INSERT … ON CONFLICT DO UPDATE … WHERE outcome IN ('skipped','failed')` (attempts + 1); billed items are
  never touched (T-023 trigger). Run counts/total are **recomputed from the items** at each slice end.

**Job** (`billing.run`): slice start (one tx, run row locked): not pending/running → stop (stale job); tenant
read-only → run `skipped` / `tenant_read_only` + system audit (D-13); `pending → running`. Then up to 200
candidates after the cursor (ids ascending), one transaction each, `shouldYield()` checked before each →
`continueLater({ cursor })`; a full slice → `continueLater`; a short slice → `completed` or
`completed_with_errors` + audit `billing.run_completed`. Candidates (`run`): customers with an assignment
overlapping the 1st of P, or a pending debit adjustment not later than P, or a failed item in the run, minus
customers already billed in the run. `retry`: failed items only.

**One live job per run, without dedupe keys**: every enqueue happens in the transaction holding the run row lock;
an in-progress run (pending/running) is only re-queued when no `billing.run` job for it is queued/running (lost
job recovery); a finished run is re-queued unconditionally (its handler already did its last write). Running twice
at once is still safe (per-customer lock + item check + RULE-05), tested.

**Scheduler** (`billing-scheduler` cron, 00:15 IST): current IST period P; tenants with `operators.status =
'active'` created before P began (IST). Per tenant, one `withTenant` tx: read-only → insert the run as `skipped`
(if none) + audit `billing.run_skipped`; else no run → create (`cron` on the 1st, `catch_up` otherwise) + job +
audit `billing.run_scheduled`; pending/running without a live job → re-queue; `failed` → pending + job;
completed / completed_with_errors / skipped → nothing (D-25). Idempotent. One tenant's error is logged and counted;
the route then answers 500 (Sentry) after finishing the others.

**For later tasks**
- **T-047 (Bills UI):** preview → `previewBillingRun.call(rt, ctx, { period })` ("N customers will get a bill,
  total ₹X, K problems"; `tenantMode === "read_only"` → billing paused banner). Run → `startBillingRun`; the run
  then progresses in the background: poll `billing_runs` (status, counts, `total_charges_paise`) and list
  `billing_run_items` (outcome/reason/details) for the exception queue. "Retry problems" →
  `retryFailedItems({ runId })`. "Missed bill runs" → `missedRuns({})`, each with Preview + Run (startBillingRun).
  Item reasons to translate: `nothing_to_bill`, `balance_mismatch`, `credit_mismatch`, `internal_error` and T-040's
  validation reasons (`invalid_transition`, `event_before_start`, …). `details.midMonthStartAssignmentIds` = VCs
  charged by their mid-month-start adjustment instead of a rent line. Period errors: VALIDATION with
  `details.reason` `period_in_future` / `period_before_tenant`.
- **T-045 (adjustments / D-18 hook):** create adjustments **under the customer's balance row lock**
  (`lockCustomerBalance`), so the run sees a consistent set. The run never adds a rent line for an assignment that
  has a `mid_month_start` adjustment for that period (pending or invoiced), so the hook may charge a start on the
  1st without risk of a second charge; conversely the hook should keep using T-042's `already_charged` (it reads
  the run's rent line). Debit adjustments must not get a ledger entry at creation (they reach the ledger through
  the invoice's charges: invariant 3, T-041 Q-A default); credit adjustments do (−amount) and become credit, applied
  at the next invoice.
- **T-052 (invariants):** `readLedgerState` mapping as in `payments/test-support.ts`; the run itself refuses
  customers whose balance/credit read model has drifted (`balance_mismatch` / `credit_mismatch` items).
- **T-083 (dashboard):** last run = `billing_runs` by period; missed runs = `missedRuns`.

**Decisions (reviewer please check)**
1. **One transaction per customer** (the coordinator's instruction), not "each batch one transaction" (PLAN §8.2):
   a failing customer can't roll back 199 others, and the tenant's invoice counter lock is held only briefly. A job
   slice handles up to 200 customers.
2. **Opening balance = the locked `customer_balances.balance_paise`**, after checking it equals Σ `ledger_entries`;
   customers with drifted books are not billed (failed item) rather than billed on a wrong opening.
3. **Invoice YYMM = the billed period** (a missed August run billed in October is `INV-2608-…`); the counter stays
   continuous across months (PLAN §7.3). Prefix from `operators.settings.invoice_prefix`.
4. **Double-charge guard** (T-040 Q-4 / T-042 Q-2): an assignment with a `mid_month_start` adjustment for P gets no
   rent line in P; the adjustment is its charge.
5. **Automatic runs only for tenants that existed before P began**; manual runs/previews allowed from the tenant's
   creation month up to the current month, or any older month that already has a run row. Future periods refused.
6. **Scheduler state machine** as tabled above; a `skipped` run is never resumed automatically (D-25), even on
   catch-up days after reactivation. A run that finds the tenant read-only when its job starts is also recorded as
   skipped. Platform-suspended operators are ignored.
7. **Retry keeps the run's trigger** (the actor is in the audit event); a manual (re)start sets `trigger = manual`
   and `actor_id`. Retrying a skipped run is CONFLICT `run_skipped`.
8. **Audit**: run-level only (`billing.run_started`, `billing.run_requeued`, `billing.run_retry_started` by the
   Owner; `billing.run_scheduled`, `billing.run_skipped`, `billing.run_completed` by the system). Invoices are their
   own append-only record; no per-invoice audit event (10k rows per run).
9. **Status `failed`** is never set by the run itself (problems are per item); the scheduler re-queues a run if
   something else marks it failed.
10. Credit application order: payment `posted_at` (T-041 Q-C recommendation), credit adjustment `created_at`.

**Assumptions about open questions** (documented defaults followed)
- T-040 Q-1 (reactivation on the 1st is not active): as T-040 implements. Q-2 (later-period adjustments stay
  pending on a late run): as T-040 implements. Q-3 (₹0 invoices): created (`₹0` rent line). Q-4: decision 4.
- T-042 Q-3 (late run uses the rental in force): `rentalForPeriod` = the rental at the end of P, tested with a run
  on 20 Nov after a 10 Nov plan change.
- T-041 Q-A (debit adjustments reach the ledger only through invoices), Q-B (credit applied at the next invoice),
  Q-C (`posted_at`): defaults.

**Open questions**
- Decision 5 (automatic runs only for tenants created before the period) — confirm, especially for migrated tenants
  (T-093 should import the cutover month's invoices as `regular` so a run reports `already_exists`).
- Should Owner be able to run periods older than the tenant's creation month with no run row (e.g. a migrated
  tenant's gap months)? Today: refused (`period_before_tenant`).
- Pre-existing flaky test (not T-044): `packages/core/src/auth/units.test.ts` "uses Vercel's request id only"
  asserts a random UUID doesn't contain "bad" (hex can: ~1% failure). Failed once in a full run here, passed on
  re-run. Worth a one-line fix in T-026's area.

**Deviations / shared files**
- `packages/core/src/index.ts`: one line `export * from "./billing";`.
- `apps/web/src/app/api/cron/billing-scheduler/route.ts`: the T-043 stub replaced (owned path).
- Imports T-046's internal `payments/ledger-io.ts` (balance lock, invoice outstanding, balance write) and
  `payments/test-support.ts` in tests (no copies). No dependency, schema, migration or i18n changes.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17, after rebasing on `feature/mvp` 79cdeb6)
- `@cb/core` billing: 6 test files, 27 tests, DB suites really ran.
  - `billing-run.test.ts` (13): consolidated multi-VC invoice + line order, suspended → skipped, disconnected /
    future starts not candidates, start on the 1st billed, numbers `INV-2611-00001…` gap-free, balances,
    `oldest_due_period`, audit; **re-running the period twice** bills only the new customer (counter +2 only);
    pending debit adjustments → lines with `invoice_id` set, later-period one stays pending, credit adjustment
    applied as credit; mid-month-start guard (and December bills both VCs); late run uses the end-of-period rental;
    ₹0 invoice; prefix setting; **FR-012** (opening of Dec = closing after Nov + payments, both arrears and advance,
    credit applied to Dec); failed items (`balance_mismatch`, `event_before_start`) → `completed_with_errors` →
    `retryFailedItems` touches only failed items (billed item byte-identical), Staff FORBIDDEN, NOT_FOUND,
    `already_running`, `nothing_to_retry`; read-only at job time → skipped → `missedRuns` (Owner, Staff) →
    TENANT_READ_ONLY → reactivate → CONFLICT on retry → started on the same row → billed; period rules; preview =
    run (counts, total, problems), preview writes nothing.
  - `concurrency.test.ts` (5, dedicated 22-connection pool): **3 jobs on one run in 3 parallel workers bill 12
    customers exactly once** (gap-free numbers, one ledger entry each); 6 parallel `billCustomer` on one customer →
    one invoice; 6 concurrent Owner starts + 2 scheduler passes → one run, one job; payments racing the run → every
    ledger consistent; **RULE-05 backstop**: an uncommitted lock-less invoice wins, the run's insert waits on it
    (observed via `pg_stat_activity`), gets 23505 and records `already_exists` with nothing else written.
  - `scheduler.test.ts` (2): 1st of month (cron run + job; read-only and no-subscription tenants skipped;
    newcomer and suspended operators ignored; idempotent second pass; system audit); catch-up day (missing →
    `catch_up`, lost pending → re-queued, failed → re-queued, completed and skipped untouched, idempotent).
  - `slices.test.ts` (2): 205 customers → one full slice + continue + finish; a ticking clock makes the handler
    yield mid-slice and resume from its cursor over several worker invocations; every customer billed once.
  - `billing-unit.test.ts` (3); isolation cases for all four services pass, coverage test passes.
  - After every run the customers' rows are read into T-041 `LedgerState` and `checkLedger` returns `[]`.
- Mutation checks (reverted): disabling the mid-month guard → its test fails; removing both the item check and the
  existing-invoice check → the "many callers" test fails (the RULE-05 backstop still prevents duplicates);
  breaking the RULE-05 constraint match → the backstop test fails.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; core 29 files /
  414 tests on the second run, see the flaky note), `TURBO_FORCE=1 pnpm build` (9/9) with no `DATABASE_URL` /
  `CRON_SECRET`, `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:37:57.794Z claimed by agent-t044
- 2026-10-13T14:02:26.955Z completed on task/T-044-billing-run-service-preview-run-retry-ca
