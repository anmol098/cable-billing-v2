---
id: T-044
title: Billing run service (preview, run, retry, catch-up)
phase: 2
area: core
status: claimed
owner: agent-t044
claimed_at: 2026-10-13T13:37:57.794Z
branch: task/T-044-billing-run-service-preview-run-retry-ca
depends_on: [T-040, T-041, T-043, T-023]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/billing/**, apps/web/src/app/api/cron/billing-scheduler/**]
---

# T-044 — Billing run service (preview, run, retry, catch-up)

**Phase** 2 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-040, T-041, T-043, T-023

## Goal

Monthly bills are generated exactly once per customer per month.

## Scope

- `previewBillingRun(period)` (read-only, totals + problems), `startBillingRun(period, trigger)`, batch job handler (200 customers/tx), `retryFailedItems(runId)`.
- Invoice numbering via counters (`INV-YYMM-NNNNN`), invoice + lines + ledger + customer_balances update + credit application in one tx per customer.
- Scheduler cron: on IST day 1 enqueue runs for billable tenants; other days catch up missing runs for the current period; read_only tenants recorded as skipped.
- `missedRuns(operator)` lists skipped periods for manual run after reactivation (never automatic, D-25).

## Acceptance criteria

- [ ] Running the same period twice concurrently creates no duplicates (PRD §15 #4).
- [ ] Opening balance of period N+1 = closing balance of N (FR-012).

## Tests required

- Integration tests with seeded scenarios; concurrency test; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/billing/**`
- `apps/web/src/app/api/cron/billing-scheduler/**`

## References

PLAN §8.2, PLAN §14, FR-009, FR-011, FR-012, J-03, B-006, D-13, D-25 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:37:57.794Z claimed by agent-t044
