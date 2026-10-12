---
id: T-094
title: Migration: reconciliation report and admin screen
phase: 5
area: migration
status: todo
owner:
claimed_at:
branch:
depends_on: [T-093, T-086]
review: self
claimable_by: agent
size: M
paths: [tools/migration/src/reconcile/**, apps/web/src/app/admin/migration/**]
---

# T-094 — Migration: reconciliation report and admin screen

**Phase** 5 · **Area** migration · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-093, T-086

## Goal

Evidence for business sign-off.

## Scope

- Source vs target counts and ₹ totals by operator and period, exception register by category, rounding differences list.
- Admin screen + export for sign-off.

## Acceptance criteria

- [ ] Report reproduces exactly on re-run.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/migration/src/reconcile/**`
- `apps/web/src/app/admin/migration/**`

## References

PLAN §15 step 4, PRD §14 validation table, BRD §15 (Migration) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
