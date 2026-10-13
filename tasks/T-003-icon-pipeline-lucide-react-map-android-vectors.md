---
id: T-003
title: Icon pipeline (Lucide → React map + Android vectors)
phase: 0
area: design-system
status: claimed
owner: agent-t003
claimed_at: 2026-10-13T05:36:26.343Z
branch: task/T-003-icon-pipeline-lucide-react-map-android-v
depends_on: [T-002]
review: self
claimable_by: agent
size: S
paths: [packages/design-tokens/icons.json, packages/design-tokens/scripts/icons.ts, packages/ui/src/icons/**, apps/android/core/designsystem/src/main/res/drawable/ic_cb_*.xml]
---

# T-003 — Icon pipeline (Lucide → React map + Android vectors)

**Phase** 0 · **Area** design-system · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-002

## Goal

Same icon for the same meaning on web and Android, defined once.

## Scope

- `icons.json`: semantic name → Lucide icon (cash, upi, pending, success, danger, search, customer, collect, print, whatsapp*, sms, handover, today, waiting, settings, call, speaker, mute, back, add, edit, bill, report, home, lineman, plan, area, audit, export, import, logout, language).
- Generator emits a typed React `Icon` component map (`<Icon name="cash" />`) and Android vector drawables `ic_cb_<name>.xml`.
- *WhatsApp is not in Lucide: use a simple message-circle glyph; do not ship trademarked logos.

## Acceptance criteria

- [ ] Adding a name to icons.json and regenerating makes it available on both platforms.
- [ ] `--check` mode for CI.

## Tests required

- Snapshot test of generated vector XML for one icon.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/design-tokens/icons.json`
- `packages/design-tokens/scripts/icons.ts`
- `packages/ui/src/icons/**`
- `apps/android/core/designsystem/src/main/res/drawable/ic_cb_*.xml`

## References

PLAN §2.2 (colour/icon meanings), PLAN §6.2, E-09 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._

## Board log

- 2026-10-13T05:36:26.344Z claimed by agent-t003
