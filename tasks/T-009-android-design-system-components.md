---
id: T-009
title: Android design-system components
phase: 0
area: android
status: todo
owner:
claimed_at:
branch:
depends_on: [T-008, T-003]
review: self
claimable_by: agent
size: M
paths: [apps/android/core/designsystem/**]
---

# T-009 — Android design-system components

**Phase** 0 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-008, T-003

## Goal

The low-literacy component kit every Android screen uses.

## Scope

- BigButton (64dp, icon + word), MethodButton (Cash green / UPI blue tiles), NumberPad (0–9, ⌫, 00, optional ABC key; haptic feedback), AmountDisplay (₹, Indian grouping, 44sp), StatusChip (saved-on-phone / sent / needs-help), CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton.
- `Speaker` interface (`say(text: String)`, `stop()`, `isMuted`) + `NoOpSpeaker` provided via Hilt so screens can call it before T-067 lands.
- Preview catalogue screen (debug builds only) showing all components in hi + en.

## Acceptance criteria

- [ ] All touch targets ≥ 56dp; primary buttons 64dp; body ≥ 18sp.
- [ ] No raw colours/dimens outside generated tokens.

## Tests required

- Compose UI tests for NumberPad input and AmountDisplay formatting (₹1,23,456).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/core/designsystem/**`

## References

PLAN §6.4, PLAN §2.2, PLAN §11.3, D-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
