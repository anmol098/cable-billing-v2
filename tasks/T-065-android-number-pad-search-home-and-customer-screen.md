---
id: T-065
title: Android: number-pad search home and customer screen
phase: 3
area: android
status: claimed
owner: agent-t065
claimed_at: 2026-10-13T13:38:58.502Z
branch: task/T-065-android-number-pad-search-home-and-custo
depends_on: [T-064, T-009]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/search/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/customer/**, packages/i18n/messages/*/mobile_search.json]
---

# T-065 — Android: number-pad search home and customer screen

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-064, T-009

## Goal

Find any customer with digits only and see what they owe at a glance.

## Scope

- Home = search with big NumberPad (code / phone part / VC number), ABC key for name search, SyncBanner.
- Result rows with large red due.
- Customer screen: name, code, area, tap-to-call, connections count, huge due, credit, giant Collect button, SpeakButton + auto speak 'name, ₹X due' via `Speaker`.

## Acceptance criteria

- [ ] Typing 4 digits returns results in < 100 ms on a 7.6k-customer roster on a low-end emulator profile.

## Tests required

- ViewModel tests; Compose UI test for search → customer.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/search/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/customer/**`
- `packages/i18n/messages/*/mobile_search.json`

## References

PLAN §11.2, PLAN §11.3 (Search, Customer), D-10, D-11 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T13:38:58.503Z claimed by agent-t065
