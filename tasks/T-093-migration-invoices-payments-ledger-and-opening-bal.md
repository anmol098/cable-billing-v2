---
id: T-093
title: Migration: invoices, payments, ledger and opening balances
phase: 5
area: migration
status: todo
owner:
claimed_at:
branch:
depends_on: [T-092, T-023, T-041, T-046]
review: required
claimable_by: agent
size: L
paths: [tools/migration/src/transform/financial/**]
---

# T-093 — Migration: invoices, payments, ledger and opening balances

**Phase** 5 · **Area** migration · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-092, T-023, T-041, T-046

## Goal

Financial history imported and balances reconciled to the legacy system.

## Scope

- Invoices with legacy numbers preserved; orphan/null customer invoices → exceptions.
- Payments/receipts per mapping doc through the same posting rules (source = migration, no counters consumed for legacy receipts).
- Float → paise with agreed rounding; per-customer opening balance entries.

## Acceptance criteria

- [ ] Per-operator invoice/payment/outstanding totals within agreed tolerance (Q-08).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/migration/src/transform/financial/**`

## References

PLAN §15 step 3, PRD §14, BRD §13, RULE-21 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
