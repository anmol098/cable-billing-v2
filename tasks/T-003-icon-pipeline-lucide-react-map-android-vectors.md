---
id: T-003
title: Icon pipeline (Lucide → React map + Android vectors)
phase: 0
area: design-system
status: done
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

- [x] Adding a name to icons.json and regenerating makes it available on both platforms.
- [x] `--check` mode for CI.

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

**What exists**

- `packages/design-tokens/icons.json`: flat map, semantic name → canonical Lucide name, 32 icons:
  cash=banknote, upi=qr-code, pending=clock, success=circle-check, danger=triangle-alert,
  search=search, customer=user, collect=hand-coins, print=printer, **whatsapp=message-circle** (no
  trademarked logo), sms=message-square, handover=handshake, today=calendar-days, waiting=hourglass,
  settings=settings, call=phone, speaker=volume-2, mute=volume-x, back=arrow-left, add=plus,
  edit=pencil, bill=receipt-text, report=chart-column, home=house, lineman=hard-hat, plan=tv,
  area=map-pin, audit=rotate-ccw-clock (Lucide's "history" glyph), export=download, import=upload,
  logout=log-out, language=languages. The §2.2 table's glyphs are kept (banknote, qr-code, clock,
  check-circle → `circle-check`, alert-triangle → `triangle-alert`; Lucide 1.x renamed the last two).
- Generator in `packages/design-tokens` (same structure as T-002): `src/icons/manifest.ts`
  (validation, `androidDrawableName`), `src/icons/svg.ts` (Lucide element → path data),
  `src/icons/android.ts` (VectorDrawable XML), `src/icons/react.ts` (React data module),
  `src/icons/outputs.ts` (`renderIconOutputs`), `src/icons/fs.ts` (Node only: reads `icons.json` and
  the installed `lucide-static` `icon-nodes.json`, writes/checks files), `scripts/icons.ts` (CLI). The
  pure parts are exported from the `@cb/design-tokens` index.
- Glyph data comes from `lucide-static@1.55.0` (exact pin, devDependency of `@cb/design-tokens`), read
  from `node_modules` at build time: no network, no runtime icon dependency.
- Generated and committed: `packages/ui/src/icons/icons.generated.ts`,
  `packages/ui/src/icons/LICENSE-lucide.txt` (Lucide ISC + Feather MIT notice, copied from the
  package), `apps/android/core/designsystem/src/main/res/drawable/ic_cb_<name>.xml` (32 files).

**Commands**

- `pnpm icons:build` (root) = `pnpm --filter @cb/design-tokens icons:build`. Writes only changed
  files and **deletes `ic_cb_*.xml` files no longer in icons.json** (the generator owns the `ic_cb_`
  prefix; other drawables are never touched).
- `pnpm icons:build --check`: exit 1 listing `missing` / `changed` / `extra` files (for T-010's CI).
- `pnpm generate` runs it (the package's `generate` script is now `tokens build && icons build`).
- `pnpm test` in `@cb/design-tokens` also fails on drift (`src/icons/outputs.test.ts`); its
  `turbo.json` test inputs now include the generated icon files.

**Interfaces for later tasks**

- Web (T-006/T-007): `import { Icon, type IconName, ICON_NAMES, isIconName } from "@cb/ui"`.
  `<Icon name="cash" />` renders an inline `<svg>` (viewBox 24, `stroke="currentColor"`, stroke 2,
  round caps/joins, `fill="none"`), `width/height="1em"` so it follows the type token of its text.
  Colour with token utilities on the icon or a parent (`className="text-cash"`); size with token
  spacing (`className="size-6"`; CSS beats the 1em attributes). No `label` → `aria-hidden="true"`
  (decorative, for icon + word, PLAN §2.2 rule 3); `label={t("…")}` → `role="img"` + `aria-label`
  (icon-only buttons). Other SVG props pass through; `data-icon={name}` is set for tests.
  `IconName` is a string-literal union, so a typo is a type error. `ICON_NODES` /
  `ICON_SVG_ATTRIBUTES` (in `icons.generated.ts`) are not exported from the index; use `<Icon>`.
- `@cb/ui` now has `react` as a peer dependency (catalog `^19.3.0`) and `react`, `react-dom`,
  `@types/react`, `@types/react-dom` as dev dependencies; all four are new catalog entries, so
  T-005's `apps/web` should use `"react": "catalog:"` etc. to stay on one React.
- Android (T-008/T-009): drawables `R.drawable.ic_cb_<name>` (kebab → snake: `log-out` →
  `ic_cb_log_out`), in module `core/designsystem` (`src/main/res/drawable`). Each is 24dp,
  viewport 24×24, paths stroked (and for Lucide's filled dots, filled) with
  `@android:color/white`, and the root has `android:tint="?android:attr/colorControlNormal"`
  (framework attr, so no AppCompat needed). Use `Icon(painterResource(R.drawable.ic_cb_cash),
  contentDescription = stringResource(...) or null, tint = Tokens.Color.Cash, modifier =
  Modifier.size(...))`: an explicit tint (or the default `LocalContentColor`) replaces the white
  via SrcIn; with `tint = Color.Unspecified` the theme's control colour applies. Size it with
  `Modifier.size(...)` from tokens; 24dp is only the intrinsic size. The XML files contain no hex
  colours or dimension values other than the intrinsic 24dp.
- T-008: the drawables live in `core/designsystem/src/main/res/drawable/`; the module must be an
  Android library with resources enabled (`android { namespace = … }`, which is the default). If
  lint/detekt config scans resources, `ic_cb_*.xml` are generated files (header comment says so).

**Decisions and deviations**

- PLAN E-09 / §6.2 say "Compose `ImageVector`s"; this task's scope says VectorDrawable XML
  `ic_cb_<name>.xml`. I followed the task: Compose's `painterResource` turns these into
  `ImageVector`s at runtime, and XML also works for notifications/Views. Same Lucide data on both
  platforms, so the glyphs are identical.
- React side: no `lucide-react` dependency. The generator emits plain data (tag + attributes per
  element) and a small hand-written `Icon` renders it with `createElement`. Reasons: the web draws
  exactly the same lucide-static version Android is converted from (one pin to bump), no runtime
  dependency or bundle of 1,800 icons, and the generated file is data only.
- Shape conversion (`src/icons/svg.ts`): `circle`/`ellipse` → two half arcs + `Z`; `rect` → box, or
  a rounded box with `A` corners (SVG 2 rules: missing `rx`/`ry` copies the other, both capped at
  half the size); `line` → `M L`; `polyline` → `M L…`; `polygon` → `M L… Z`; `path` → re-serialised
  with explicit tokens (one command letter per segment, arc flags split, implicit lineto after
  moveto made explicit, numbers at most 4 decimals, no exponents) so Android's parser can't
  misread Lucide's minified data (`a2 2 0 0 1-2 2`, `M6 12h.01`). Unknown elements, attributes
  (`transform`, `opacity`, …) or fills other than `none`/`currentColor` fail the build, so a Lucide
  upgrade with new SVG features can't silently draw wrong.
- Tokens define no icon size, so none was added: web icons are `1em` (follow text tokens), Android
  drawables have the Lucide-native 24dp intrinsic size and call sites size them with tokens. If the
  design wants fixed icon sizes, add e.g. `size.icon` to tokens.json (T-002's schema already allows
  extra size names) in T-006/T-009.
- Licence: Lucide is ISC (some glyphs MIT, from Feather). The notice is copied next to the web data
  (`LICENSE-lucide.txt`) and referenced in each drawable's header comment. Follow-up for the Android
  app (T-008/T-009 or a later about screen): include the Lucide notice in the app's open-source
  licences screen.
- Touched outside the owned paths (smallest change; owners are done): root `package.json`
  (`icons:build` script), `pnpm-workspace.yaml` (catalog: `react`, `react-dom`, `@types/react`,
  `@types/react-dom` `^19.3.0`), `packages/design-tokens/package.json` (`icons:build`, `generate`,
  `lucide-static` devDependency), `packages/design-tokens/src/index.ts` (exports),
  `packages/design-tokens/turbo.json` (test inputs), `packages/design-tokens/README.md` (Icons
  section), `packages/ui/package.json` (react peer + dev deps; T-006 owns it next and should keep
  these), `packages/ui/src/index.ts` (one export line), `packages/ui/turbo.json` (test input
  `icons.json`), `CLAUDE.md` (one command line).

**Verification** (Node v24.21.0, pnpm 12.11.2, `TURBO_FORCE=1`)

- `pnpm install`, `pnpm lint`, `pnpm typecheck` (8/8), `pnpm test` (8/8; design-tokens 10 files /
  109 tests, ui 2 files / 7 tests), `pnpm build` (8/8), `pnpm generate` (0 files changed),
  `pnpm tokens:build --check`, `pnpm icons:build --check`, `pnpm --filter @cb/i18n i18n:build
  --check`, `node scripts/tasks.mjs check --local`: all pass.
- Required snapshot test: `src/icons/android.test.ts` has an inline snapshot of `ic_cb_cash.xml`
  (banknote: rounded rect, circle, dot path). `src/icons/svg.test.ts` covers every shape (rect with
  rx, rx+ry, ry only, capped radii; ellipse; polygon/polyline; packed arc flags; implicit commands)
  and the error cases. `packages/ui/src/icons/Icon.test.ts` renders `<Icon>` to static markup (exact
  markup for `cash`, a11y with/without `label`, prop pass-through, every icons.json name renders,
  no hex colours).
- Acceptance 1 done for real: added `"close": "x"` to icons.json; `icons:build --check` exited 1
  (`changed icons.generated.ts`, `missing ic_cb_close.xml`); `icons:build` wrote both files (the
  React map got `"close"`; a scratch file using `createElement(Icon, { name: "close" })` passed
  `tsc`, and after removing the name `tsc` rejected it with TS2769); removing it again and
  rebuilding deleted `ic_cb_close.xml` (`--check` had reported it as `extra`), then `--check` passed.
  `src/icons/outputs.test.ts` asserts the same in memory and on a temp directory.
- Conversion checked against a renderer: every one of the 1,877 icons in lucide-static 1.55.0 was
  rasterised with resvg (scratch install, not in the repo) twice: original SVG elements vs. an SVG
  made only of the converted path data. 0 icons differ (pixel-identical at 192px). The check is not
  vacuous: deliberately wrong corner radii made banknote/qr-code/printer differ by 2.5–10.8% of ink
  pixels.
- Android: all 32 drawables compile with `aapt2 compile` (build-tools 36.1.0) and link with
  `aapt2 link` against `platforms/android-36/android.jar` (minSdk 24 test manifest). `aapt2 dump
  xmltree` shows `android:tint` resolving to the framework `colorControlNormal` attribute. **Not
  rendered on a device or in Compose here**: T-008/T-009 should eyeball a few icons with a tint.

## Board log

- 2026-10-13T05:36:26.344Z claimed by agent-t003
- 2026-10-13T05:48:41.037Z completed on task/T-003-icon-pipeline-lucide-react-map-android-v
