---
id: T-073
title: Android release pipeline (Google Play)
phase: 3
area: infra
status: todo
owner:
claimed_at:
branch:
depends_on: [T-008, T-010]
review: self
claimable_by: agent
size: M
paths: [.github/workflows/android-release.yml, apps/android/app/build.gradle.kts, apps/android/fastlane/**, docs/runbooks/android-release.md]
---

# T-073 — Android release pipeline (Google Play)

**Phase** 3 · **Area** infra · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-008, T-010

## Goal

Tagged builds go to the Play closed-testing track automatically.

## Scope

- Signing via GitHub secrets (upload key), versionCode from tag/run number, Gradle Play Publisher to internal/closed track.
- Runbook incl. Play data-safety answers and staged rollout.
- applicationId is provisional until H-02.

## Acceptance criteria

- [ ] Dry-run job builds a signed AAB with dummy key in CI.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `.github/workflows/android-release.yml`
- `apps/android/app/build.gradle.kts`
- `apps/android/fastlane/**`
- `docs/runbooks/android-release.md`

## Notes

- Needs H-01 (Play Console + secrets) for real uploads; build everything else first.

## References

D-19, PLAN §17 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
