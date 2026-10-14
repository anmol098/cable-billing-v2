---
id: T-045a
title: Owner back-dated new connection (start dated into a billed month)
phase: 2
area: core
status: claimed
owner: agent-t045a
claimed_at: 2026-10-14T14:00:30.496Z
branch: task/T-045a-owner-back-dated-new-connection-start-da
depends_on: [T-045]
review: required
claimable_by: agent
size: S
paths: [packages/core/src/adjustments/back-dated-add/**, apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**]
---

# T-045a — Owner back-dated new connection (start dated into a billed month)

**Phase** 2 · **Area** core · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-045

## Goal

The Owner can add a connection that really started in a month whose bills are already made, with
an explicit bill change for every billed month (PLAN §8.3 "back-dated effective date").

## Scope

- A service (capability `adjustments.manage`) that calls T-034's `addConnectionInTx(…, { allowBilledPeriod: true })`
  inside `collectChangeMonth` and then T-045's `adjustLaterMonths` (kind `start`), with the Owner's
  reason on every adjustment, plus one `adjustments.back_dated_change` audit event; a preview the
  same way (`changeMonthEffect` / `laterMonthEffect` on the would-be timeline).
- The "Add connection" form (T-034): for the Owner, a start date in a billed month shows the
  per-month effect and asks for a reason instead of refusing with `billed_period`.

## Out of scope

- Plan changes and stop / start again / remove dated back (done in T-045).

## Acceptance criteria

- [ ] A start dated two billed months back charges the start month per the D-18 policy and each
      later billed month its full rent, once; billing those months again adds nothing.
- [ ] Staff are still refused (`billed_period`); no issued bill or line changes; `checkLedger` clean.

## Tests required

- Integration scenarios (both policies, a later billed month that was skipped), isolation cases, a
  Playwright flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/adjustments/back-dated-add/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/_backdated-add/**`

## References

PLAN §8.3, D-18, T-034 / T-045 completion notes — see `docs/IMPLEMENTATION_PLAN.md`.

## Completion notes

_The agent fills this in before opening the PR._

## Board log

- 2026-10-14T14:00:30.496Z claimed by agent-t045a
