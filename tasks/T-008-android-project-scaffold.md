---
id: T-008
title: Android project scaffold
phase: 0
area: android
status: todo
owner:
claimed_at:
branch:
depends_on: [T-002, T-004]
review: self
claimable_by: agent
size: L
paths: [apps/android/**]
---

# T-008 — Android project scaffold

**Phase** 0 · **Area** android · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-002, T-004

## Goal

Buildable Kotlin/Compose app skeleton with the module layout, flavours and libraries from the plan.

## Scope

- Gradle Kotlin DSL + version catalog; modules `app` and `core/designsystem` (consumes generated Tokens.kt, icons, strings).
- applicationId `com.cablebilling.lineman` (provisional, D-21), minSdk 26, targetSdk = latest Play requirement, flavours `dev` / `staging` / `prod` with API base URL per flavour.
- Hilt, Compose (Material 3) + Navigation Compose, Room (schema export dir), WorkManager (Hilt worker factory), Retrofit + OkHttp + kotlinx.serialization, DataStore, Tink, Sentry (no-op without DSN), Coroutines.
- Bundled fonts (Inter + Noto Sans Devanagari); `CableTheme` mapping tokens onto MaterialTheme + `LocalSemanticColors`.
- App shell: bottom bar with 3 destinations (Search, Today, Waiting) as placeholder screens; default locale Hindi with in-app language override (per-app language API).
- ktlint + detekt configured; detekt rule/forbidden-pattern for raw `Color(0x` and `.dp` literals outside `core/designsystem`.
- `./gradlew lint test assembleDevDebug` works.

## Acceptance criteria

- [ ] Fresh clone builds with JDK 17+ and the Android SDK only (no Node needed).
- [ ] App launches on an API 26 emulator and an API 35+ emulator showing the bottom bar in Hindi.

## Tests required

- One JVM unit test and one Compose UI test (bottom bar navigation).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/**`

## References

PLAN §11.1, PLAN §4, D-03, D-08, D-21 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
