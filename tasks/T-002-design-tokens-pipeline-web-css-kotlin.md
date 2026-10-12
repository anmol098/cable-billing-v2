---
id: T-002
title: Design tokens pipeline (web CSS + Kotlin)
phase: 0
area: design-system
status: todo
owner:
claimed_at:
branch:
depends_on: [T-001]
review: self
claimable_by: agent
size: M
paths: [packages/design-tokens/**, packages/ui/src/theme.css, apps/android/core/designsystem/src/main/java/com/cablebilling/designsystem/generated/**]
---

# T-002 — Design tokens pipeline (web CSS + Kotlin)

**Phase** 0 · **Area** design-system · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

Make `packages/design-tokens/tokens.json` the ONE place for colours, typography, borders, radius, spacing and sizes, generating both web and Android outputs.

## Scope

- `tokens.json` exactly per PLAN §6.1 (colours, semantic colours, font families/weights, per-platform type scales, radius, border, space, size, elevation).
- `scripts/build.ts` (run via `pnpm tokens:build`, also wired into turbo `generate`) emitting:
  - `packages/ui/src/theme.css`: Tailwind v4 `@theme` with `--color-*: initial` and `--shadow-*: initial` resets, all tokens as theme variables, `@utility border-hairline` / `border-strong`.
  - `apps/android/core/designsystem/.../generated/Tokens.kt` (Color, Radius, Border, Space, Type, Size objects) with a `// GENERATED` header.
- Token schema validation (fail build on missing/invalid values, non-hex colours).
- `--check` mode that exits non-zero if generated files differ from committed ones (used by CI).
- README in the package: how to change a colour and regenerate.

## Out of scope

- Icons (T-003).
- Components (T-006, T-009).

## Acceptance criteria

- [ ] Changing `color.accent` and running `pnpm tokens:build` changes both generated files and nothing else.
- [ ] `pnpm tokens:build --check` passes on a clean tree.
- [ ] Generated CSS only exposes token colours (no default Tailwind palette).

## Tests required

- Unit tests for the transform functions (px→rem, hex→Compose `Color(0xFF…)`, dp/sp output).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/design-tokens/**`
- `packages/ui/src/theme.css`
- `apps/android/core/designsystem/src/main/java/com/cablebilling/designsystem/generated/**`

## References

PLAN §6.1, PLAN §6.2, PLAN §6.3, D-04 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

_The agent fills this in before opening the PR: what was built, decisions taken, deviations, follow-up tasks created, and how it was verified._
