---
id: T-046
title: Payment posting and reversal service
phase: 2
area: core
status: claimed
owner: agent-t046
claimed_at: 2026-10-13T13:12:10.124Z
branch: task/T-046-payment-posting-and-reversal-service
depends_on: [T-041, T-023, T-025]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/payments/**, packages/core/src/receipts/numbering/**]
---

# T-046 — Payment posting and reversal service

**Phase** 2 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-041, T-023, T-025

## Goal

One idempotent path that every payment (web counter, Android, migration) goes through.

## Scope

- `postPayment(cmd)` exactly per PLAN §8.4: idempotency on client id (same payload → same result; different → ID_REUSED_WITH_DIFFERENT_DATA), row lock on customer_balances, allocation, ledger, receipt number `R-YYMM-NNNNN` + provisional alias, collection session totals update, review flags (inactive customer/lineman, clock skew > 10 min future or > 7 days old).
- `reversePayment(paymentId, reason)` Owner only (PLAN §8.6).
- Returns `{ payment, allocations, receipt, newBalance, credit }` used by web and mobile.

## Acceptance criteria

- [ ] 10 concurrent identical posts create exactly one payment and one receipt (PRD §15 #8 server side).
- [ ] Reversal never mutates original rows.

## Tests required

- Integration + concurrency tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/payments/**`
- `packages/core/src/receipts/numbering/**`

## References

PLAN §8.4, PLAN §8.6, PLAN §10.4, FR-013, FR-014, FR-016, FR-017, RULE-16, RULE-17, RULE-20, BR-10, BR-13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:12:10.125Z claimed by agent-t046
