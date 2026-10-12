---
id: T-010
title: CI workflows and PR template
phase: 0
area: infra
status: todo
owner:
claimed_at:
branch:
depends_on: [T-005, T-008]
review: self
claimable_by: agent
size: M
paths: [.github/workflows/**, .github/pull_request_template.md, .github/dependabot.yml]
---

# T-010 — CI workflows and PR template

**Phase** 0 · **Area** infra · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-005, T-008

## Goal

Every PR to the integration branch is checked automatically.

## Scope

- `web.yml`: pnpm install (cached) → `node scripts/tasks.mjs check --local` → turbo lint/typecheck/test/build (affected) with a Postgres 17 service container (`DATABASE_URL` for integration tests).
- `android.yml`: path-filtered (`apps/android/**`, `packages/design-tokens/**`, `packages/i18n/**`, `packages/contracts/**`), JDK 17, Gradle cache, ktlint, detekt, unit tests, `assembleDevDebug`.
- `generated-check.yml`: tokens, icons, i18n, openapi `--check` modes fail on drift.
- Runs on `pull_request` to `feature/**` and `main`, and on push to those branches.
- PR template with: Task ID, summary, how verified, screenshots (UI), checklist from tasks/README.md §5.
- Dependabot for npm, gradle, github-actions (weekly, grouped).

## Acceptance criteria

- [ ] A PR with a lint error fails; a clean PR passes.
- [ ] Android job is skipped for web-only changes.

## Tests required

- Open a throwaway PR (or use `act`) to show both pass/fail paths; note evidence in completion notes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `.github/workflows/**`
- `.github/pull_request_template.md`
- `.github/dependabot.yml`

## References

PLAN §17 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
