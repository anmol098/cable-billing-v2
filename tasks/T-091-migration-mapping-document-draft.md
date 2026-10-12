---
id: T-091
title: Migration: mapping document draft
phase: 5
area: migration
status: todo
owner:
claimed_at:
branch:
depends_on: [T-090, T-023]
review: self
claimable_by: agent
size: M
paths: [docs/migration/mapping.md]
---

# T-091 — Migration: mapping document draft

**Phase** 5 · **Area** migration · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-090, T-023

## Goal

Every legacy column mapped to the new model, with open questions explicit.

## Scope

- Map operator, costumer, vc, invoice, ledger, lineman, plan, recharge (+ any others found) to target tables.
- Document money unit evidence, isReceipt semantics, status code mapping, date sentinels, password hash algorithm evidence, known limitations (assignment history).
- List decisions needed from the business (feeds H-06).

## Acceptance criteria

- [ ] Every legacy column appears with a target or an explicit 'not migrated' reason.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `docs/migration/mapping.md`

## Notes

- Needs profiling output from a run on the real dump (human-run T-090 tooling).

## References

PLAN §15 step 2, PRD §14, BRD §13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
