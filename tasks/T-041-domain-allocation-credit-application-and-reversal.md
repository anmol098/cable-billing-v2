---
id: T-041
title: Domain: allocation, credit application and reversal
phase: 2
area: domain
status: todo
owner:
claimed_at:
branch:
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/domain/src/allocation/**]
---

# T-041 — Domain: allocation, credit application and reversal

**Phase** 2 · **Area** domain · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Pure, provably-correct money allocation.

## Scope

- `allocate(amount, openInvoices)` oldest period first, invoice id tie-break, partial allowed, remainder = credit.
- `applyCredit(creditSources, openInvoices)` oldest source → oldest invoice.
- `reverse(payment, allocations)` → negative allocation rows.
- Invariant checker `checkLedger(state)` reused by the nightly job (T-052).

## Acceptance criteria

- [ ] Invariants 1–4 in PLAN §8.4 hold under fast-check with ≥ 10k random sequences.

## Tests required

- Property tests + edge cases (zero open invoices, exact pay-off, many tiny invoices).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/allocation/**`

## References

PLAN §8.4, PLAN §8.5, PLAN §8.6, FR-014, RULE-11, RULE-12, RULE-13, BR-09, BR-13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
