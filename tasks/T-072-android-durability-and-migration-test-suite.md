---
id: T-072
title: Android: durability and migration test suite
phase: 3
area: qa
status: claimed
owner: agent-t072
claimed_at: 2026-10-14T08:08:23.603Z
branch: task/T-072-android-durability-and-migration-test-su
depends_on: [T-066]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/androidTest/**, apps/android/app/src/test/java/com/cablebilling/lineman/durability/**, docs/testing/android-field-uat.md]
---

# T-072 — Android: durability and migration test suite

**Phase** 3 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066

## Goal

Automated proof of the offline guarantees, plus the manual field UAT script.

## Scope

- Instrumented tests: process death after save, device reboot simulation (WorkManager test driver), airplane mode day, duplicate retry.
- Room migration tests from schema v1.
- `docs/testing/android-field-uat.md` step-by-step script for humans (H-04/H-05).

## Acceptance criteria

- [ ] Suite runs in CI on an emulator (or documented as nightly if too slow).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/androidTest/**`
- `apps/android/app/src/test/java/com/cablebilling/lineman/durability/**`
- `docs/testing/android-field-uat.md`

## References

PRD §15 #8–#11, PLAN §16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-14T08:08:23.603Z claimed by agent-t072
