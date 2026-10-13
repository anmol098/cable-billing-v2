---
id: T-068
title: Android: Bluetooth printer setup and ESC/POS raster printing
phase: 3
area: android
status: claimed
owner: agent-t068
claimed_at: 2026-10-13T12:48:22.654Z
branch: task/T-068-android-bluetooth-printer-setup-and-esc
depends_on: [T-009]
review: self
claimable_by: agent
size: L
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/printing/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/printer/**, apps/android/app/src/main/AndroidManifest.xml, packages/i18n/messages/*/mobile_printer.json]
---

# T-068 — Android: Bluetooth printer setup and ESC/POS raster printing

**Phase** 3 · **Area** android · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-009

## Goal

Print readable Hindi + English receipts on generic 58 mm printers.

## Scope

- Permissions per API level with icon-led explainer; printer setup (paired list, scan, pair, test print, remember).
- `ReceiptRenderer`: draws a `ReceiptModel` to a 384px-wide bitmap with bundled fonts.
- `EscPosRasterEncoder` (`GS v 0`, chunked) + RFCOMM SPP transport with timeouts; printer profiles (init/feed/cut).
- Errors surfaced as typed results (off, no paper, not paired) – never throws into payment code.

## Acceptance criteria

- [ ] Test print works on at least one real 58 mm ESC/POS printer (record model in completion notes).

## Tests required

- Unit tests: encoder byte output for a tiny bitmap; renderer snapshot test.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/printing/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/printer/**`
- `apps/android/app/src/main/AndroidManifest.xml`
- `packages/i18n/messages/*/mobile_printer.json`

## References

PLAN §11.8, FR-018, D-08, RULE-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T12:48:22.654Z claimed by agent-t068
