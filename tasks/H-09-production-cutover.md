---
id: H-09
title: Production cutover
phase: 6
area: human
status: todo
owner:
claimed_at:
branch:
depends_on: [H-08, H-06, T-096]
review: self
claimable_by: human
size: M
paths: [docs/runbooks/cutover.md]
---

# H-09 — Production cutover

**Phase** 6 · **Area** human · **Size** M · **Review** self · **Claimable by** human · **Depends on** H-08, H-06, T-096

## Goal

Switch operators to the new system safely.

## Scope

- Freeze legacy writes → final import → reconcile → sign-off → go live → hypercare through first billing cycle; legacy DB kept read-only (Q-07).

## Acceptance criteria

- [ ] Formal sign-off from business and engineering.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `docs/runbooks/cutover.md`

## References

BRD §10.5, PLAN §15 step 6 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
