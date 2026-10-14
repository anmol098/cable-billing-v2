---
id: T-081
title: Reports: daily collections, handover, connection status, billing runs
phase: 4
area: web
status: claimed
owner: agent-t081
claimed_at: 2026-10-14T08:08:30.046Z
branch: task/T-081-reports-daily-collections-handover-conne
depends_on: [T-062, T-044, T-034]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/reports/operations/**, apps/web/src/app/(operator)/reports/collections/**, apps/web/src/app/(operator)/reports/handover/**, apps/web/src/app/(operator)/reports/connections/**, apps/web/src/app/(operator)/reports/billing-runs/**]
---

# T-081 — Reports: daily collections, handover, connection status, billing runs

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-062, T-044, T-034

## Goal

Operational reports from BRD §12.

## Scope

- Daily lineman collections (cash/UPI split), cash handover reconciliation, connection status/rental report, billing-run report (created/skipped/failed with reasons).

## Acceptance criteria

- [ ] Cash and UPI always separate columns.

## Tests required

- Report query tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/reports/operations/**`
- `apps/web/src/app/(operator)/reports/collections/**`
- `apps/web/src/app/(operator)/reports/handover/**`
- `apps/web/src/app/(operator)/reports/connections/**`
- `apps/web/src/app/(operator)/reports/billing-runs/**`

## References

FR-023, BRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T08:08:30.047Z claimed by agent-t081
