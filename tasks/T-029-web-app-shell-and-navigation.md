---
id: T-029
title: Web app shell and navigation
phase: 1
area: web
status: claimed
owner: agent-t029
claimed_at: 2026-10-13T13:58:03.467Z
branch: task/T-029-web-app-shell-and-navigation
depends_on: [T-007, T-026]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/layout.tsx, apps/web/src/app/(operator)/*/page.tsx, apps/web/src/components/shell/**, apps/web/src/lib/nav.ts, packages/i18n/messages/*/shell.json]
---

# T-029 — Web app shell and navigation

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-007, T-026

## Goal

The frame every operator page lives in, with ALL nav destinations pre-created so feature tasks never edit shared nav files.

## Scope

- Sidebar (desktop) / bottom bar + More (mobile) with the 7 items from PLAN §12.1, icons + bilingual labels, role-based visibility.
- Placeholder `page.tsx` for every section and sub-route listed in PLAN §12.1 (each shows EmptyState 'Coming soon'); feature tasks replace these files.
- Header: operator name, language switch, account menu, read-only/grace banner slot (reads subscription state).
- Home page skeleton with setup checklist component (data wiring in T-083).

## Acceptance criteria

- [ ] Staff do not see Owner-only items (Settings › Subscription/Team/Audit, exports).
- [ ] Works at 360px width.

## Tests required

- Component tests for nav visibility per role; Playwright smoke navigating all items.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/layout.tsx`
- `apps/web/src/app/(operator)/*/page.tsx`
- `apps/web/src/components/shell/**`
- `apps/web/src/lib/nav.ts`
- `packages/i18n/messages/*/shell.json`

## References

PLAN §12.1, PLAN §12.2, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:58:03.468Z claimed by agent-t029
