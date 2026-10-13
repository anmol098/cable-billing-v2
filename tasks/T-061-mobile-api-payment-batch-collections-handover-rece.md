---
id: T-061
title: Mobile API: payment batch, collections, handover, receipts
phase: 3
area: api
status: claimed
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

VERIFICATION_PLACEHOLDER

## Board log

- 2026-10-13T19:32:56.618Z claimed by agent-t061
