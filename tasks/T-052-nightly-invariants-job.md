---
id: T-052
title: Nightly invariants job
phase: 2
area: core
status: claimed
owner: agent-t052
claimed_at: 2026-10-13T14:46:56.987Z
branch: task/T-052-nightly-invariants-job
depends_on: [T-043, T-044, T-046]
review: self
claimable_by: agent
size: S
paths: [packages/core/src/invariants/**, apps/web/src/app/api/cron/invariants/**]
---

# T-052 — Nightly invariants job

**Phase** 2 · **Area** core · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-043, T-044, T-046

## Goal

Detect any accounting drift the same night.

## Scope

- Per tenant: Σ ledger = customer_balances, allocations ≤ sources, no overlapping assignments, invoice uniqueness; store results; alert on breach.

## Acceptance criteria

- [ ] Injected corruption in a test DB is reported.

## Tests required

- Integration test with deliberately broken data.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/invariants/**`
- `apps/web/src/app/api/cron/invariants/**`

## References

PLAN §14, PLAN §8.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T14:46:56.988Z claimed by agent-t052
