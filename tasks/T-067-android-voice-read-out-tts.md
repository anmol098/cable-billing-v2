---
id: T-067
title: Android: voice read-out (TTS)
phase: 3
area: android
status: claimed
owner: agent-t067
claimed_at: 2026-10-13T10:25:40.431Z
branch: task/T-067-android-voice-read-out-tts
depends_on: [T-009]
review: self
claimable_by: agent
size: S
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/voice/**, packages/i18n/messages/*/mobile_voice.json]
---

# T-067 — Android: voice read-out (TTS)

**Phase** 3 · **Area** android · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-009

## Goal

The phone speaks key moments in Hindi.

## Scope

- `TtsSpeaker` implementing `Speaker` with hi-IN, English fallback, mute persisted, queue flush on navigation.
- Amount phrasing helper ('चार सौ पचास रुपये').
- One-time icon-led prompt to install Hindi voice data if missing; never blocks.

## Acceptance criteria

- [ ] With TTS unavailable the app behaves exactly as with NoOpSpeaker.

## Tests required

- Unit tests for phrasing (₹1, ₹450, ₹1,00,000) in hi + en.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/voice/**`
- `packages/i18n/messages/*/mobile_voice.json`

## References

PLAN §11.3 (Voice column), D-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T10:25:40.431Z claimed by agent-t067
