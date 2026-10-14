---
id: T-048
title: Counter payments, payment register and reversals UI
phase: 2
area: web
status: done
owner: agent-t048
claimed_at: 2026-10-13T20:30:59.208Z
branch: task/T-048-counter-payments-payment-register-and-re
depends_on: [T-046, T-033]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/payments/**, apps/web/src/app/(operator)/customers/[id]/payments/**, apps/web/src/components/payments/**, packages/i18n/messages/*/payments.json]
---

# T-048 — Counter payments, payment register and reversals UI

**Phase** 2 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-046, T-033

## Goal

Office staff take payments at the counter in four taps.

## Scope

- Take payment: customer search → amount (pre-filled with due) → Cash/UPI tiles (+ optional UPI ref) → confirm → success with receipt actions (print A5, copy preview link).
- Payment register with filters (date, collector, method, status), payments-needing-review list with resolve action.
- Owner reversal flow with reason and plain-language effect.
- Customer Payments tab.

## Acceptance criteria

- [x] Double-click on Save cannot create two payments (client-generated id reused).

## Tests required

- Playwright counter payment; component tests for the flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/payments/**`
- `apps/web/src/app/(operator)/customers/[id]/payments/**`
- `apps/web/src/components/payments/**`
- `packages/i18n/messages/*/payments.json`

## References

FR-013, FR-014, BR-13, PLAN §12.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Built**

- **Take payment** (`/payments/new`, `components/payments/counter-payment.tsx`): four steps with one job each. (1) Find the customer (name, mobile no., code or VC no.; `?customer=<id>` skips this step, so the profile's "Take payment" lands on step 2). (2) The amount, pre-filled with the full due. (3) Cash or UPI tiles, with an optional UPI ref no. for UPI. (4) Check and save. The success screen shows the receipt no., the balance after, any "office will check" reason, and the receipt actions: print A5 (`GET /payments/[id]/receipt`, an inline PDF from T-050's `receiptDocument`/`receiptPdf`, with a "Cancelled" stamp when undone) and copy receipt link (`createReceiptLink`; the page says "copied", never "sent").
- **Double save:** the payment id (UUIDv7, the FR-015 idempotency key) is made in the browser on the first Save and reused for every Save of the same form, including a double click or a retry after "Could not save". A new id is made only for "Take another payment". Save is also locked while a save runs. `takePaymentAction` calls T-046 `postPayment` (`source: "web"`), and a second call with the same id is a `duplicate` that returns the same receipt.
- **Payment register** (`/payments`): filters for IST date range (default today; quick links for Today and This month), who took it, cash/UPI, status (counted / to check / checked / cancelled) and receipt no. Totals for cash, UPI and count leave cancelled payments out ("n cancelled, not counted"). Paged.
- **Payments to check** (`/payments/review`): flagged payments with the reason. The payment page has "Mark as checked" with an optional note, using the new core service `resolvePaymentReview`.
- **One payment** (`/payments/[id]`): amount, method, status, customer, receipt no. (plus the phone's temporary no.), who took it, phone time and time it reached the office, the bills it paid, receipt actions, the office check, and the cancellation details.
- **Owner undo** (`/payments/[id]/undo`, plus `/payments/reversals` to find a payment by receipt no. or temporary no. and to list cancelled payments). The Owner picks a reason (wrong customer / wrong amount / saved twice / money not received / other; a note is required for "other"). A confirm sheet states the effect with numbers: the balance now and after, "Cancelled" on the receipt, and cash to give back. The action calls T-046 `reversePayment` and stores the reason as `<code>: <note>`. Staff get 404 on both pages, and the server refuses them anyway.
- **Customer Payments tab** (`/customers/[id]/payments`): this customer's payments, newest first, with cancelled ones marked.

**Interfaces for later tasks** (`@cb/core`, `packages/core/src/payment-register/`)

- `listPayments` (register: filters, totals, collectors, paging), `getPayment` (detail with the bills it paid), `getPaymentReceipt` (data for the A5 PDF). These are reads under `dashboard.view` and are allowed in read-only mode.
- `resolvePaymentReview`: `review_status needs_review -> resolved` with `reviewed_by/at` and an optional `review_note`, which is the one change T-023's append-only trigger allows. It returns CONFLICT `not_flagged` / `already_resolved`. Capability `handover.review` (Owner and Staff, audited).
- Isolation-harness cases for all of these are in `payment-register.isolation.ts` (register, review list, receipt-no. filter, another tenant's customer / collector / payment / receipt / flagged payment).
- Web helpers in `apps/web/src/components/payments/`: `format.ts` (`rupees`, `balanceText`, `paymentHref`, undo reasons), `results.ts` (action result types and error keys), and `PaymentList` / `Pager` / status pills in `payment-parts.tsx`.

**Decisions and deviations**

- Outside the owned paths: the payment reads and the review service are a new core module, `packages/core/src/payment-register/**`, plus one export line in `packages/core/src/index.ts`. T-046 owns only posting and reversal, and the pages need tenant-scoped reads with isolation cases.
- Two nav entries in `apps/web/src/lib/nav.ts` (plus the `shell.json` labels and the `nav.test.ts` owner-only list), so the shell knows `/payments/[id]` and `/payments/[id]/undo`. The undo entry is Owner-only.
- A "Payment words" section in `packages/i18n/glossary.md`.
- No new capability for "mark as checked": it reuses `handover.review`, the same §9.3 row as accepting a cash handover. The product owner may want a separate `payments.resolve_review` row in the capability table.
- The receipt language comes from `?lang=` or else the business's receipt language. The printed receipt shows the same content as the public receipt link (first name, masked phone, no UPI ref).
- Hindi is machine-drafted and listed in `_review` in `hi/payments.json` (H-03).

**Verified** (after rebasing on `feature/mvp` at b213333; Node 24.21.0, Postgres 17)

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (all 10 packages; web 308 tests, core 775 including the payment-register DB tests and isolation cases), `pnpm --filter web build`, tokens/icons/i18n `--check`, `node scripts/tasks.mjs check --local`.
- Component tests: `counter-payment.test.tsx` (four steps; due pre-filled; double click -> one call with one id; a retry reuses the id; a new payment gets a new id), `actions-ui.test.tsx` (receipt actions, mark as checked, undo sheet), `format.test.ts`.
- Playwright `e2e/payments.spec.ts` against `next start` and a freshly migrated database (3/3 passed). It covers: a Staff counter payment with a double-clicked Save -> exactly one payment and one receipt in the DB; the PDF and receipt link; the register totals; the customer Payments tab; Staff 404 on undo; the Owner undo -> one reversal row, due restored, "Cancelled" in the register; a closed customer's UPI payment flagged -> marked as checked; no sideways scroll at 360px. The full e2e suite was not run locally because the disk was full; CI "Web e2e" runs it.

## Board log

- 2026-10-13T20:30:59.209Z claimed by agent-t048
- 2026-10-14T03:59:28.000Z completed on task/T-048-counter-payments-payment-register-and-re
