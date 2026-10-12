---
id: T-048
title: Counter payments, payment register and reversals UI
phase: 2
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-046, T-033]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/payments/**, apps/web/src/app/(operator)/customers/[id]/payments/**, apps/web/src/components/payments/**, packages/i18n/messages/*/payments.json]
---

# T-048 — Counter payments, payment register and reversals UI

**Phase** 2 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-046, T-033

## Goal

Office staff take payments at the counter in four taps.

## Scope

- Take payment: customer search → amount (pre-filled with due) → Cash/UPI tiles (+ optional UPI ref) → confirm → success with receipt actions (print A5, copy preview link).
- Payment register with filters (date, collector, method, status), payments-needing-review list with resolve action.
- Owner reversal flow with reason and plain-language effect.
- Customer Payments tab.

## Acceptance criteria

- [ ] Double-click on Save cannot create two payments (client-generated id reused).

## Tests required

- Playwright counter payment; component tests for the flow.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/payments/**`
- `apps/web/src/app/(operator)/customers/[id]/payments/**`
- `apps/web/src/components/payments/**`
- `packages/i18n/messages/*/payments.json`

## References

FR-013, FR-014, BR-13, PLAN §12.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
