---
id: T-042
title: Domain: plan-change netting and mid-month start policy
phase: 2
area: domain
status: done
owner: agent-t042
claimed_at: 2026-10-13T11:55:19.689Z
branch: task/T-042-domain-plan-change-netting-and-mid-month
depends_on: [T-024]
review: required
claimable_by: agent
size: S
paths: [packages/domain/src/adjustments/**]
---

# T-042 — Domain: plan-change netting and mid-month start policy

**Phase** 2 · **Area** domain · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Compute the exact adjustment for changes after the month's bill.

## Scope

- `planChangeAdjustment({ chargedSoFar, newAmount })` → debit/credit/none.
- `midMonthStartAdjustment({ policy, rental, startedAfterRun })` for `charge_full_month` vs `start_next_month`.
- Netting across repeated changes within one period.

## Acceptance criteria

- [x] Three plan changes in one month end with total charged = latest plan amount (PRD §15 #5).

## Tests required

- Table-driven + property tests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/adjustments/**`

## References

PLAN §8.3, D-14, D-18, FR-008, BR-07, RULE-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/domain/src/adjustments/**`, all exported from `@cb/domain`). These are pure
functions: no I/O, no clock, no Node built-ins. All money goes through T-024's `Paise` and its checked
helpers. Nothing is prorated or rounded, so whole-rupee inputs always give whole-rupee outputs (D-17).
Expected failures come back as `Result` errors. Inputs are never mutated.

*The two rules from the task scope* (only the arithmetic):
- `planChangeAdjustment({ chargedSoFarPaise, newAmountPaise })` → `Result<AdjustmentOutcome, AdjustmentError>`.
  The result is `newAmount − chargedSoFar`: a `debit` if positive, a `credit` if negative, and
  `{ kind: "none", reason: "same_amount" }` if zero. `VALIDATION` if either amount is negative or not an
  integer.
- `midMonthStartAdjustment({ policy, rentalPaise, startedAfterRun })` → `Result<AdjustmentOutcome, AdjustmentError>`:
  - `startedAfterRun: false` → `none / billed_by_run`.
  - `start_next_month` → `none / start_next_month`.
  - `charge_full_month` with a ₹0 rental → `none / zero_rental`.
  - Otherwise → `debit` for the **full** rental.
  - `VALIDATION` for an unknown policy, a negative rental, or a flag that is not a boolean.
- `AdjustmentOutcome = { kind: "none", reason: NoAdjustmentReason } | { kind: "debit" | "credit", amountPaise }`.
  `amountPaise` is always > 0. `signedAdjustmentPaise(outcome)` returns +debit, −credit, or 0.
  `NoAdjustmentReason` is one of `same_amount | not_billed_this_period | billed_by_run | start_next_month | already_charged | zero_rental`.
  These are stable codes, so the UI can map each one to an i18n key.

*Use these in services (T-045)*: they work out "charged so far" from the stored rows and return the row
to insert.
- `planChangeForPeriod({ assignmentId, period, records, newAmountPaise })` and
  `midMonthStartForPeriod({ assignmentId, period, records, policy, rentalPaise, startedAfterRun })`
  return `Result<AdjustmentDecision, AdjustmentError>`.
- `AdjustmentDecision = { outcome, draft: AdjustmentDraft | null, chargedBeforePaise, chargedAfterPaise }`.
  The two amounts are for the effect preview: "₹50 extra will be added to the next bill" / "this month
  becomes ₹450".
- `AdjustmentDraft = { assignmentId, period, direction, amountPaise, source: "plan_change" | "mid_month_start" }`.
  It maps one-to-one onto an `adjustments` row. The service adds operator, customer, reason and
  created_by.
- `period` = `periodOf(effectiveDate)`, the month whose rent is being corrected.
- `records: RentalChargeRecord[]` is **every** row for this assignment and period, in any order:
  - `{ kind: "rent", id, assignmentId, period, amountPaise }`: the assignment's `invoice_lines` row of
    type `rent` on the customer's regular invoice for that period.
  - `{ kind: "adjustment", id, assignmentId, period, direction, amountPaise, source }`: every
    `adjustments` row with that `assignment_id` and `period`, whether pending or already invoiced.
- The functions validate that every record matches the assignment and period, and that no id
  repeats. They never filter records out silently.
- `rentalChargedSoFar({ assignmentId, period, records })` → `{ charged, baseCharge: "rent" | "mid_month_start" | null, chargedSoFarPaise, notNettedIds }`.
  This is the "charged for this assignment+period so far" from PLAN §8.3. Rent comes from exactly one
  **base charge** (the run's rent line, or a `mid_month_start` debit), plus the signed `plan_change`
  corrections.
- Errors from these functions:
  - `INVARIANT_VIOLATION`: two base charges (rent charged twice), a `mid_month_start` credit,
    `plan_change` rows with no base charge, or rent that nets below zero. This module never produces
    these states, so treat each as a bug and alert.
  - `VALIDATION`: malformed or mismatched records.
- Constants: `ADJUSTMENT_DIRECTIONS`, `ADJUSTMENT_SOURCES`, `RENTAL_ADJUSTMENT_SOURCES`
  (`plan_change`, `mid_month_start`), `MID_MONTH_START_POLICIES`.

**How T-045 should use it** (inside the customer's transaction, after locking `customer_balances`)
- Plan change: load the records, then call `planChangeForPeriod`. If `draft` is set, insert it with
  source `plan_change`. Netting is idempotent: once the draft is stored, a retry with the same amount
  returns `same_amount`. A plan change in a month the connection has no rent for returns
  `not_billed_this_period`, and the next run bills the new amount.
- Start / reactivation: call `midMonthStartForPeriod` with the operator's `mid_month_start_policy`. If
  the connection already has rent for that month (billed on the 1st, then suspended and reactivated;
  or a retry), it returns `already_charged`. That prevents a double charge.
- **Debit drafts** stay pending (`invoice_id` null). The next bill picks them up as
  `type = adjustment` lines (PLAN §8.2). T-040's `buildInvoice({ pendingAdjustments })` should take
  only **debit** adjustments as lines, using `amountPaise` as the line amount and `adjustment_id` for
  attribution.
- **Credit drafts** are credit sources (PLAN §7.2, §8.5). They get a `credit_adjustment` ledger entry
  (−amount, per invariant 3). T-041's `applyCredit` uses them as
  `CreditSource { sourceType: "credit_adjustment", availablePaise: unallocatedRemainder(...) }`.
- **T-041 Q-A (does a debit adjustment hit the ledger on creation, or only through the next invoice's
  charges?) can be answered either way.** Netting reads `adjustments` rows, pending and invoiced alike,
  and never reads the ledger. The drafts don't prescribe any ledger effect. `signedAdjustmentPaise` is
  the amount for either answer: a `debit_adjustment` entry now, or a line in the next invoice's charges.
  Whichever is chosen, a debit must reach the ledger **once**.

**Rule interpretations (please check: `review: required`)**. Precedence: BRD > PRD > PLAN.
1. **What counts as "charged so far"** (PLAN §8.3 "incl. earlier adjustments"): the period's rent line
   plus that period's `plan_change` and `mid_month_start` adjustments, pending or invoiced.
   **`manual` and `migration` adjustments are not netted.** A later plan change leaves an Owner's
   discount or correction in place instead of cancelling it. Reason: BRD §9 / BR-07 say the full new
   monthly *rental* applies, and a manual adjustment isn't rental. To net every adjustment instead,
   add the sources to `RENTAL_ADJUSTMENT_SOURCES` (one line). The case "₹400 billed, ₹50 manual
   discount, upgrade to ₹500" gives +₹100 now; the literal reading would give +₹150.
2. **A plan change with no rent for the period yet** returns `not_billed_this_period`, not a debit
   for the full amount. This covers: before the run, a `start_next_month` connection in its first
   month, and a connection suspended on the 1st. PLAN §8.3 is about changes *after* the bill. The run
   (or the next one) charges the new amount.
3. **Mid-month start never charges a connection that already has rent for the period**
   (`already_charged`). D-18's "charge full month" would otherwise double-charge a reactivation in a
   month that was already billed (PRD §15 #5, FR-008).
4. **Netting is append-only.** "Change back" produces a credit that offsets the earlier pending debit,
   rather than deleting that debit. Both stay visible and auditable (BRD §9 "Financial corrections").
5. **No proration anywhere** (BRD §9, BR-07, D-18 "full month").

**Open questions for the reviewer**
- Q-1: Interpretation 1. Should manual/migration adjustments for the same connection and month be
  netted by a later plan change?
- Q-2 (T-045/T-044): what exactly is `startedAfterRun`? The doc comment defines it as "this period's
  run will not charge the connection": the start is after the 1st, or it is on the 1st after the run
  already processed this customer. Two races need T-044/T-045 to agree:
  - A connection added on the 1st after the 00:15 run, for a customer the run skipped ("nothing to
    bill") or never saw (a new customer). If `startedAfterRun: true` creates a mid-month debit and
    the Owner later re-runs the period, the run must not add a rent line too. `rentalChargedSoFar`
    would then report `INVARIANT_VIOLATION`.
  - Suggested rule: the run skips assignments that already have a `mid_month_start` adjustment for
    the period.
- Q-3 (T-040/T-044): for a **late or missed run** (D-25 catch-up), a plan change made before the
  run gives `not_billed_this_period`. BR-07 then only holds if the run bills the rental in force
  **when it runs** (the latest amount), not the rental on the 1st. Please confirm for `buildInvoice`.
- Q-4: ₹0 rentals. A `charge_full_month` start at ₹0 stores nothing (an adjustment needs an amount
  > 0). A same-month upgrade from ₹0 then returns `not_billed_this_period`, so the new amount starts
  next month. A connection the run billed at ₹0 nets normally, but only if T-040 writes ₹0 rent
  lines; this module accepts rent lines ≥ 0. Rare (free connections), but say if it matters.
- Q-5: migrated months. A connection whose current month came in only as an `opening_balance`
  invoice has no rent line, so a plan change that month returns `not_billed_this_period`.
- Q-6: `mid_month_start_policy` has no default in the docs. T-030 (settings) has to choose one.

**Deviations / files outside the owned paths**
- `packages/domain/src/index.ts` (shared): added `export * from "./adjustments";`. T-040 adds its own
  line here too; keep both on rebase.
- No dependency changes (`fast-check` was already added by T-024).

**Tests** (`packages/domain/src/adjustments`: 3 files, 59 tests, about 1 s)
- `netting.property.test.ts` (**acceptance**): 5,000 random months for one connection. Three
  scenarios:
  - active on the 1st, with the billing run at a random point before, between or after the changes,
    or not at all;
  - a mid-month start under either policy;
  - not billable this month.
- Each scenario runs 1–12 random steps: plan changes (whole rupees and raw paise, many repeats),
  retries, Owner manual adjustments, and reactivations. The records are handed over in a random order
  every call. The model stores only drafts returned by the functions, plus the run's rent line at the
  then-current rental.
- After every charged change, the month's rent equals the new amount. Every adjustment is exactly
  |new − before| and > 0, with the right direction. At the end:
  - if charged: rent equals the **latest plan amount**;
  - if not charged: no `plan_change` row exists;
  - there is at most one base charge;
  - manual rows are untouched and reported as not netted;
  - with whole-rupee inputs, every adjustment is whole rupees.
- Coverage counters require every path to run more than 100 times (debit, credit, same, not billed,
  run after changes, mid-month charge, ≥ 3 changes, reactivation charged / already charged).
- A second property (2,000 runs) checks that the result doesn't depend on record order.
- `plan-change.test.ts`:
  - The named acceptance case: ₹400 billed → ₹500 → ₹300 → ₹450 gives +100, −200, +150; total
    ₹450; the rent line is untouched.
  - Upgrade, downgrade, same amount, change back, idempotent retry, not yet billed,
    start_next_month then a change, charge_full_month then changes, pending + invoiced adjustments
    both counted, manual/migration left standing, ₹0 and back, order independence, frozen input,
    exact paise.
  - 14 error cases (`VALIDATION` and `INVARIANT_VIOLATION`).
- `mid-month-start.test.ts`:
  - The policy table (both policies × before/after run, ₹0) and the full month in exact paise.
  - `already_charged` for a reactivation in an already billed month, a second reactivation or
    retry, and a reactivation after a plan change.
  - A manual adjustment is not rent. Validation cases.
- Mutation checks, done by hand and reverted:
  - Ignoring earlier `plan_change` rows in `rentalChargedSoFar`: 12 tests fail, including both
    properties.
  - Dropping the `already_charged` guard: 4 fail, including the main property.

**Verification** (Node v24.21.0, pnpm 12.11.2, local Postgres 17): `pnpm install --frozen-lockfile`,
`pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; domain 16 files / 278 tests; db 52 tests),
`pnpm build` (9/9), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T11:55:19.690Z claimed by agent-t042
- 2026-10-13T12:06:13.974Z completed on task/T-042-domain-plan-change-netting-and-mid-month
