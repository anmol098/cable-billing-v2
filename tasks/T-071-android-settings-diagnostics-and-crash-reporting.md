---
id: T-071
title: Android: settings, diagnostics and crash reporting
phase: 3
area: android
status: todo
owner:
claimed_at:
branch:
depends_on: [T-063, T-067, T-068]
review: self
claimable_by: agent
size: S
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/settings/**, apps/android/app/src/main/java/com/cablebilling/lineman/diagnostics/**, packages/i18n/messages/*/mobile_settings.json]
---

# T-071 — Android: settings, diagnostics and crash reporting

**Phase** 3 · **Area** android · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-063, T-067, T-068

## Goal

Low-traffic settings kept out of the lineman's way.

## Scope

- Language हिंदी/English, voice on/off, printer setup entry, sign out (blocked while unsynced payments exist, with explanation), app version.
- Local diagnostic log (no PII) + 'Send diagnostics' share; Sentry init with flavour DSN.

## Acceptance criteria

- [ ] Sign-out never deletes queued payments.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/settings/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/diagnostics/**`
- `packages/i18n/messages/*/mobile_settings.json`

## References

PLAN §11.3 (Settings), PLAN §11.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
