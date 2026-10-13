---
id: T-046
title: Payment posting and reversal service
phase: 2
area: core
status: done
owner: agent-t046
claimed_at: 2026-10-13T13:12:10.124Z
branch: task/T-046-payment-posting-and-reversal-service
depends_on: [T-041, T-023, T-025]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/payments/**, packages/core/src/receipts/numbering/**]
---

# T-046 — Payment posting and reversal service

**Phase** 2 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-041, T-023, T-025

## Goal

One idempotent path that every payment (web counter, Android, migration) goes through.

## Scope

- `postPayment(cmd)` exactly per PLAN §8.4: idempotency on client id (same payload → same result; different → ID_REUSED_WITH_DIFFERENT_DATA), row lock on customer_balances, allocation, ledger, receipt number `R-YYMM-NNNNN` + provisional alias, collection session totals update, review flags (inactive customer/lineman, clock skew > 10 min future or > 7 days old).
- `reversePayment(paymentId, reason)` Owner only (PLAN §8.6).
- Returns `{ payment, allocations, receipt, newBalance, credit }` used by web and mobile.

## Acceptance criteria

- [x] 10 concurrent identical posts create exactly one payment and one receipt (PRD §15 #8 server side).
- [x] Reversal never mutates original rows.

## Tests required

- Integration + concurrency tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/payments/**`
- `packages/core/src/receipts/numbering/**`

## References

PLAN §8.4, PLAN §8.6, PLAN §10.4, FR-013, FR-014, FR-016, FR-017, RULE-16, RULE-17, RULE-20, BR-10, BR-13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/core/src/payments/**`, `packages/core/src/receipts/numbering/**`; public API exported
from `@cb/core` through one line `export * from "./payments";`)

| Export | What |
|---|---|
| `postPayment` | Service `payments.post`, capability `payments.record` (Owner, Staff, Lineman; allowed in read-only mode, D-13). Input `PostPaymentInput` → `PostPaymentResult`. |
| `reversePayment` | Service `payments.reverse`, capability `payments.reverse` (**Owner only**; TENANT_READ_ONLY in read-only mode). Input `ReversePaymentInput { paymentId, reason }` → `ReversePaymentResult`. |
| `PostPaymentInput` / `PostPaymentCommand` | `{ id (idempotency key), customerId, amountPaise (int 1 … MAX_PAYMENT_PAISE), method cash\|upi, upiReference? (UPI only, trimmed, ≤ 64), notes? (trimmed, ≤ 500), recordedAt? (Date or ISO-8601 with Z), provisionalRef? (P-XXX-NNNN), claimedCollectorId?, claimedDeviceId? }`. UUIDs are lower-cased. |
| types | `PostPaymentResult { outcome: posted\|posted_needs_review\|duplicate, payment: PaymentView, allocations: PaymentAllocationView[], receipt: ReceiptView, newBalance, credit, creditAddedPaise, reviewReasons, reversed }`, `ReversePaymentResult { reversal, payment, allocations: ReversalAllocationView[], newBalance, credit, creditRemovedPaise }` (`types.ts` has the field-by-field mapping to the contract's `PostedPayment`). |
| receipt numbering | `formatReceiptNumber(businessDate, seq)` → `R-YYMM-NNNNN`, `nextReceiptNumber(tx, operatorId, businessDate)` (gap-free `receipt` counter), `isReceiptNumber`, `isProvisionalRef`, `RECEIPT_NUMBER_PATTERN`, `PROVISIONAL_REF_REGEX` (= the DB CHECK, tested). |
| constants | `MAX_PAYMENT_PAISE` (= contract `MAX_AMOUNT_PAISE`), `MAX_FUTURE_SKEW_MS` (10 min), `MAX_RECORDED_AGE_MS` (7 days). |

Internal (not exported from the package): `postPaymentInTx` / `reversePaymentInTx` (the algorithms inside a
caller's tenant transaction), `ledger-io.ts` (balance lock, invoice outstanding via T-041, read model, sessions),
`stored.ts` (replay reads), `review.ts`, `payload.ts`, `test-support.ts` (test seeding + `LedgerState` reader).

**Posting** (`post-payment.ts`, PLAN §8.4 step by step, one READ COMMITTED transaction):
1. Mobile needs `recordedAt` + `provisionalRef` (VALIDATION `details.fields` otherwise); the web may not send
   `claimedDeviceId`.
2. Payment id already in the tenant → **replay**: same payload → `duplicate` with the stored result (payment
   snapshots `balance_after_paise`/`credit_after_paise`, the `posting` allocations with their
   `outstanding_after_paise`, the receipt); different → `ID_REUSED_WITH_DIFFERENT_DATA` with
   `details.fields` = names of the differing fields (never values). Nothing is written; audit
   `skip("idempotent_replay")`.
3. Customer must be in the tenant (RLS) → else NOT_FOUND, nothing written (no balance row, no counter step).
4. `SELECT … FOR UPDATE` on `customer_balances` (created at zero if missing), then the id is checked again (a
   concurrent identical post committed while we waited → replay).
5. Open invoices = issued invoices, outstanding = T-041 `invoiceOutstanding`; T-041 `allocate` (oldest period,
   then id); remainder = credit.
6. Review flags (`review.ts`), first one stored in `review_reason`, all in the audit event and
   `result.reviewReasons`: `customer_inactive`, `collector_inactive` (claimed user disabled),
   `collector_mismatch` (claimed user ≠ signed-in user, or not in the tenant), `device_mismatch`,
   `recorded_at_out_of_range` (> 10 min ahead or > 7 days old; the bounds themselves pass). Never a rejection.
7. Insert the payment (`ON CONFLICT (operator_id, id) DO NOTHING`; a conflict means a concurrent post of the
   same id for **another** customer won → replay path → ID_REUSED), ledger `payment` (−amount), `posting`
   allocation rows, receipt (`R-{YYMM of business_date}-{seq:05}` from the gap-free counter, taken last;
   `provisional_ref` alias), `customer_balances` (balance, credit, `oldest_due_period`), collection session
   (Android only), audit `payments.post`.

**Reversal** (`reverse-payment.ts`, PLAN §8.6): payment in tenant (NOT_FOUND) → balance lock → already reversed
→ `CONFLICT` with `details.reason = "already_reversed"` → T-041 `reverse` over **all** the payment's rows
(posting and credit application) → `payment_reversals`, ledger `payment_reversal` (+amount), one negative
`reversal` row per original (`reversal_id`, `reverses_allocation_id`, `outstanding_after_paise`) → balance +=
amount, credit −= the payment's unallocated remainder, `oldest_due_period` recomputed → session totals −amount
(Android payments) → audit `payments.reverse`. Original rows are never touched.

**For later tasks**
- **T-061 (mobile batch):** validate each item with the contract's `PaymentBatchItem`, then call
  `postPayment.call(runtime, ctx, { id, customerId: customer_id, amountPaise: amount_paise, method,
  upiReference: upi_reference, notes, recordedAt: recorded_at, provisionalRef: provisional_ref,
  claimedCollectorId: collector_id, claimedDeviceId: device_id })` **once per item, each its own call/transaction**
  (a failed item must not roll back the others). Map: `ok` → outcome as is (`review_reason` =
  `payment.reviewReason` only for `posted_needs_review`); `PostedPayment` = `payment.*` + `receipt.receiptNumber`
  / `provisionalRef` + `allocations[]` (`invoiceKind` → `kind`) + `creditAddedPaise` + `newBalance` /
  `credit`. Errors: VALIDATION / ID_REUSED_WITH_DIFFERENT_DATA → `rejected`; NOT_FOUND → `rejected` with
  `CUSTOMER_NOT_FOUND`; CONFLICT with `details.retryable` or INTERNAL → `retry_later`.
- **T-048 (web counter):** `postPayment.call(runtime, ctx, { id: <UUIDv7 made when the form opens>, customerId,
  amountPaise, method, upiReference?, notes? })`. Re-submitting the same form id is safe (`duplicate`).
  Reversal UI (Owner): `reversePayment.call(runtime, ctx, { paymentId, reason })`; map CONFLICT
  `already_reversed` to a friendly message. `result.reversed` tells a replay that the payment was cancelled.
- **T-062 (collections/handover):** sessions exist only for Android payments (see decision 3); totals are
  running sums of non-reversed payments, also after `accepted` (the trigger allows it).
- **T-044 (billing run):** take the same `customer_balances` row lock; credit application (§8.5) is yours —
  posting never applies older credit.
- **T-052 (nightly invariants):** `test-support.ts` `readLedgerState` shows the row → `LedgerState` mapping.
- **T-069 / T-050 (receipts):** `receipts.provisional_ref` is the alias; a reversed payment's receipt =
  a `payment_reversals` row exists.

**Decisions (reviewer please check)**
1. **Receipt YYMM = the payment's IST business date** (`business_date`, i.e. the IST date of `recorded_at`, as
   instructed for this task), not the posting date. An offline payment taken on 31 Oct and synced on 2 Nov gets
   `R-2610-…`. A phone with a wrong clock gets that month (the payment is flagged anyway).
2. **Identity from the token, claims only flag.** `collector_id` = signed-in user, `device_id` = signed-in device
   (T-051 decision 4); the phone's `collector_id`/`device_id` raise `collector_*`/`device_mismatch` flags.
   Cash therefore lands in the signed-in user's session; the office review sorts out a mismatch.
3. **Collection sessions are updated for Android payments only** (source `android` = lineman), following PLAN
   §8.7 "created implicitly by the first payment of a lineman" rather than updating a session for every web
   counter payment of an Owner/Staff (they cannot submit a handover, `handover.submit` is lineman-only).
4. **Payload compared for idempotency**: customer, amount, method, UPI reference, notes, provisional ref, and
   `recordedAt` only when sent (the counter's server-time default can't repeat). Not compared: the claimed
   collector/device (a different user re-sending a held queue is the same payment) and server-derived values.
   A replay of a migrated payment id is refused (`source` difference).
5. **Duplicates return the stored snapshots**, never recomputed: same `newBalance`/`credit`/allocations even if
   bills or payments came later (tested).
6. **Void invoices are not "open"** for allocation (no flow voids yet; T-023 open question).
7. **One review reason stored** (`payments.review_reason` is a single enum); the full ordered list is in the
   audit event `after.review_reasons` and in the result.
8. **Lock order** is balance row → receipt counter (taken last) → session row; reversal: balance → session.
   No cycles with each other or T-044 (balance → invoice counter). Services must stay READ COMMITTED.
9. UUID inputs are normalised to lower case (Postgres' canonical form) so replays and claim comparisons are exact.

**Assumptions about open questions (T-041 Q-A … Q-E, defaults followed)**
- Q-B: neither posting nor reversal applies existing credit to (re)opened invoices; that happens at the next
  invoice (T-044). A reversal can leave credit and dues side by side until then.
- Q-C: not used by posting (no credit application here).
- Q-A, Q-D, Q-E: no effect on this task (only payments are reversed; allocation order is T-041's).

**Open questions**
- **A deactivated lineman's own queue**: `resolveTenantContext` refuses a disabled user (ACCOUNT_DISABLED), so
  `collector_inactive` can only arise when another (active) user sends the queue. PLAN §10.4 lists "lineman
  deactivated" as a review case: if the phone of a deactivated lineman must still sync its held payments,
  T-028/T-061 need a decision (today the whole batch gets 403 and the payments stay on the phone).
- Receipt YYMM from `business_date` vs posting date (decision 1).
- Should Owner/Staff counter cash have its own session/handover (decision 3)?

**Deviations / shared files**
- `packages/core/src/index.ts`: one appended line `export * from "./payments";` (the payments index re-exports
  `receipts/numbering`, so there is one line, as asked).
- `PostPaymentInput` takes camelCase names (core convention); the snake_case wire mapping is T-061's.
- No new dependencies, no migrations, no i18n strings (no UI).

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17, DB suites really ran, no skips)
- `pnpm --filter @cb/core test`: 18 files, 323 tests. New: 6 files, 43 tests.
  - `concurrency.test.ts` (dedicated pool of 14 connections, real parallel transactions): **10 concurrent identical
    posts → 1 posted + 9 duplicate with identical results, exactly 1 payment, 1 receipt, 1 ledger entry, 2
    allocations, 1 audit event, receipt counter advanced by exactly 1, session counted once**; the same id raced
    for 4 customers → 1 posted, 3 ID_REUSED; 10 different concurrent payments for one customer → strictly
    sequential balance snapshots (no lost update), gap-free receipts R-2610-00001…00010, no bill overpaid;
    payments + reversals + a double reversal racing on one customer → exactly one CONFLICT, ledger consistent,
    session totals right.
  - `reverse-payment.test.ts`: **reversal never mutates original rows**: a full row snapshot (payment, its
    allocations, ledger entry, receipt) is identical before and after, and UPDATE/DELETE of payments,
    allocations, ledger entries, receipts and reversals are refused with CB001 even on the owner connection;
    credit-application rows are cancelled too; double reversal CONFLICT; replay after reversal → `duplicate`,
    `reversed: true`; reopened bills paid next; Owner only (Staff/Lineman FORBIDDEN), NOT_FOUND, VALIDATION,
    TENANT_READ_ONLY.
  - `post-payment.test.ts`: allocation oldest first with `outstanding_after`, credit, gap-free receipts, IST
    business date → `R-2611-…` across midnight, web counter (no device/session/provisional ref), read-only tenant
    allowed, replay writes nothing (row counts, counter, audit unchanged; snapshots stable after later bills),
    replay by another user, upper-case ids, ID_REUSED per field, per-tenant keys, NOT_FOUND for another tenant's
    customer with nothing written, VALIDATION cases, mobile-required fields, every review flag and its bounds.
  - **After every post and reversal the customer's rows are read back into T-041 `LedgerState` and `checkLedger`
    returns `[]`.**
  - Isolation suite: `payments.post` (owner/staff/lineman) and `payments.reverse` (owner) → NOT_FOUND, no
    database change, controls ok; coverage test passes.
- **Mutation checks** (reverted): dropping `FOR UPDATE` on the balance row → both "serialised per customer"
  tests fail; dropping the post-lock re-check and `ON CONFLICT DO NOTHING` → both "sent many times at once" tests
  fail (losers get CONFLICT instead of `duplicate`).
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build`
  (9/9), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:12:10.125Z claimed by agent-t046
- 2026-10-13T13:30:47.161Z completed on task/T-046-payment-posting-and-reversal-service
