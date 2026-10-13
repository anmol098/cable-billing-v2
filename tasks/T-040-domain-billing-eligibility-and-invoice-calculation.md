---
id: T-040
title: Domain: billing eligibility and invoice calculation
phase: 2
area: domain
status: done
owner: agent-t040
claimed_at: 2026-10-13T11:55:32.848Z
branch: task/T-040-domain-billing-eligibility-and-invoice-c
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/domain/src/billing/**]
---

# T-040 — Domain: billing eligibility and invoice calculation

**Phase** 2 · **Area** domain · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Pure functions deciding who is charged what for a month.

## Scope

- `isBillable(assignmentTimeline, period)` implementing 'active at any time on the 1st; status changes take effect at the end of their effective day'.
- `buildInvoice({ customer, assignments, pendingAdjustments, openingBalance, period })` → lines + totals (charges, total_due) or `nothing_to_bill`.
- Every consequence listed in PLAN §8.1 is a named test case.

## Acceptance criteria

- [x] Functions are pure (no I/O, no Date.now()).
- [x] Multi-VC customers get one consolidated set of lines (PRD §15 #3).

## Tests required

- Table-driven unit tests + fast-check properties (charges = Σ lines; never bills a disconnected-before-period assignment).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/billing/**`

## References

PLAN §8.1, PLAN §8.2, FR-009, FR-010, RULE-04, RULE-05, RULE-08, RULE-09, B-006 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/domain/src/billing/**`, all exported from `@cb/domain`). The functions are pure:
they do no I/O, never read the clock and use no Node built-ins. All money goes through T-024's `Paise`
and its checked helpers. Inputs are never mutated, and outputs come in a fixed order that does not depend
on the input order.

*Timeline input* (`types.ts`). `AssignmentTimeline = { startDate, endDate, events }` maps one to one from
`vc_assignments` + `assignment_events`:
- `startDate` is the first day of service. The assignment is active from the **start** of that day.
- `endDate` is the last day of service, **inclusive**. It is the same as the `'[]'` daterange of the
  EXCLUDE constraint, and it equals the disconnection's effective date. It is `null` while the assignment
  is open.
- `events: AssignmentEvent[]` are passed **in recorded order** (`at, id`). Any effective-date order is
  fine: the functions sort by effective date, and the recorded order only breaks ties within one day.
  - `{ type: "activated" | "suspended" | "reactivated" | "disconnected", effectiveDate }`
  - `{ type: "plan_changed", effectiveDate, rentalPaise }`, where `rentalPaise` is the event's "to" value.
- `BillingAssignment = AssignmentTimeline & { id, customerId, initialRentalPaise }`. `initialRentalPaise`
  is the rental the assignment started with: the first `plan_changed` event's "from" value, or
  `vc_assignments.rental_amount_paise` if the plan never changed.

*Eligibility* (`timeline.ts`, PLAN §8.1):
- `isBillable(timeline, period): boolean` is true when the assignment is active at any time on the 1st.
  Status changes take effect at the end of their effective day, so this is the same as
  `startDate ≤ 1st` plus "the status left by the changes effective **before** the 1st is `active`".
  The file header has a table of every edge case.
- `assignmentStatusOn(timeline, date)` returns `"not_started" | "active" | "suspended" | "disconnected"`
  for the status during one business date. T-034/T-045 can use it for effect previews such as "Rent stops
  from November".
- `rentalForPeriod(assignment, period)` returns the rental set by the last `plan_changed` event effective
  **on or before the last day of P**, or `initialRentalPaise` if there is none. This follows BR-07/D-14:
  the full new rental applies to the current month, and repeated changes end at the latest amount.
- `validateAssignmentTimeline(timeline)` returns `Result<timeline, BillingError>`. The three functions
  above **throw `RangeError`** on an impossible timeline (programmer error, as in T-024), so validate
  untrusted data first.
  - Refused (`details.reason`): `invalid_date`, `end_before_start`, `event_before_start`,
    `event_after_end`, `unknown_event_type`, `activated_not_on_start`, `end_date_mismatch` and
    `invalid_amount`.
  - Also refused as `invalid_transition`: suspend when not active, reactivate when not suspended, or any
    change after the disconnection. A reused VC is a new assignment (RULE-07).
  - An `endDate` with no `disconnected` event (a migrated row) is read as a disconnection on that day.

*Invoice* (`invoice.ts`, PLAN §8.2): `buildInvoice({ customer: { id }, assignments, pendingAdjustments,
openingBalancePaise, period })` → `Result<InvoiceDraft | NothingToBill, BillingError>`
- `InvoiceDraft = { outcome: "invoice", kind: "regular", customerId, period, lines, chargesPaise,
  openingBalancePaise, totalDuePaise, invoicedAdjustmentIds }`. It is **one consolidated invoice per
  customer** (PRD §15 #3).
  - **Rent lines** come first: `{ type: "rent", assignmentId, adjustmentId: null, amountPaise }`, one per
    billable assignment at `rentalForPeriod`, ordered by `startDate` and then id.
  - **Adjustment lines** come next: `{ type: "adjustment", adjustmentId, assignmentId, adjustmentPeriod,
    source, amountPaise }`, ordered by period (no period first) and then id.
- `NothingToBill = { outcome: "nothing_to_bill", customerId, period }` is returned when there are no lines.
- Errors are always `VALIDATION`, with `details.reason`:
  - `invalid_period`, `invalid_id`, `duplicate_id` and `invalid_amount`.
  - `other_customer`: an assignment or adjustment of another customer (RULE-07).
  - `credit_adjustment`: see interpretation 4.
  - Any timeline reason, with `details.assignmentId`.
- **How T-044 maps the result:** `ok(invoice)` → item `created`; `ok(nothing_to_bill)` → `skipped`;
  `err` → `failed`, with `details` as the reason.
- **What T-044 does with an invoice:** in one transaction, check that no invoice exists (the DB unique is
  the final guard), take the number, insert the invoice and its lines, and add `+chargesPaise` to the
  ledger. Then set `invoice_id` on `invoicedAdjustmentIds`, and then call T-041 `applyCredit`.
  - Store `opening_balance_paise = openingBalancePaise`, which is Σ `ledger_entries` before the invoice.
  - Store `charges_paise = chargesPaise` and `total_due_paise = totalDuePaise`.
- **Preview (T-044/T-047):** call the same function read-only. Σ `chargesPaise` over the customers is
  the "total ₹…", and the `err` results are the "problems" list.
- `invoice_lines.description`: lines carry structured data only, with no text. The domain has no
  i18n. T-044/T-047 should store or render a description from the line type, the VC number and the
  period through i18n keys.

**Rule interpretations (please check: `review: required`).** Precedence is BRD > PRD > PLAN. Where the
documents say nothing, I followed the PLAN text literally.
1. **The start takes effect at the start of its day.** Other status changes take effect at the end of
   theirs.
   - The start is the one exception to PLAN's "status changes take effect at the end of their effective
     day". It is forced by the consequence "Starts on the 1st before the run, so it is included in that
     month's run", and it matches the inclusive `'[]'` date range.
   - `activated` is treated as a marker of the start: it must fall on `startDate`, and it is allowed only
     once.
2. **A reactivation follows the literal rule.** "Reactivated effective the 1st" is **not** billed by that
   month's run, because the assignment is still suspended during the 1st. The §8.3 / D-18 mid-month hook
   decides instead. See Q-1.
3. **total_due = opening + charges, so it is a display snapshot, not a receivable.**
   - It equals the customer's ledger balance right after the invoice. It can be negative when credit is
     larger than the dues; it is never clamped.
   - This is consistent with T-041: outstanding = charges − allocations, and the opening balance stays
     owed on the earlier invoices it came from.
   - "Arrears remain" (RULE-08): a customer with nothing new to bill gets `nothing_to_bill`, and the old
     dues stay owed on the old invoices. No invoice is made just to repeat arrears (PLAN §8.2).
4. **Only debit adjustments become lines.** PLAN §8.2 says "+ pending debit adjustments", and credit
   adjustments are credit sources applied by T-041 `applyCredit` (PLAN §8.5). Passing a credit adjustment
   is **refused** rather than ignored, because putting it on the invoice would count it twice
   (invariant 3).
5. **The rent for P is the rental in effect at the end of P.** This is BRD §9 / BR-07 ("full new rental in
   the current month"). For T-045 this means that once P's invoice exists the run never re-bills P, so a
   change in P becomes the T-042 netting adjustment. A change recorded **before** P's invoice exists needs
   no adjustment, because the run will charge the new rental.
6. **A ₹0 rental still gives a ₹0 rent line, and an invoice if it is the only line.** PLAN §8.2 skips only
   when there are no lines. See Q-3.
7. **A pending debit adjustment for a later period than P is left pending.** It is not put on P's invoice
   (see Q-2). This can only happen when a missed month is billed late (D-25).

**Open questions for the reviewer / product owner**
- **Q-1 (affects T-034, T-045):** should a **reactivation** effective on the 1st count as active on the
  1st, like a start does?
  - Today it does not (literal PLAN). With `start_next_month` the customer then gets that month free.
  - The alternative is "turn-on changes take effect at the start of their day". It is a small change in
    `checkTimeline`, and the edge-case table test would flip.
  - Whichever is chosen, the T-045 hook must agree on whether "a reactivation effective the 1st" is
    mid-month.
- **Q-2 (affects T-044):** should a pending adjustment dated for a later period go on an earlier
  period's invoice when a missed run is done late? Today it waits for its own period's invoice. PLAN
  §8.2 doesn't filter by period.
- **Q-3:** should a customer whose only billable VC has a ₹0 rental get a ₹0 invoice (today: yes, as PLAN
  §8.2 says), or be skipped?
- **Q-4 (affects T-044, T-045; double-charge risk):** "Starts or reactivates on the 1st **after** the
  run".
  - `isBillable` says yes. If that customer has no invoice for P yet (their item failed, or they are new),
    a later retry or catch-up run bills the full month.
  - The D-18 hook must therefore not also create a full-month debit adjustment for P while P's invoice
    for that customer can still be created.
  - Suggested contract for T-045: adjust only for amounts that `buildInvoice(P)` for that customer will
    never charge, that is when P's invoice exists **or** P's run is completed and won't be retried for
    them.
- **Q-5 (affects T-022, T-034):** this assumes `end_date` = the disconnection's effective date (the last
  day of service, inclusive). If T-022/T-034 store an exclusive end instead, map it before calling.
  Otherwise `end_date_mismatch` is reported.

**Deviations / files outside the owned paths**
- `packages/domain/src/index.ts` (shared, T-024 is done): added `export * from "./billing";`. I rebased
  on T-042 and kept both lines.
- **Aligned with T-042:** `AdjustmentDirection` and `AdjustmentSource` are imported from
  `../adjustments` and not redefined, so `export *` has no duplicate names.
  - A stored T-042 **debit** `AdjustmentDraft` maps field for field onto `PendingAdjustment`.
  - **Credit** drafts are credit sources for T-041 `applyCredit`, and `buildInvoice` refuses them.
  - Both cases are tested with `planChangeForPeriod` in `invoice.test.ts`.
- The input is named `openingBalancePaise` instead of `openingBalance` (CLAUDE.md `*_paise` naming).
- Additions beyond the scope list, because "who is charged **what**" needs them: `rentalForPeriod`,
  `assignmentStatusOn` and `validateAssignmentTimeline`.

**Tests** (`packages/domain` after the rebase on T-042: 19 files, 373 tests; billing adds 3 files and
95 tests, about 2.5 s; each property test has an explicit 60 s timeout for busy machines)
- `eligibility.test.ts`:
  - The rule's two sentences and **every PLAN §8.1 consequence as a named test**, quoted word for word.
  - A 15-row edge-case table: the 1st/2nd, end of the previous month, reactivation on the 1st, same-day
    suspend + reactivate, end date without an event, and more.
  - Event-order independence, and `rentalForPeriod` cases: mid-month, last day, three changes in one
    month (PRD §15 #5), same day, ₹0.
  - Every validation reason.
- `invoice.test.ts`:
  - Multi-VC consolidation (PRD §15 #3), line order, plan-change rent and ₹0 lines.
  - Opening/total table: arrears, credit, and a negative total.
  - RULE-08 arrears, adjustments (included, adjustment-only invoice, later period left pending, credit
    refused) and nothing-to-bill cases.
  - Every refusal reason, and purity (deep-frozen input, same answer twice).
  - T-042 drafts:
    - A plan change after the Nov bill: Dec bills the new rent plus the Nov difference.
    - A plan change down produces a credit draft, which is refused as a line.
- `billing.property.test.ts` (fast-check, 2,000 runs each). The generator builds the **true day-by-day
  status** first and then derives the events, so the oracle shares no code with `timeline.ts`.
  - isBillable(P) ⇔ the 1st is active, checked over 40 periods. Coverage counters require more than 30
    hits each for: changes on the 1st, changes the day before, starts on the 1st, billed and not billed.
  - **It never bills an assignment disconnected before the period**: `isBillable` is false and
    `buildInvoice` returns `nothing_to_bill`.
  - Changes effective on or after the 1st never change P's answer.
  - `rentalForPeriod` matches an independent oracle.
  - **charges = Σ lines**, total = opening + charges, and there is exactly one rent line per billable
    assignment at its rental. The adjustment set is exactly the debit ones not after P.
  - The result does not depend on the order of assignments or adjustments.
- Mutation checks, done by hand and reverted:
  - Making status changes take effect at the start of their day fails 10 tests, including the oracle.
  - Taking the rental at the 1st instead of the end of P, together with dropping the later-period
    adjustment filter, fails 4 tests, including the invoice property.
- The T-024 `no-float` scan covers the new files and passes.

**Verification** (Node v24.21.0, pnpm 12.11.2): `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9),
`pnpm test` (9/9, including @cb/db against local Postgres 17), `pnpm build` (9/9), `pnpm generate` (no
diff), `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T11:55:32.848Z claimed by agent-t040
- 2026-10-13T12:08:55.243Z completed on task/T-040-domain-billing-eligibility-and-invoice-c
