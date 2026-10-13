---
id: T-002
title: Design tokens pipeline (web CSS + Kotlin)
phase: 0
area: design-system
status: done
owner: agent-t002
claimed_at: 2026-10-13T04:34:06.627Z
branch: task/T-002-design-tokens-pipeline-web-css-kotlin
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

- [x] Changing `color.accent` and running `pnpm tokens:build` changes both generated files and nothing else.
- [x] `pnpm tokens:build --check` passes on a clean tree.
- [x] Generated CSS only exposes token colours (no default Tailwind palette).

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

**What exists**

- `packages/design-tokens/tokens.json`: the values from PLAN §6.1 exactly (accent `#111111`; plain JSON, so
  the PLAN's jsonc comments live in the package README instead).
- `src/schema.ts`: Zod schema + `parseTokens()`. Fails with a readable list (`color.accent.value: must be a hex
  colour: #RRGGBB or #RRGGBBAA`) on: missing required tokens (`REQUIRED_TOKENS`), non-hex colours (only
  `#RRGGBB` / `#RRGGBBAA`), negative or non-numeric sizes, zero borders, bad font weights / feature tags,
  unknown keys, non-camelCase names, a name in both `color` and `semantic`, a colour named like a type step
  (`text-<name>` ambiguity) and web/android type scales with different steps. Extra token names are allowed
  and flow to both outputs.
- `src/transform.ts`: pure transforms (`pxToRem`, `pxToCss`, `dp`, `sp`, `hexToCss`, `hexToArgb`,
  `hexToComposeColor`, `kebabCase`, `pascalCase` (`2xl` → `Xxl`), `cssFontFamily`, font-feature formatters).
- `src/css.ts` (`renderThemeCss`), `src/kotlin.ts` (`renderTokensKt`), `src/outputs.ts` (`OUTPUT_PATHS`,
  `renderOutputs`), `src/fs.ts` (Node-only: `loadTokens`, `compareOutputs`, `writeOutputs`, `generate`; not
  exported from the index so the index stays browser-safe), `scripts/build.ts` (CLI).
- Generated and committed: `packages/ui/src/theme.css` and
  `apps/android/core/designsystem/src/main/java/com/cablebilling/designsystem/generated/Tokens.kt`.

**Commands**

- `pnpm tokens:build` (root) = `pnpm --filter @cb/design-tokens tokens:build`; add `--check` to exit 1 on a
  stale or missing generated file (CI: T-010's generated-check). Writes only files whose content changed.
- `pnpm generate` runs it through turbo (`generate` script in the package).
- `pnpm test` in the package also fails if the committed outputs drift from `tokens.json`; the package's
  `turbo.json` adds both generated files to the `test` inputs so the turbo cache notices hand edits.

**Interfaces for later tasks**

- Web (T-005/T-006/T-007): `import "@cb/ui/theme.css"` (new `exports` entry in `@cb/ui`); the file already does
  `@import "tailwindcss"`, so the app's global CSS needs nothing else for the theme (add `@source` lines for
  `packages/ui` as needed). `@cb/ui` now has `tailwindcss` (catalog) as a dependency so that import resolves
  from `packages/ui/src` under pnpm. Utilities: colours `bg-bg bg-surface text-text text-text-muted
  border-border bg-accent text-on-accent ring-focus`, semantic `text-cash text-upi text-pending text-success
  text-danger text-due text-credit` (and `bg-*`/`border-*`); type `text-sm|base|lg|xl|2xl|amount`; fonts
  `font-sans`, `font-numeric` (tabular figures built in); weights `font-regular`, `font-strong`; radius
  `rounded-none|sm|md|lg|full`; borders `border-hairline`, `border-strong` and per side
  `border-{x,y,t,r,b,l}-{hairline,strong}`; spacing `p-4` etc. (base 4px); sizes `h-touch-min`,
  `min-h-touch-min`, `h-primary-button` (web 44px / 48px). Every token is also a CSS variable
  (`var(--color-cash)`) because the block is `@theme static`.
- Cleared Tailwind namespaces (`RESET_NAMESPACES`): color, font, font-weight, text, radius, shadow,
  inset-shadow, drop-shadow, text-shadow. So `bg-red-500`, `bg-white`, `text-xs`, `rounded-3xl`, `shadow*`,
  `font-bold`, `font-mono` do not exist. The type tokens have no line heights, so text utilities set only
  `font-size` (line height comes from preflight's 1.5); add line-height tokens if the design needs them.
- Android (T-008/T-009): package `com.cablebilling.designsystem.generated`, `object Tokens` with nested
  `Color` (base + semantic colours, flat as in PLAN §6.2, e.g. `Tokens.Color.Cash`), `Font`
  (`SansFamilies`, `NumericFamilies`: font names as `List<String>`; `NumericFeatureSettings = "'tnum'"` for
  `TextStyle.fontFeatureSettings`), `Weight` (`Regular`/`Strong` as `FontWeight`), `Type` (android scale in
  sp: `Sm Base Lg Xl Xxl Amount`), `Radius`, `Border`, `Space` (`Base = 4.dp`), `Size` (`TouchMin = 56.dp`,
  `PrimaryButton = 64.dp`), `Elevation` (`None = 0.dp`). Compose's `Color` is imported as `ComposeColor`
  because `Tokens.Color` shadows it. The file carries `@file:Suppress("ktlint", "MagicNumber")`; T-008 may
  still prefer to exclude `**/generated/**` from ktlint/detekt. Imports needed in the module:
  `androidx.compose.ui:ui-graphics`, `ui-text`, `ui-unit`.
- T-003 (icons): add `scripts/icons.ts` and either call it from `scripts/build.ts` or give it its own
  `icons:build` script and append it to the package `generate` script. `renderOutputs()`/`compareOutputs()` in
  `src/outputs.ts`/`src/fs.ts` can be reused for its `--check` mode.

**Decisions and deviations**

- `size.*` tokens become `--spacing-<name>` theme variables (so `h-`, `min-h-`, `w-`, `p-` all accept them).
- Radii are emitted in rem like the PLAN example; `full: 9999` becomes `624.9375rem`. Border widths stay px.
- `elevation` has no web output (all shadow namespaces are cleared); Android gets `Tokens.Elevation`.
- Beyond the PLAN's `Color, Radius, Border, Space, Type, Size`, Tokens.kt also has `Font`, `Weight` and
  `Elevation`, so every token reaches Android.
- Touched files outside the owned paths (smallest change; T-001 is done): root `package.json` (`tokens:build`
  script), `pnpm-workspace.yaml` (catalog entries `tailwindcss`/`@tailwindcss/node` ^4.3.3, `tsx` ^4.23.15,
  `zod` ^4.6.6), `packages/ui/package.json` (`./theme.css` export, `sideEffects: ["*.css"]`, `tailwindcss`
  dependency), `CLAUDE.md` (one command line).
- pnpm 12 fails the install on unapproved build scripts; tsx pulls esbuild. T-004 landed the same
  `allowBuilds: { esbuild: false }` first, so after rebasing this task relies on theirs. T-004's
  `@cb/i18n` pins `tsx` directly (`^4.23.15`); it could switch to the new `tsx: catalog:` entry.
- zod 4.6.7 was published < 1 day ago, so the catalog range is `^4.6.6` (resolves to 4.6.6).

**Verification** (Node v24.21.0, pnpm 12.11.2, `TURBO_FORCE=1`)

- `pnpm install`, `pnpm lint`, `pnpm typecheck` (8/8), `pnpm test` (8/8; design-tokens: 6 files, 81
  tests), `pnpm build` (8/8), `pnpm generate` (0 of 2 files changed), `pnpm tokens:build --check`: all pass.
- Tailwind v4 validity: `src/css.test.ts` compiles the committed `packages/ui/src/theme.css` with
  `@tailwindcss/node` (resolving `@import "tailwindcss"` from `packages/ui/src`) and asserts that
  `bg-bg text-text text-cash text-due border-border bg-accent rounded-md border-hairline border-b-hairline
  border-strong text-amount text-base font-sans font-numeric font-strong p-4 min-h-touch-min h-primary-button`
  are generated with the token variables, and that `bg-red-500 text-blue-600 bg-white bg-black text-9xl text-xs
  rounded-3xl shadow shadow-md drop-shadow-lg font-mono font-bold` are NOT (each one is first proven to exist
  in stock Tailwind, so the negative checks are not vacuous). No default palette variables are emitted.
- Acceptance 1 done for real: set `color.accent` to `#0F766E`, ran `pnpm tokens:build`; `git diff` showed
  exactly one line changed in each of `theme.css` and `Tokens.kt` plus `tokens.json`; then reverted.
  `src/outputs.test.ts` asserts the same in memory.
- Setting `accent` to `"red"` makes `tokens:build` exit 1 with `color.accent.value: must be a hex colour`.
- **Kotlin is not compiled here** (no Android SDK; `apps/android` does not exist yet, T-008). `Tokens.kt` is
  checked at string level only (`src/kotlin.test.ts`: header, package, imports, objects, exact values, balanced
  braces, identifier shape). T-008 must compile it and run ktlint/detekt on it.
- `node scripts/tasks.mjs check --local`: OK.
- Re-run in full after rebasing onto T-004 (lockfile taken from feature/mvp and re-installed): all of the above
  pass, plus `pnpm i18n:check`.

## Board log

- 2026-10-13T04:34:06.628Z claimed by agent-t002
- 2026-10-13T04:41:36.978Z completed on task/T-002-design-tokens-pipeline-web-css-kotlin
