---
id: T-045b
title: Plain add or start again into a month whose billing run has already passed
phase: 2
area: core
status: todo
owner:
claimed_at:
branch:
depends_on: [T-045a]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/connections/hooks/**, packages/core/src/adjustments/apply.ts, packages/core/src/connections/rules.ts]
---

# T-045b — Plain add or start again into a month whose billing run has already passed

**Phase** 2 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-045a

## Goal

A connection added (or started again) by Owner or Staff through the ordinary `connections.add` /
`connections.reactivate` is never left uncharged for a month whose billing run has already been,
without the customer.

## The gap (found in the T-045a review)

T-034's back-dating rule only refuses a start that reaches before the customer's **latest billed
month** (a regular bill, or a run item `created` / `already_exists` / `skipped`). A completed run
never comes back (T-044, D-25), and `candidateCustomers` only takes customers that had a connection
or a pending debit on the 1st. So:

- a start **on the 1st** of month P entered after P's run completed (or after a running run's cursor
  passed the customer), for a customer that run never looked at: the T-045 hook says
  `billed_by_run` (the month "is not billed yet"), so P is never charged — PLAN §8.1 says it must be
  (active on the 1st → full rent), whatever the D-18 policy;
- a start in month P with a **later** month Q whose run has passed without the customer (e.g. the
  customer's only connection was removed before Q, Q's run completed, then a connection starting in
  P is added): Q is never charged, because `connections.add` does not see Q as billed for the
  customer.

T-045a closed this for the Owner's back-dated flow (`adjustments.back_dated_add`): its
`coveredPeriods` / `planOfAdd` (`packages/core/src/adjustments/back-dated-add/months.ts`) count a
month as covered when it is billed for the customer **or** has a billing run that is not `skipped`,
and charge every covered month explicitly (`mid_month_start` debit; T-044's per-period guard then
never adds a rent line as well).

## Scope

- Use T-045a's `coveredPeriods` / `planOfAdd` in the plain add (and the "start again" reactivation:
  the same question for the reactivated months) so such a start either:
  - is refused with `billed_period` (Staff, and the Owner outside the guided flow) and routed to the
    Owner's back-dated flow, which already charges it — **preferred**, keeps "explicit adjustment
    with a reason" (PLAN §8.3); or
  - charges the covered months automatically in the hook (decide with the product owner).
- Update the effect texts / previews accordingly (T-034 `_parts/effect.ts`, T-045 preview).

## Acceptance criteria

- [ ] After P's run completed without the customer, a plain add starting on 1 P (or earlier, with a
      later covered month) never leaves a covered month uncharged; each month is charged once,
      billing it again adds nothing; `checkLedger` clean; no issued bill changes.

## Tests required

- Integration: the two cases above, with a completed run and with a running run whose cursor has
  passed the customer; isolation cases if a service changes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/connections/hooks/**`
- `packages/core/src/adjustments/apply.ts`
- `packages/core/src/connections/rules.ts`

## References

PLAN §8.1, §8.3, D-18, D-25, T-034 / T-044 / T-045 / T-045a completion notes.

## Completion notes

_The agent fills this in before opening the PR._

## Board log
