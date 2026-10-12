---
id: T-035
title: Audit log viewer
phase: 1
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-029, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/audit/**, packages/core/src/audit-query/**, packages/i18n/messages/*/audit.json]
---

# T-035 — Audit log viewer

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-025

## Goal

Owner can see who changed what.

## Scope

- Filter by date, user, entity type, action; human-readable sentences ('Ramesh (Staff) changed phone of customer 1045').
- Before/after diff view with redacted sensitive fields.

## Acceptance criteria

- [ ] Owner-only.
- [ ] Paginates 100k events smoothly (keyset pagination).

## Tests required

- Query tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/audit/**`
- `packages/core/src/audit-query/**`
- `packages/i18n/messages/*/audit.json`

## References

FR-024 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
