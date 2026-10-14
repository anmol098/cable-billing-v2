---
id: T-031
title: Rental plans
phase: 1
area: web
status: claimed
owner: agent-t031
claimed_at: 2026-10-14T04:47:40.053Z
branch: task/T-031-rental-plans
depends_on: [T-029, T-022, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/plans/**, packages/core/src/plans/**, packages/i18n/messages/*/plans.json]
---

# T-031 — Rental plans

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-022, T-025

## Goal

Owner creates, edits and retires monthly rental plans.

## Scope

- List, create, edit (name/amount), retire/unretire.
- Editing a plan amount asks: 'Apply to existing connections from next month?' (bulk plan-change is out of scope; just show count of connections on this plan).

## Out of scope

- Changing a connection's plan (T-045).

## Acceptance criteria

- [ ] Issued invoices are unaffected by plan edits (covered by schema; add a test).
- [ ] Retired plans cannot be assigned to new connections.

## Tests required

- Service tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/plans/**`
- `packages/core/src/plans/**`
- `packages/i18n/messages/*/plans.json`

## References

FR-007, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T04:47:40.054Z claimed by agent-t031
