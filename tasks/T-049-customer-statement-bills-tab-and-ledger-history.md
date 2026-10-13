---
id: T-049
title: Customer statement, bills tab and ledger history
phase: 2
area: web
status: claimed
owner: agent-t049
claimed_at: 2026-10-13T20:30:55.113Z
branch: task/T-049-customer-statement-bills-tab-and-ledger
depends_on: [T-044, T-046, T-033]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/customers/[id]/bills/**, apps/web/src/app/(operator)/customers/[id]/history/**, packages/core/src/statements/**, packages/i18n/messages/*/statements.json]
---

# T-049 — Customer statement, bills tab and ledger history

**Phase** 2 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-033

## Goal

'What was charged, paid, adjusted and remains due?' answered on one screen.

## Scope

- Bills tab, History tab (ledger lines with running balance), downloadable statement PDF for a date range.
- Totals reconcile to customer_balances.

## Acceptance criteria

- [ ] Statement closing balance equals customer balance for 'as of now'.

## Tests required

- Service tests on seeded scenarios; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/customers/[id]/bills/**`
- `apps/web/src/app/(operator)/customers/[id]/history/**`
- `packages/core/src/statements/**`
- `packages/i18n/messages/*/statements.json`

## References

B-009, FR-011, BRD §12 (Customer account statement) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T20:30:55.114Z claimed by agent-t049
