---
id: T-070
title: Android: Today screen and cash handover
phase: 3
area: android
status: claimed
owner: agent-t070
claimed_at: 2026-10-13T20:26:00.143Z
branch: task/T-070-android-today-screen-and-cash-handover
depends_on: [T-066]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/today/**, packages/i18n/messages/*/mobile_today.json]
---

# T-070 — Android: Today screen and cash handover

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066

## Goal

Lineman sees today's cash and UPI and hands over cash.

## Scope

- Local totals incl. unsynced (labelled) + server totals when online.
- Handover: pre-filled expected cash, number pad, discrepancy reason icon tiles + optional note, submit (queued offline), status after office review.

## Acceptance criteria

- [ ] Cash and UPI never mixed in any total (PRD §15 #12).

## Tests required

- ViewModel tests for totals and discrepancy.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/today/**`
- `packages/i18n/messages/*/mobile_today.json`

## References

PLAN §8.7, PLAN §11.3 (Today), FR-022, J-05 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T20:26:00.144Z claimed by agent-t070
