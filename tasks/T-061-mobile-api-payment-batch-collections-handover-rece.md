---
id: T-061
title: Mobile API: payment batch, collections, handover, receipts
phase: 3
area: api
status: done
owner: agent-t061
claimed_at: 2026-10-13T19:32:56.618Z
branch: task/T-061-mobile-api-payment-batch-collections-han
depends_on: [T-028, T-046, T-050, T-062]
review: required
claimable_by: agent
size: M
paths: [apps/web/src/app/api/mobile/v1/payments/**, apps/web/src/app/api/mobile/v1/payments:batch/**, apps/web/src/app/api/mobile/v1/collections/**, apps/web/src/app/api/mobile/v1/receipts/**]
---

# T-061 — Mobile API: payment batch, collections, handover, receipts

**Phase** 3 · **Area** api · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-028, T-046, T-050, T-062

## Goal

Thin adapters from the contract to core services, with per-item batch results.

## Scope

- `POST /payments:batch` (≤50 items, each through postPayment; outcomes posted|duplicate|posted_needs_review|rejected).
- `GET /collections/{date}`, `POST /collections/{date}/handover`.
- `POST /receipts/{paymentId}/link`, `POST /receipts/actions:batch` (observable actions only).

## Acceptance criteria

- [x] Replaying the same batch 10× concurrently yields identical results and no duplicates.
- [x] Payments still accepted when tenant is read_only (D-13).

## Tests required

- Integration + contract tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/api/mobile/v1/payments/**`
- `apps/web/src/app/api/mobile/v1/payments:batch/**` (added by T-061: the contract path `/payments:batch` is a folder of its own, T-051 follow-up)
- `apps/web/src/app/api/mobile/v1/collections/**`
- `apps/web/src/app/api/mobile/v1/receipts/**`

## References

PLAN §10.2, PLAN §10.4, FR-015, FR-016, FR-019, FR-020, FR-022 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `apps/web/src/app/api/mobile/v1/payments:batch/route.ts` | `POST /payments:batch` (contract `postPaymentBatch`). The folder is literally `payments:batch` (path widened in this file's front matter, T-051 follow-up). `maxDuration = 60`. |
| `apps/web/src/app/api/mobile/v1/payments/_lib/batch.ts` | `paymentBatchHandler(getDeps, { timeBudgetMs? })`, `postedPaymentWire(result, provisionalRef)` (T-046 `PostPaymentResult` → contract `PostedPayment`), `PAYMENT_BATCH_TIME_BUDGET_MS` (30 s). |
| `apps/web/src/app/api/mobile/v1/payments/_lib/wire-errors.ts` | Shared by the three areas: `itemIdOf`, `UNUSABLE_ITEM_ID`, `wireName` (core camelCase → wire snake_case; `claimedCollectorId` → `collector_id`, `businessDate` → `date`), `coreFieldIssues`, `differingFields`, `itemError`. |
| `apps/web/src/app/api/mobile/v1/collections/[date]/route.ts`, `…/[date]/handover/route.ts`, `collections/_lib/collections.ts` | `GET /collections/{date}` → T-062 `getOwnCollectionDay`; `POST /collections/{date}/handover` → `submitHandover`; `collectionDayWire(view)` (T-062 `CollectionDayView` → contract `CollectionDay`). |
| `apps/web/src/app/api/mobile/v1/receipts/[paymentId]/link/route.ts`, `receipts/actions:batch/route.ts`, `receipts/_lib/receipts.ts` | `POST /receipts/{paymentId}/link` → T-050 `createReceiptLink` (`receiptLinkHandler(getDeps, { receiptOrigin })`, production origin `baseUrls().receipt`); `POST /receipts/actions:batch` → `recordReceiptAction` per item (`receiptActionsHandler`). |
| `packages/core/src/receipts/actions/` (new; one line in `packages/core/src/index.ts`) | Service **`recordReceiptAction`** (`receipts.record_action`, capability `receipts.share`: Owner/Staff/Lineman, allowed in read-only mode, not audited) + `RecordReceiptActionInput`; isolation case `actions.isolation.ts`. Needed because nothing wrote `receipt_actions` yet and routes may not touch tables directly. |
| `apps/web/src/app/api/mobile/v1/payments/_lib/test-support.ts` | Test harness (Vitest only): real T-028 auth service and sign-in, injected clock, request builders, seeding (customers, bills), row counters. |

**Endpoints and error mapping.** Every route goes through `withMobileAuth` (T-028): version gate (426 APP_TOO_OLD / 400 missing header), bearer token (401 UNAUTHENTICATED), revoked phone (401 DEVICE_REVOKED), disabled user (403 ACCOUNT_DISABLED), all before anything is read or written. Every 200 body is validated against the contract before it leaves.

- `POST /payments:batch`: envelope `PaymentBatchEnvelope` (1–50 items, else 400 VALIDATION), then each item with `PaymentBatchItem` and `postPayment.call` **in its own transaction, in request order**. Per item: ok → `posted` / `duplicate` / `posted_needs_review` (`review_reason` = the stored first reason) with the posted payment (echoes `id` and `provisional_ref`); VALIDATION → `rejected` VALIDATION with `fields` `payments.<i>.<wire field>`; ID_REUSED_WITH_DIFFERENT_DATA → `rejected` (differing field names in the message, never values); NOT_FOUND → `rejected` CUSTOMER_NOT_FOUND; CONFLICT → `retry_later` CONFLICT; anything else or a thrown error → `retry_later` INTERNAL (logged, Sentry); time budget used up before an item starts → `retry_later` RATE_LIMITED. An item without a usable id is answered with the nil UUID (matches nothing on the phone). One summary log line per batch (counts only).
- `GET /collections/{date}`: bad date → 400 VALIDATION `date`; future (IST) → 400 VALIDATION `{ path: "date", issue: "future" }`. Always the signed-in lineman's own day.
- `POST /collections/{date}/handover`: 400 VALIDATION (incl. `discrepancy_reason` `required`), 409 HANDOVER_ALREADY_ACCEPTED, 409 ID_REUSED_WITH_DIFFERENT_DATA (names in the message), a retryable CONFLICT → 429 RATE_LIMITED `retry_after_seconds: 1` (temporary for the phone; 409 would mean "call office"). The same `submission_id` again → 200 with the current day.
- `POST /receipts/{paymentId}/link`: 404 PAYMENT_NOT_FOUND (not synced yet, or another tenant's payment), 400 VALIDATION (not a UUID), T-050 `too_many_links` → 429 RATE_LIMITED `retry_after_seconds: 3600`; a non-https receipt origin → 500 INTERNAL **before** a link is made (the contract's `url` is https only, so locally with `http://localhost` this endpoint answers 500 unless `RECEIPT_BASE_URL` / `APP_BASE_URL` is https).
- `POST /receipts/actions:batch`: per item `recorded` / `duplicate`; `rejected` for VALIDATION (incl. `sent` / `delivered`, which the contract enum refuses) and ID_REUSED; `retry_later` for PAYMENT_NOT_FOUND (payment not synced yet, as the contract says) and temporary failures.

**Deactivated lineman's queued payments (T-032's criterion "queued payments still accepted with review flag") — PRODUCT-OWNER DECISION, please confirm**

Implemented on the server, the safest option, with no change to T-028's auth:

1. **A deactivated lineman's own token never posts anything.** T-028 re-reads the user on every request, so even a still-unexpired access token gets **403 ACCOUNT_DISABLED for the whole batch, nothing written**; the phone keeps every payment (BR-11; T-063/T-066 keep the queue on any whole-request error). The same holds for a revoked phone (401 DEVICE_REVOKED), a logged-out, reused or revoked token family, and a forged or expired token (401). Tested.
2. **Their queue is accepted when it arrives under an active lineman's sign-in of the same tenant**, item by item as it was saved (the deactivated lineman's `collector_id` / `device_id`): posted as **`posted_needs_review` with `collector_inactive`** (T-046 review rules; `collector_mismatch` / `device_mismatch` are also in the audit event). Idempotency ignores the claimed collector, so if the lineman is later re-activated and the phone resends, the answer is `duplicate` with the identical payment. Tested end to end.
3. Rejected alternative: letting the disabled lineman's still-valid session push `/payments:batch` only. It would accept payments from a sign-in that T-032 revokes on deactivation (from a user who may have been deactivated for fraud), it needs exemptions in `resolveTenantContext` and in the per-request family check, and it would only cover the ≤ 15-minute access-token window, not a phone that was offline for days.

What this needs from others (not done here): the **phone does not send another lineman's held payments today** (T-066 decision 6), so the payments stay safely on the phone until either (a) the T-066 proposal is built (the Owner presses "Send this phone's held payments" on the web, `/app/config` carries the release, the phone sends them under the current sign-in; the server side above already accepts and flags them), or (b) as an interim procedure the Owner re-activates the lineman, who signs in and syncs, then deactivates again. T-032 should warn on "Deactivate" that the phone may still hold payments.

**Decisions (reviewer please check)**

1. **Unknown failures are `retry_later`, never `rejected`.** `rejected` makes the phone stop sending the payment for good ("Call office"); only invalid input, an unknown customer and a reused id are final. Nothing is saved on `retry_later`, and a resend is safe (idempotent ids).
2. **Result ids are lower case** (the phone sends lower-case UUIDv7; the contract's refinement needs `payment.id === id`).
3. **A replay of a flagged payment answers `duplicate`** (with `review_reason: null`; the contract allows a reason only for `posted_needs_review`), so a phone that lost the first answer shows "Sent to office" without the review flag. The money and the office's review are unaffected. See open questions.
4. **Time budget 30 s per batch** (runtime clock): items not started by then are `retry_later`; the route's `maxDuration` is 60 s. The phone resends them.
5. **Receipt links: a new link on every call** (T-050 stores only hashes); `too_many_links` maps to RATE_LIMITED (temporary) rather than CONFLICT (which the phone would treat as "call office").
6. **`recordReceiptAction` is not audited** (`receipts.share` is not an audited capability): the append-only `receipt_actions` row is the record (actor, device, phone time, server time).
7. Batches are processed **sequentially** in request order (contract: "The server posts them in this order").
8. No rate limit on the batch endpoints yet (PLAN §9.4 lists "mobile sync"); the token, the 50-item cap and the time budget bound one request.

**Open questions (product owner)**

- **The deactivated-lineman flow above** (confirm option 2 plus the T-066 release proposal, or prefer something else).
- **Whose collection session counts a released held payment?** T-046 decision 2 records the payment and its cash under the **signed-in sender**, so the sender's expected cash for the day includes money he never held; the office sees the `collector_inactive` / `collector_mismatch` flag. Alternative: count it in the claimed collector's session when that user is a lineman of the tenant (a core change in T-046's area). Needs a decision before the release flow is built.
- Should a replay of a flagged payment answer `posted_needs_review` (decision 3)?
- A rate limit for `/payments:batch` and `/receipts/actions:batch`.
- `/payments:batch` must be sent with a literal `:`; a client or proxy that percent-encodes it (`payments%3Abatch`) gets 404 (checked on `next start`). OkHttp/Retrofit keep the colon (T-066 uses `./payments:batch`).

**Deviations / files outside the owned paths**

- This file's front matter: `paths` + `apps/web/src/app/api/mobile/v1/payments:batch/**` (the literal contract path, T-051's noted follow-up).
- `packages/core/src/receipts/actions/**` (new) and one appended line in `packages/core/src/index.ts` (`export * from "./receipts/actions";`). T-046 / T-050 are done.
- `apps/web/turbo.json` (T-005/T-011, done): `test.env` = `DATABASE_URL`, `CB_SKIP_DB_TESTS`, `CB_TEST_DATABASE_ALLOW_REMOTE`, because the web app now has DB integration tests (turbo strict env mode; same list as `packages/core/turbo.json`).
- New `apps/web/e2e/mobile-collect.spec.ts` (runs in the existing `Web e2e` job).
- No migration, dependency, i18n string, UI or contract change.

**Verification**

Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 41642a5 (after T-033 and T-030). DB suites really ran, nothing of this task skipped.

- **Web route handlers** (real DB, real T-028 sign-in and tokens, injected clock; every body parsed with the contract): `payments/_lib/batch.test.ts` (13), `collections/_lib/collections.test.ts` (8), `receipts/_lib/receipts.test.ts` (8).
  - **Same batch 10× concurrently** (dedicated 16-connection pool; an admin connection holds the customer's balance row lock until all 10 requests are blocked on it, then releases them together): per item exactly 1 `posted` + 9 `duplicate`, the identical `payment` in all 10 answers, receipts R-2610-00001…00005 gap-free, receipt counter +5, 5 payments / 5 receipts / 7 ledger rows / 1 session, strictly sequential balance snapshots; then 10 sequential replays → all `duplicate`, byte-identical results, row counts unchanged.
  - Posted payment shape (oldest-bill allocations with `outstanding_after_paise`, credit, balance/credit after, echoed id and provisional ref, `posted_needs_review` `customer_inactive`), session totals, the contract fixture batch (same keys as the fixture response).
  - A malformed item never sinks the batch: fractional paise, UPI ref on cash, missing id (nil UUID), unknown and other-tenant customers (CUSTOMER_NOT_FOUND, no leak), reused id (message names `amount_paise`), offset timestamp → `rejected` with `payments.<i>.<field>` paths, the rest posted / duplicate; only valid items written. Whole-request 400s (empty, 51 items, wrong shape, not JSON); exactly 50 is fine.
  - **Timeout then retry**: the first answer "lost", the identical batch 2 min later → `duplicate` with the same payments; after a later bill the replay still returns the posting-time snapshots; nothing doubled.
  - **Transient failures**: a 40001 and a thrown error on items 2/3 → `retry_later` (CONFLICT / INTERNAL), items 1/4 posted; the retry posts 2/3 once (4 payments). Time budget with a clock that advances on every read → a posted prefix then `retry_later` RATE_LIMITED; the next send posts the rest.
  - **Read-only** (`read_only` and `cancelled`): payments, day, handover, receipt links and actions all work (D-13).
  - Auth: no token, missing header (400), old app (426 + `min_app_version_code`), forged and expired tokens (401), "Sign out this phone" (401 DEVICE_REVOKED) → nothing written.
  - **Deactivated lineman**: disabled with a still-valid token → 403 ACCOUNT_DISABLED (also after `revokeMobileRefreshTokens`), nothing written; another lineman sends the queue → `posted_needs_review` `collector_inactive`, stored with the sender; after re-activation the original phone's resend → `duplicate`, identical payments. Another active lineman's held payment → `collector_mismatch`.
  - Isolation: the same payment id in two tenants is two payments; another tenant's customer → CUSTOMER_NOT_FOUND, its rows unchanged; another tenant's or lineman's day is empty and contains none of the other ids; another tenant's handover leaves the session untouched; another tenant's payment → PAYMENT_NOT_FOUND for links and `retry_later` for actions, no link/action written anywhere.
  - Collections: newest-first payments, empty / bad / future dates (incl. the IST day boundary), handover discrepancy and required reason, idempotent `submission_id` (no new event row), ID_REUSED (names only), returned → resubmitted → accepted → HANDOVER_ALREADY_ACCEPTED, fixture request. Receipts: 90-day https link with only the token hash stored (token not in logs), a new link per call, 20-link cap → 429 + `Retry-After`, http origin → 500 with no link made, honest actions vs `sent`/`delivered`, replays.
- **Core** `receipts/actions/actions.test.ts` (7): stored with actor/device and both clocks, duplicate / ID_REUSED (names), NOT_FOUND for unknown or other-tenant payments, per-tenant ids, **6 identical concurrent inserts racing at once** (table-lock barrier) → 1 recorded + 5 duplicate, 1 row; every role, read-only, append-only (UPDATE/DELETE refused), validation. Isolation suite: new `receipts.record_action` case passes; coverage test passes.
- **Mutation checks** (reverted): CONFLICT → `rejected` and NOT_FOUND → `retry_later` in the batch mapping make 2 tests fail; dropping `ON CONFLICT DO NOTHING` in `recordReceiptAction` fails the race test.
- **Playwright** (`next start`, migrated scratch DB `cb_e2e_t061`, `E2E_PORT` 3261–3263, pre-installed Chromium; DB dropped afterwards): full suite **61 passed**, incl. new `mobile-collect.spec.ts` (sign-in → literal `/payments:batch` → 5 parallel replays → day → handover → link → literal `/receipts/actions:batch` → 401 without token), run with both an http origin (link 500) and `RECEIPT_BASE_URL=https://…` (link 200).
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10: core 707 + 1 skipped T-033 benchmark, web 269, db 254, contracts 175), `pnpm build` (lists the five new routes), `pnpm generate` (no diff), tokens / icons / i18n / openapi `--check`, `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T19:32:56.618Z claimed by agent-t061
- 2026-10-13T20:03:06.635Z completed on task/T-061-mobile-api-payment-batch-collections-han
