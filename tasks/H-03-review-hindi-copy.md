---
id: H-03
title: Review Hindi copy
phase: 3
area: human
status: todo
owner:
claimed_at:
branch:
depends_on: [T-065, T-066, T-070, T-048]
review: self
claimable_by: human
size: M
paths: [packages/i18n/messages/hi/**]
---

# H-03 — Review Hindi copy

**Phase** 3 · **Area** human · **Size** M · **Review** self · **Claimable by** human · **Depends on** T-065, T-066, T-070, T-048

## Goal

Natural, simple Hindi that linemen and operators understand.

## Scope

- Review every `_review`-flagged string, fix wording, clear the flags.
- Repeat for later namespaces as they land.

## Acceptance criteria

- [ ] No `_review` flags left in shipped namespaces.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/i18n/messages/hi/**`

## References

D-23 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
