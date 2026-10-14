---
id: T-084
title: Excel/CSV import wizard for customers and connections
phase: 4
area: web
status: claimed
owner: agent-t084
claimed_at: 2026-10-14T06:30:54.236Z
branch: task/T-084-excel-csv-import-wizard-for-customers-an
depends_on: [T-034]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/imports/**, apps/web/src/app/(operator)/customers/import/**, packages/i18n/messages/*/import.json]
---

# T-084 — Excel/CSV import wizard for customers and connections

**Phase** 4 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-034

## Goal

New operators move from notebooks/spreadsheets in minutes.

## Scope

- Downloadable template (xlsx + csv, Hindi headers optional).
- Upload → parse → row validation via the same services (no bypass) → preview with per-row errors → import valid rows in batches → downloadable error file.
- Idempotent re-upload (match on customer code).

## Acceptance criteria

- [ ] 5,000-row file imports < 2 min; invalid rows never partially import.

## Tests required

- Parser + validation tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/imports/**`
- `apps/web/src/app/(operator)/customers/import/**`
- `packages/i18n/messages/*/import.json`

## References

FR-030, PLAN §12.2, D-15 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T06:30:54.236Z claimed by agent-t084
