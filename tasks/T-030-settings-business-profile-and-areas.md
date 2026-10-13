---
id: T-030
title: Settings: business profile and areas
phase: 1
area: web
status: claimed
owner: agent-t030
claimed_at: 2026-10-13T16:18:54.669Z
branch: task/T-030-settings-business-profile-and-areas
depends_on: [T-029, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/profile/**, apps/web/src/app/(operator)/settings/areas/**, packages/core/src/operators/**, packages/core/src/areas/**, packages/i18n/messages/*/settings.json]
---

# T-030 — Settings: business profile and areas

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-025

## Goal

Owner manages business details and areas.

## Scope

- Profile: name, phone (shown on receipts + 'call office' in app), address, receipt footer, invoice prefix, default language, **mid-month start policy** (charge full month / start next month) with plain-language explanation.
- Areas CRUD (rename, archive; no delete when used).
- All changes audited.

## Acceptance criteria

- [ ] Only Owner can edit; Staff read-only.

## Tests required

- Service tests + isolation harness registration.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/profile/**`
- `apps/web/src/app/(operator)/settings/areas/**`
- `packages/core/src/operators/**`
- `packages/core/src/areas/**`
- `packages/i18n/messages/*/settings.json`

## References

PLAN §12.1, D-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T16:18:54.669Z claimed by agent-t030
