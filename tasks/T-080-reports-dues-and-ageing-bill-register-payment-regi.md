---
id: T-080
title: Reports: dues and ageing, bill register, payment register
phase: 4
area: web
status: claimed
owner: agent-t080
claimed_at: 2026-10-14T04:25:46.155Z
branch: task/T-080-reports-dues-and-ageing-bill-register-pa
depends_on: [T-044, T-046, T-029]
review: self
claimable_by: agent
size: M
paths: [packages/core/src/reports/dues/**, packages/core/src/reports/registers/**, apps/web/src/app/(operator)/reports/dues/**, apps/web/src/app/(operator)/reports/bills/**, apps/web/src/app/(operator)/reports/payments/**, packages/i18n/messages/*/reports.json]
---

# T-080 — Reports: dues and ageing, bill register, payment register

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-029

## Goal

Money reports whose totals always match the ledger.

## Scope

- Dues list + ageing buckets 0–30/31–60/61–90/90+ by area.
- Bill register, payment register (method, collector, sync/posting/review status).
- Each report shows its 'as of' time and totals row.

## Acceptance criteria

- [ ] Report totals equal ledger totals for the same filters (automated test).

## Tests required

- Reconciliation tests on seeded data; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/reports/dues/**`
- `packages/core/src/reports/registers/**`
- `apps/web/src/app/(operator)/reports/dues/**`
- `apps/web/src/app/(operator)/reports/bills/**`
- `apps/web/src/app/(operator)/reports/payments/**`
- `packages/i18n/messages/*/reports.json`

## References

FR-023, BRD §12 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T04:25:46.155Z claimed by agent-t080
