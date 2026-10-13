---
id: T-007
title: Web UI composites and /dev/ui showcase
phase: 0
area: web-ui
status: claimed
owner: agent-t007
claimed_at: 2026-10-13T06:25:06.259Z
branch: task/T-007-web-ui-composites-and-dev-ui-showcase
depends_on: [T-006, T-003]
review: self
claimable_by: agent
size: M
paths: [packages/ui/src/composites/**, apps/web/src/app/dev/ui/**]
---

# T-007 — Web UI composites and /dev/ui showcase

**Phase** 0 · **Area** web-ui · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-006, T-003

## Goal

Higher-level components that enforce the 'one screen = one job' patterns.

## Scope

- PageHeader (title + exactly one primary action slot), EmptyState (icon + one sentence + action), DataTable (≤5 columns, becomes cards under `sm`, row click), Dialog, ConfirmSheet (plain-language effect summary + confirm), Toast, Stepper (multi-step form shell, max 6 fields/step guidance), Combobox (async search), LanguageSwitch (EN | हिं), HelpTip ('?' with one-sentence bilingual text).
- `/dev/ui` showcase page (only in development/preview) rendering every primitive and composite in both languages.

## Acceptance criteria

- [ ] Showcase renders in EN and HI; mobile width 360px has no horizontal scroll.
- [ ] Changing a token visibly changes the showcase after `pnpm tokens:build`.

## Tests required

- Component tests for DataTable card fallback and Stepper navigation.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/composites/**`
- `apps/web/src/app/dev/ui/**`

## References

PLAN §6.4, PLAN §12.2 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T06:25:06.259Z claimed by agent-t007
