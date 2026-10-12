---
id: T-063
title: Android: networking, auth, login and force update
phase: 3
area: android
status: todo
owner:
claimed_at:
branch:
depends_on: [T-008, T-009, T-051]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/data/network/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/auth/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/login/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/update/**, apps/android/app/build.gradle.kts, packages/i18n/messages/*/mobile_login.json]
---

# T-063 — Android: networking, auth, login and force update

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-008, T-009, T-051

## Goal

Lineman signs in once and the app talks to the API safely.

## Scope

- DTOs generated from `packages/contracts/openapi.json` (models only) + Retrofit services.
- Token store (Tink/Keystore), auth interceptor with refresh, install_id generation.
- Login screen per PLAN §11.3 (show password default on, 123/ABC toggle, call office).
- Force-update screen from `/app/config`.

## Acceptance criteria

- [ ] Works against MockWebServer using contract fixtures (no live server needed).

## Tests required

- Unit tests (refresh race, 401 handling) + Compose UI test for login.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/data/network/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/auth/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/login/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/update/**`
- `apps/android/app/build.gradle.kts`
- `packages/i18n/messages/*/mobile_login.json`

## References

PLAN §11.3 (Login), PLAN §11.6, PLAN §11.9, D-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
