---
id: T-045
title: Adjustments, plan change and mid-month start wiring
phase: 2
area: core
status: claimed
owner: agent-t045
claimed_at: 2026-10-14T05:19:39.880Z
branch: task/T-045-adjustments-plan-change-and-mid-month-st
depends_on: [T-042, T-034, T-023, T-041]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/adjustments/**, packages/core/src/connections/hooks/**, apps/web/src/app/(operator)/customers/[id]/connections/_plan-change/**, apps/web/src/app/(operator)/bills/adjustments/**]
---

# T-045 — Adjustments, plan change and mid-month start wiring

**Phase** 2 · **Area** core · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-042, T-034, T-023, T-041

## Goal

Changes after the bill create clear, auditable adjustments instead of edits.

## Scope

- Implement T-034 hooks: plan change → netting adjustment; start/reactivate mid-month → per operator policy.
- Owner manual adjustment (debit/credit, reason required) and guided back-dated change flow.
- Plan-change UI on a connection with an effect preview ('₹50 extra will be added to the next bill').
- Adjustments list page under Bills.

## Acceptance criteria

- [ ] No path edits an issued invoice.
- [ ] Credit adjustments are applied oldest-first (uses T-041).

## Tests required

- Integration scenarios for each row of PLAN §8.3; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/adjustments/**`
- `packages/core/src/connections/hooks/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/_plan-change/**`
- `apps/web/src/app/(operator)/bills/adjustments/**`

## References

PLAN §8.3, FR-008, BR-07, RULE-10, D-14, D-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T05:19:39.880Z claimed by agent-t045
