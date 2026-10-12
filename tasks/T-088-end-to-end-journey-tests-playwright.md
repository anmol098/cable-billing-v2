---
id: T-088
title: End-to-end journey tests (Playwright)
phase: 4
area: qa
status: todo
owner:
claimed_at:
branch:
depends_on: [T-027, T-047, T-048, T-062]
review: self
claimable_by: agent
size: M
paths: [apps/web/e2e/**, apps/web/playwright.config.ts]
---

# T-088 — End-to-end journey tests (Playwright)

**Phase** 4 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-027, T-047, T-048, T-062

## Goal

Critical web journeys are protected against regressions.

## Scope

- Sign-up → setup → add customer + VC → preview + run bill → counter payment → handover accept → reports, in EN and HI.
- Runs against Vercel preview URLs in CI with a seeded Neon branch.

## Acceptance criteria

- [ ] Suite is stable (no retries needed) across 5 consecutive runs.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/e2e/**`
- `apps/web/playwright.config.ts`

## References

PLAN §16, PRD §15 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
