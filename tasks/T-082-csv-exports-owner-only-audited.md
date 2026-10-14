---
id: T-082
title: CSV exports (Owner only, audited)
phase: 4
area: web
status: claimed
owner: agent-t082
claimed_at: 2026-10-14T13:27:14.299Z
branch: task/T-082-csv-exports-owner-only-audited
depends_on: [T-080, T-081]
review: self
claimable_by: agent
size: S
paths: [packages/core/src/exports/**, apps/web/src/app/(operator)/reports/_export/**, apps/web/src/app/api/exports/**]
---

# T-082 — CSV exports (Owner only, audited)

**Phase** 4 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-080, T-081

## Goal

Owners can take their data out safely.

## Scope

- Streamed CSV (UTF-8 BOM for Excel, Hindi-safe) for customers, bills, payments and every report.
- Owner-only, audited, rate-limited.

## Acceptance criteria

- [ ] Staff receive 403-equivalent; export audit event recorded.

## Tests required

- Integration tests incl. isolation.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/exports/**`
- `apps/web/src/app/(operator)/reports/_export/**`
- `apps/web/src/app/api/exports/**`

## References

FR-029, RULE-22 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T13:27:14.299Z claimed by agent-t082
