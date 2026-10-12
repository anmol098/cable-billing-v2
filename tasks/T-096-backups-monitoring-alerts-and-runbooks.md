---
id: T-096
title: Backups, monitoring alerts and runbooks
phase: 5
area: infra
status: todo
owner:
claimed_at:
branch:
depends_on: [T-011, T-043]
review: self
claimable_by: agent
size: M
paths: [.github/workflows/backup.yml, docs/runbooks/**]
---

# T-096 — Backups, monitoring alerts and runbooks

**Phase** 5 · **Area** infra · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-011, T-043

## Goal

We can recover from failure and know when something breaks.

## Scope

- Nightly encrypted pg_dump to object storage (30-day retention) + monthly restore drill procedure with invariants check and `restore-log.md`.
- Sentry alert rules, uptime check, billing-failure and sync-spike alerts documented.
- Runbooks: billing run failure, stuck sync, support access, restore, cutover, rollback.

## Acceptance criteria

- [ ] One documented successful restore drill into a scratch branch.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `.github/workflows/backup.yml`
- `docs/runbooks/**`

## Notes

- Bucket/credentials come from H-01.

## References

PLAN §17, PRD §15 #14, BRD §15 (Operational readiness) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
