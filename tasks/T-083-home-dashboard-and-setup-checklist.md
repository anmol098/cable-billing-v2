---
id: T-083
title: Home dashboard and setup checklist
phase: 4
area: web
status: todo
owner:
claimed_at:
branch:
depends_on: [T-044, T-046, T-062]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/home/**, packages/core/src/dashboard/**, packages/i18n/messages/*/home.json]
---

# T-083 — Home dashboard and setup checklist

**Phase** 4 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-044, T-046, T-062

## Goal

One glance tells the owner how today and this month are going.

## Scope

- Tiles: today cash, today UPI, month billed vs collected, total due, last bill run status.
- Alerts: handovers waiting, payments needing review, subscription state.
- Setup checklist (plans → customers → linemen → install app with Play link/QR) auto-ticks from data.

## Acceptance criteria

- [ ] Loads < 1 s on `legacy` seed (cached aggregates acceptable).

## Tests required

- Service tests; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/home/**`
- `packages/core/src/dashboard/**`
- `packages/i18n/messages/*/home.json`

## References

PLAN §12.1 (Home), PLAN §12.3, BRD §12 (Operator dashboard) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
