---
id: T-042
title: Domain: plan-change netting and mid-month start policy
phase: 2
area: domain
status: todo
owner:
claimed_at:
branch:
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

- [ ] Three plan changes in one month end with total charged = latest plan amount (PRD §15 #5).

## Tests required

- Table-driven + property tests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/adjustments/**`

## References

PLAN §8.3, D-14, D-18, FR-008, BR-07, RULE-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
