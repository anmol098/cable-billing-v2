---
id: T-040
title: Domain: billing eligibility and invoice calculation
phase: 2
area: domain
status: claimed
owner: agent-t040
claimed_at: 2026-10-13T11:55:32.848Z
branch: task/T-040-domain-billing-eligibility-and-invoice-c
depends_on: [T-024]
review: required
claimable_by: agent
size: M
paths: [packages/domain/src/billing/**]
---

# T-040 — Domain: billing eligibility and invoice calculation

**Phase** 2 · **Area** domain · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-024

## Goal

Pure functions deciding who is charged what for a month.

## Scope

- `isBillable(assignmentTimeline, period)` implementing 'active at any time on the 1st; status changes take effect at the end of their effective day'.
- `buildInvoice({ customer, assignments, pendingAdjustments, openingBalance, period })` → lines + totals (charges, total_due) or `nothing_to_bill`.
- Every consequence listed in PLAN §8.1 is a named test case.

## Acceptance criteria

- [ ] Functions are pure (no I/O, no Date.now()).
- [ ] Multi-VC customers get one consolidated set of lines (PRD §15 #3).

## Tests required

- Table-driven unit tests + fast-check properties (charges = Σ lines; never bills a disconnected-before-period assignment).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/domain/src/billing/**`

## References

PLAN §8.1, PLAN §8.2, FR-009, FR-010, RULE-04, RULE-05, RULE-08, RULE-09, B-006 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T11:55:32.848Z claimed by agent-t040
