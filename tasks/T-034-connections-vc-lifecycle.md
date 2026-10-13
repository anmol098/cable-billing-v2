---
id: T-034
title: Connections (VC) lifecycle
phase: 1
area: web
status: claimed
owner: agent-t034
claimed_at: 2026-10-13T19:47:14.429Z
branch: task/T-034-connections-vc-lifecycle
depends_on: [T-033]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/connections/**, apps/web/src/app/(operator)/customers/[id]/connections/**, apps/web/src/app/(operator)/customers/new/_steps/connections/**, packages/i18n/messages/*/connections.json]
---

# T-034 — Connections (VC) lifecycle

**Phase** 1 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-033

## Goal

Add VCs to customers and change their status with effective dates, keeping full history.

## Scope

- Services: add assignment (find-or-create VC asset, plan or custom amount, start date), suspend, reactivate, disconnect (effective date, reason), reassign a disconnected VC to a new customer (new assignment), timeline query.
- Emits domain hooks `onAssignmentStarted/Reactivated/PlanChanged` (no-op default) that T-045 implements for adjustments.
- UI: Connections tab with timeline, status actions via ConfirmSheet with plain-language effect ('Rent stops from November. ₹450 old due stays.'), stepper step 2 in add-customer.
- Effective-date rules: Staff cannot back-date into an already-billed period (Owner flow handled in T-045).

## Acceptance criteria

- [ ] VC reuse keeps old assignment and charges with the old customer (PRD §15 #6).
- [ ] Invalid transitions (e.g. reactivate a disconnected assignment) are rejected.

## Tests required

- Service tests for every transition; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/connections/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/**`
- `apps/web/src/app/(operator)/customers/new/_steps/connections/**`
- `packages/i18n/messages/*/connections.json`

## References

FR-005, FR-006, BR-03, BR-04, RULE-06, RULE-07, J-02, J-06, PLAN §8.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T19:47:14.430Z claimed by agent-t034
