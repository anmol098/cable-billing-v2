---
id: T-086a
title: Record payment sync attempts and duplicates for the PRD §16 metrics
phase: 4
area: core
status: done
owner: agent-t086a
claimed_at: 2026-10-14T21:32:13.218Z
branch: task/T-086a-record-payment-sync-attempts-and-duplica
depends_on: [T-086]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/admin/metrics.ts, packages/core/src/sync-metrics/**]
---

# T-086a — Record payment sync attempts and duplicates for the PRD §16 metrics

**Phase** 4 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-086

## Goal

The admin console shows the two PRD §16 field metrics it says are "not measured yet": payment sync
success rate and duplicate prevention count.

## Scope

- Count, per tenant and IST day, mobile payment batch attempts, payments accepted, idempotent
  replays (`duplicate`) and refusals by code, where T-061's `/payments:batch` handler and T-046's
  posting service already know them (a small counters table, append-only or upsert-by-day; no PII,
  no amounts).
- A reviewed `app_platform` column grant for it (see `PLATFORM_READ_COLUMNS` in
  `packages/db/src/schema/platform-admin.ts`) and the two numbers in `platformMetrics`.
- Migration exception count once T-092 stores its exception rows (or leave "not measured").

## Out of scope

- Per-payment logs or anything with amounts, names or phone numbers.

## Acceptance criteria

- [x] `/admin` shows a sync success rate (accepted ÷ attempts, deduplicated by payment id) and a
      duplicate count for the last 30 days instead of "Not measured yet".

## Tests required

- Integration test: a batch with new, replayed and refused payments moves the counters exactly once
  per payment id; the platform reads only the counters.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/admin/metrics.ts`
- `packages/core/src/sync-metrics/**`

## References

PRD §16, PLAN §10.4, T-086 completion notes.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/db/src/schema/sync-metrics.ts` (+ migrations `0019_payment_sync_metrics`, `0020_payment_sync_metrics_grants`) | `payment_sync_batches`: one append-only row per answered `/payments:batch` (tenant, IST `business_date`, `received_at`, `items` and the count of every answer kind: `posted`, `posted_needs_review`, `duplicate`, `rejected_{validation,customer_not_found,id_reused,without_id}`, `retry_later_{conflict,internal,rate_limited}`, plus the dedupe counts `rejected_new_ids` and `accepted_after_rejection`). CHECKs: counts ≥ 0, they add up to `items` (1–50), the dedupe counts stay inside them. `payment_sync_rejections`: append-only dedupe key, one row per rejected payment id per tenant (`(operator_id, id)` PK, first code and time); tenant-only, no platform access. `PAYMENT_SYNC_REJECT_CODES`, `PAYMENT_SYNC_RETRY_CODES`, `PAYMENT_SYNC_BATCH_MAX`. |
| `packages/db/src/schema/platform-admin.ts` | `PLATFORM_READ_COLUMNS.payment_sync_batches` = `operator_id`, `business_date` and the count columns (not `id`, not `received_at`); `payment_sync_batches_platform_select` (`USING (true)`); `platformReadGrantsSql(tables?)` can now emit one table's grant for a later migration. |
| `packages/core/src/sync-metrics/` (`record.ts`, `index.ts`; one line in `packages/core/src/index.ts`) | Service **`recordPaymentSyncBatch`** (`sync_metrics.record_payment_batch`, capability `payments.record`, allowed in read-only mode, `audit.skip("no_change")`). Input `{ items: [{ outcome, id, code? }] }` (1–50; `posted` / `posted_needs_review` / `duplicate` need the payment id; `rejected` / `retry_later` take a code and an optional id, the nil UUID meaning none). Output `{ batchId, businessDate, counts }`. Isolation cases in `sync-metrics.isolation.ts`. |
| `packages/core/src/admin/metrics.ts` | `platformMetrics().paymentSync`: `batches`, `items`, `attempts`, `accepted`, `acceptedNeedsReview`, `rejected`, `successRate` (percent, one decimal, null with nothing), `duplicatesPrevented`, `rejectedAnswersByCode`, `rejectedWithoutId`, `retryLaterByCode`, over the last 30 IST days (`business_date >= today − 30`, same window as the reconciliation figure). `notMeasured` is now `["migration_exceptions"]` (until T-092). |
| `apps/web/src/app/api/mobile/v1/payments/_lib/batch.ts` (T-061) | After the last item, `recordSyncMetrics` maps each answer (`syncMetricItem`: outcome, error code, id) and calls the service once, in its own transaction. Best effort: an error or a non-ok result is logged (`mobile_api.payment_sync_metrics_failed`, code only) and sent to Sentry; the answer to the phone never changes. Whole-request failures (auth, version gate, a body that isn't a batch) are not counted: no payment was looked at. |
| `apps/web/src/app/admin/page.tsx` | Field work section: "Phone payments saved (of N sent)" = the rate, "Double payments stopped" = the duplicate count, and a new "Phone payments to send again" = retry-later answers. The health section's migration figure still reads "Not measured yet". |

**How the numbers are counted (reviewer please check)**

- *Duplicate prevention count* = every answer `duplicate` (PRD §16 "idempotent retries detected"): a replayed batch of 3 saved payments adds 3, 10 concurrent copies of one batch add 9 per payment.
- *Sync success rate* = accepted ids ÷ attempts, **deduplicated by payment id**: accepted ids = `posted + posted_needs_review` (T-046 posts an id once per tenant, so each accepted id is counted once); attempts = accepted ids + rejected ids answered for the first time (`rejected_new_ids`) − accepted ids that had been rejected earlier (`accepted_after_rejection`), i.e. distinct payment ids with a final answer.
  - A rejected id is new only if it is not in `payment_sync_rejections` (insert `ON CONFLICT DO NOTHING`, so concurrent replays count it once) and not a saved payment. `ID_REUSED_WITH_DIFFERENT_DATA` of a saved payment is therefore not a new attempt (by payment id it is the accepted one); it still shows in `rejectedAnswersByCode`.
  - `retry_later` answers are not in the rate (nothing was decided; the phone sends the id again and its final answer counts). They are shown on their own, by code.
  - Items without a usable id (`rejected_without_id`) can't be deduplicated, so they are not in the rate; shown in `rejectedWithoutId`.
- Accepted and duplicate ids must be payments of the calling tenant or the service answers NOT_FOUND and writes nothing, so the counts can't claim payments that don't exist (and another tenant's id is just unknown, RLS).

**Decisions**

- An append-only row per batch rather than an upsert-by-day counter: no row lock shared by every lineman of a tenant, no lost updates, nothing ever updated; the console sums ≤ a few thousand small rows per day.
- `payment_sync_rejections` is a per-payment-id key (id, first code, time; no amount, customer, name or phone). It is needed to keep a refusal from counting again when a phone resends a batch whose answer it lost (the T-061 "timeout then retry" case). It is tenant-only and never read by the platform. If the reviewer reads "per-payment logs" in Out of scope as excluding even this, the alternative is to drop it and accept double-counted refusals on replays.
- Recording happens after the batch in a separate transaction (not inside each `postPayment` transaction): no change to T-046's posting code, and a metrics failure can't fail a payment. Cost: a crash between the last item and the recording loses that batch's counts (logged).
- Capability `payments.record` with `audit.skip("no_change")`: the service changes no business record and auditing every batch would flood the Owner's log. Registered in T-035's `NEVER_THE_DEFAULT_ACTION` (`packages/core/src/audit-query/actions.test.ts`).
- The day is the server's IST day when it answered (not the phone's `recorded_at`).

**Deviations / files outside the owned paths**

- DB: new `packages/db/src/schema/sync-metrics.ts` (+ `sync-metrics.test.ts`), one export line in `schema/index.ts`, migrations 0019/0020 + snapshot/journal, `platform-admin.ts` (one `PLATFORM_READ_COLUMNS` entry, one policy, `platformReadGrantsSql(tables?)`), `packages/db/README.md` (platform-access table row).
- T-086c (merged as #88): `packages/db/src/testing/harness.test.ts` gets the `payment_sync_batches` reason in `PLATFORM_READ_COLUMN_REASONS` and the allow-list count goes 20 → 21.
- T-061 (done): `payments/_lib/batch.ts` (the recording call) and `batch.test.ts` (3 new tests).
- T-086 (done): `apps/web/src/app/admin/page.tsx`, `packages/core/src/admin/admin.test.ts` (`notMeasured` is now only `migration_exceptions`), `apps/web/e2e/admin.spec.ts` (the field section no longer says "Not measured yet"), `packages/i18n/messages/{en,hi}/admin.json` (`overview.field.sync_success` reworded with the count, new `overview.field.sync_retry`; Hindi in `_review`), regenerated `apps/web/messages/*.json`.
- T-035 (done): one `NEVER_THE_DEFAULT_ACTION` entry.

**Open questions (product owner)**

- Should a `retry_later` that never reaches a final answer (e.g. a phone that is lost) count as a failed attempt? Today it doesn't, since the server can't tell "will come again" from "never".
- Is counting `ID_REUSED_WITH_DIFFERENT_DATA` outside the rate right (by payment id it is an accepted payment), or should a second payment on a reused id count as a failed attempt?

**Verification**

Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 1d7c3ee (after T-086c). DB suites really ran.

- `@cb/db` `schema/sync-metrics.test.ts` (6): tenant scoping; the platform role sums the counts but `SELECT *`, `id`, `received_at` and inserts → 42501; another tenant's insert refused; CHECKs (sum = items, 1–50, ≥ 0, dedupe counts within); rejections: one key per id per tenant, same id in two tenants, no platform rows, known codes only; both tables append-only (UPDATE/DELETE/TRUNCATE as the owner, UPDATE as `app_rw`); migration 0020 holds the exact trigger and grant SQL. `platform-admin.test.ts` (catalog == `PLATFORM_READ_COLUMNS`, now incl. the new table) and T-086c's `harness.test.ts` security audit (allow-list of 21) pass.
- `@cb/core` `sync-metrics/sync-metrics.test.ts` (5, real `postPayment`): batch → replay (lost answer) → `ID_REUSED` → refused-then-accepted, totals exact (accepted 4, duplicates 2, new refused ids 2, accepted after refusal 1, 5 distinct ids); the same id twice in one batch and **6 concurrent replays** of one refused id → one new id; accepted/duplicate ids of another tenant or unknown → NOT_FOUND, nothing written; refused ids per tenant; read-only tenant (D-13); validation; `platformMetrics` deltas (3 batches, 13 items, 4 attempts, 3 accepted, 1 rejected, 6 duplicates, by code; a batch 31 days old is outside the window), no payment/customer/tenant id in the output, `notMeasured` = `["migration_exceptions"]`. Isolation suite: 2 new `not_found` cases pass; coverage and the T-035 audit registry tests pass.
- `@cb/web` `payments/_lib/batch.test.ts` (+3, through the real handler, read back **as `app_platform`**): a batch with 2 new, a CUSTOMER_NOT_FOUND, a VALIDATION and an id-less item, replayed twice, then a new one, a replay and an id reuse → `batches 4, items 18, accepted 3, duplicate 5, rejected_new_ids 2, rejected_without_id 3, id_reused 1`; 2 rejection keys; other tenant untouched; platform can't `SELECT *`/ids/times or see rejections. A `retry_later` then posted id counts once. A failing metrics transaction leaves the answer and the payment as they were and logs `mobile_api.payment_sync_metrics_failed`.
- Playwright (`next start`, fresh scratch DB `cb_e2e_t086a`, `E2E_PORT=3386`, pre-installed Chromium; DB and `.next` removed afterwards): `admin.spec.ts` (incl. the field section no longer saying "Not measured yet"), `mobile-collect.spec.ts`, `payments.spec.ts`: 9/9. The mobile spec's post + 5 parallel replays left 6 rows: 2 posted, then 5 × 2 duplicates.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `TURBO_FORCE=1 pnpm test --concurrency=1` (10/10: core 1279 + 3 skipped, web 605, db 279, contracts 175, domain 373, ui 210, …), `pnpm build` (10/10), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `pnpm --filter @cb/db db:check`, `node scripts/tasks.mjs check --local`.

## Board log
- 2026-10-14T21:32:13.219Z claimed by agent-t086a
- 2026-10-14T21:56:08.204Z completed on task/T-086a-record-payment-sync-attempts-and-duplica
