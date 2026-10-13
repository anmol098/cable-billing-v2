---
id: T-041
title: Domain: allocation, credit application and reversal
phase: 2
area: domain
status: done
owner: agent-t041
claimed_at: 2026-10-13T10:41:47.018Z
branch: task/T-041-domain-allocation-credit-application-and
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/domain/src/allocation/**]
---

# T-041 — Domain: allocation, credit application and reversal

**Phase** 2 · **Area** domain · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Pure, provably-correct money allocation.

## Scope

- `allocate(amount, openInvoices)` oldest period first, invoice id tie-break, partial allowed, remainder = credit.
- `applyCredit(creditSources, openInvoices)` oldest source → oldest invoice.
- `reverse(payment, allocations)` → negative allocation rows.
- Invariant checker `checkLedger(state)` reused by the nightly job (T-052).

## Acceptance criteria

- [x] Invariants 1–4 in PLAN §8.4 hold under fast-check with ≥ 10k random sequences.

## Tests required

- Property tests + edge cases (zero open invoices, exact pay-off, many tiny invoices).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/allocation/**`

## References

PLAN §8.4, PLAN §8.5, PLAN §8.6, FR-014, RULE-11, RULE-12, RULE-13, BR-09, BR-13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/domain/src/allocation/**`, all exported from `@cb/domain`). Pure functions: no
I/O, no clock, no Node built-ins, all money through T-024's `Paise` and checked helpers. None of them
mutates its input; every output list has a fixed order. Expected failures come back as `Result` errors.

*Allocation (PLAN §8.4)*: `allocate(amountPaise, openInvoices)` →
`Result<{ allocations: { invoiceId, amountPaise }[], allocatedPaise, creditPaise, openInvoices }, AllocationError>`.
- `OpenInvoice = { id, period: Period, outstandingPaise }`. Order: `period ASC, id ASC`. Ids are compared
  by UTF-16 code unit, which matches Postgres `ORDER BY id` for lower-case canonical UUIDs.
  `compareInvoicesOldestFirst` is exported.
- Every row is > 0. All rows except the last pay their invoice off completely. `creditPaise` (the
  remainder, ≥ 0) is only non-zero when every invoice is paid. Invoices with outstanding 0 may be passed
  and are skipped.
- Errors: `VALIDATION` (amount ≤ 0 or not an integer; an invoice that is malformed or listed twice) and
  `INVARIANT_VIOLATION` (negative outstanding).

*Credit application (PLAN §8.5)*: `applyCredit(creditSources, openInvoices)` →
`Result<{ allocations: { sourceType, sourceId, invoiceId, amountPaise }[], appliedPaise, remainingSources, remainingCreditPaise, openInvoices }, AllocationError>`.
- `CreditSource = { sourceType: "payment" | "credit_adjustment", sourceId, availablePaise, at: Date | epochMs }`.
  Oldest source first: by `at`, then type (`credit_adjustment` before `payment`), then id. The oldest
  source pays the oldest invoice, and each source is used up before the next one starts. Total applied =
  min(credit, owed). The ledger does not change.
- Errors: `VALIDATION` (a malformed or duplicate source or invoice) and `INVARIANT_VIOLATION` (negative
  `availablePaise` or negative outstanding).

*Reversal (PLAN §8.6)*: `reverse({ id, amountPaise, reversed }, allocationRows)` →
`Result<{ allocations: ReversalAllocation[], deallocatedPaise, ledgerDeltaPaise, creditDeltaPaise }, ReversalError>`.
- Pass **all** of the payment's `allocations` rows: the ones from posting and the ones from later credit
  application. You get one negative row per positive original (`reversesAllocationId` = the original id,
  ordered by it). Store each with the reversal's id as `reversal_id`.
- `ledgerDeltaPaise` = +amount (the `payment_reversal` ledger entry). `creditDeltaPaise` = −(unallocated
  remainder): the reversed payment's credit disappears.
- Errors: `CONFLICT` (already reversed: `reversed: true`, or the rows already contain a negative or
  reversal-linked row), `VALIDATION` (a row from another source, a repeated or malformed row, amount ≤ 0)
  and `INVARIANT_VIOLATION` (the rows add up to more than the payment).

*Helpers*: `invoiceOutstanding(chargesPaise, rowsOfInvoice)` and
`unallocatedRemainder({ amountPaise, reversed? }, rowsOfSource)`, which is 0 for a reversed payment. Use them
to build `OpenInvoice.outstandingPaise` and `CreditSource.availablePaise`, so the services do the same
arithmetic as the checker.

*Ledger checker (for T-052)*: `checkLedger(state)` → `LedgerViolation[]` (empty = healthy) for **one customer**.
- `LedgerState = { invoices: { id, chargesPaise }[], payments: { id, amountPaise, reversed }[], creditAdjustments: { id, amountPaise }[], allocations: AllocationRow[], ledgerEntries: { type, amountPaise }[], balancePaise, creditPaise }`.
  The last two are the stored `customer_balances` read model.
- `LedgerViolation = { code, invariant: 1 | 2 | 3 | 4 | null, message, details }`. `details` holds only ids
  and amounts, so it is safe to store and alert on. The output is sorted by check, then by id.
- Codes (`LEDGER_VIOLATION_CODES`):
  - Invariants 1–4: `ALLOCATIONS_EXCEED_PAYMENT` (1), `CREDIT_MISMATCH` (2), `LEDGER_MISMATCH` (3),
    `NEGATIVE_OUTSTANDING` (4).
  - Supporting checks (`invariant: null`): `ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT` (PLAN §7.2 "per
    source"), `NEGATIVE_SOURCE_ALLOCATIONS`, `REVERSED_PAYMENT_STILL_ALLOCATED`,
    `NEGATIVE_ALLOCATION_WITHOUT_REVERSAL`, `OUTSTANDING_EXCEEDS_CHARGES`, `BALANCE_MISMATCH` (Σ ledger ≠
    stored balance, PLAN §14), `UNKNOWN_INVOICE`, `UNKNOWN_SOURCE`, `DUPLICATE_ID`, `INVALID_AMOUNT`.
- The doc comment quotes each invariant word for word.

**How the services should use it**
- T-046 `postPayment`: lock `customer_balances`. Build `OpenInvoice[]` with `invoiceOutstanding`. Call
  `allocate`, insert rows with `source_type = 'payment'`, add ledger −amount, then do
  `balance += −amount` and `credit += creditPaise`.
- T-046 `reversePayment`: load the payment's rows and call `reverse`. Insert `payment_reversals`, the
  negative rows (with `reversal_id`) and the ledger entry `ledgerDeltaPaise`. Then do
  `balance += ledgerDeltaPaise` and `credit += creditDeltaPaise`.
- T-044 billing (and T-045 for debit-adjusted invoices): after inserting the invoice and its ledger
  entry, build every live source with `unallocatedRemainder` (reversed payments are left out or give 0),
  call `applyCredit`, insert its rows, then do `credit −= appliedPaise`. The balance does not change.
- T-052: load each customer's rows into `LedgerState` and store and alert on `checkLedger(state)`.

**Rule interpretations (please check: `review: required`)**. Precedence is BRD > PRD > PLAN. Where the
documents are silent, I followed the PLAN text literally and did not add business rules.
1. **Order** (B-010, RULE-12, BR-09, PRD §13.2 step 3, PLAN §8.4): the PRD says "oldest due date"; invoices
   have no due-date column, so I used `period ASC, id ASC` as in PLAN §8.4.
2. **Multiple VCs** (B-009): invoices are customer-level, one consolidated invoice per period, so
   allocation goes to whole invoices oldest first. There is no ordering per VC and no allocation to
   individual lines; `invoice_lines` keep the VC attribution.
3. **Outstanding** = invoice charges − Σ allocations, **not** `total_due` (which repeats the opening
   balance, so using it would make one rupee settle two invoices). For `opening_balance` invoices the
   "charges" is the opening amount.
4. **Zero or negative payments** are refused with `VALIDATION` (PRD §13.2 step 1; DB `CHECK amount > 0`).
5. **Credit application** happens only when the caller calls `applyCredit`. PLAN §8.5 says this happens
   when an invoice or a debit-adjusted invoice is issued. `postPayment` allocates only the new payment's
   amount and does not re-apply older credit (PLAN §8.4).
6. **Reversal of a payment whose credit was already applied**: every row of the payment is cancelled,
   including rows from credit application. The invoices it paid become owed again, and its remaining
   credit disappears (`creditDeltaPaise`). This follows PLAN §8.6: "negative allocation rows that cancel
   the payment's allocations. Credit stays consistent".
7. **Invariant 3** is implemented exactly as written: Σ ledger = Σ invoice charges − Σ payments − Σ credit
   adj + Σ reversals. It has no term for debit adjustments or opening balances. I read this as: debit
   adjustments reach the ledger only through invoice charges (PLAN §8.2 "ledger += charges"), and
   opening balances are `opening_balance` invoices whose charges count.

**Open questions for the reviewer**
- Q-A (affects T-045 and T-023): `ledger_entries.type` includes `debit_adjustment`. If T-045 also writes a
  ledger entry when a debit adjustment is created, that amount is counted twice: once at creation and
  again in the invoice's charges. Invariant 3 as written would then fail. Which is intended?
- Q-B (affects T-045 and T-046): after a reversal reopens invoices, or a credit adjustment is created while
  dues are open, credit and dues exist together until the next invoice. BRD §16 says "apply available
  credit to oldest outstanding invoices by default". Should those flows also call `applyCredit` straight
  away? The function supports it; PLAN §8.5 only names invoice issue.
- Q-C (affects T-044): for "oldest source", I recommend a payment's `posted_at` over `recorded_at`
  (offline payments sync late). The tie-break between types and ids is arbitrary.
- Q-D: an `opening_balance` invoice and a regular invoice in the same period are ordered by id. UUIDv7
  ids normally put the migrated one first. Should opening balances always come first?
- Q-E: there is no flow to reverse a credit adjustment. The checker treats credit adjustments as never
  reversed.

**Deviations / files outside the owned paths**
- `packages/domain/src/index.ts` (shared, T-024 is done): added `export * from "./allocation";`.
- `checkLedger` adds the supporting checks listed above on top of invariants 1–4. They are reported
  with `invariant: null`, so the four invariants stay exactly as written in the plan.

**Tests** (`packages/domain`: 13 files, 219 tests; the allocation files take about 5 s)
- `invariants.property.test.ts` (**acceptance**): **10,000 random sequences** of up to 30 steps.
  - Steps: invoices (with credit applied on issue, some in the same period), payments (large and tiny),
    zero payments (refused), credit adjustments, and reversals (also asserting that a second reversal
    is `CONFLICT`).
  - A model account stores only rows produced by `allocate`, `applyCredit` and `reverse`, and updates the
    read model incrementally. After **every step**, `checkLedger` must return `[]`, every outstanding must
    be ≥ 0, and balance must equal Σ outstanding − credit.
  - Coverage counters assert that every path ran more than 100 times, including reversals of payments
    whose credit had been applied and reversals with credit. This stops the test passing vacuously.
  - A second property (2,000 runs) corrupts a healthy account in 8 ways and asserts that `checkLedger`
    reports it.
- `allocate.test.ts`:
  - Edge cases: zero open invoices, exact pay-off, partial settlement, excess as credit, same-period
    id tie-break (code-unit order), paid invoices skipped, **2,000 one-paise invoices**, frozen inputs,
    validation errors.
  - Properties: conservation, oldest-first prefix, independence from input order.
  - `applyCredit`: oldest source to oldest invoice, ties, `Date` instants, credit running out, total =
    min(credit, owed).
- `reverse.test.ts`: full, partial and all-credit reversals; cancelling rows from credit application;
  CONFLICT, VALIDATION and INVARIANT_VIOLATION cases; originals untouched.
- `check-ledger.test.ts`: a healthy account, then one targeted test for each invariant and each supporting
  code, and stable output order.
- Mutation checks, done by hand and reverted:
  - Dropping the `min(…)` in `allocate` makes the property fail with `NEGATIVE_OUTSTANDING`.
  - Making `reverse` forget the remainder makes it fail with `CREDIT_MISMATCH`.

**Verification** (Node v24.21.0, pnpm 12.11.2): `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`, `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T10:41:47.019Z claimed by agent-t041
- 2026-10-13T10:54:50.382Z completed on task/T-041-domain-allocation-credit-application-and
