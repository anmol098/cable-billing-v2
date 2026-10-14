---
id: T-095
title: Load testing and performance budget
phase: 5
area: qa
status: claimed
owner: agent-t095
claimed_at: 2026-10-14T21:55:13.801Z
branch: task/T-095-load-testing-and-performance-budget
depends_on: [T-036, T-060, T-080]
review: self
claimable_by: agent
size: M
paths: [tools/load/**, docs/testing/performance.md]
---

# T-095 — Load testing and performance budget

**Phase** 5 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-036, T-060, T-080

## Goal

Prove p95 < 2 s for common lists/search at 10× legacy scale.

## Scope

- k6 (or similar) scripts for web search/lists, mobile roster sync, payment batch.
- Run against a staging Neon branch seeded with `10x`; document results and fixes.

## Acceptance criteria

- [ ] p95 < 2 s for listed operations; report committed.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/load/**`
- `docs/testing/performance.md`

## References

PRD §11 (Performance, Scale) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T21:55:13.801Z claimed by agent-t095
