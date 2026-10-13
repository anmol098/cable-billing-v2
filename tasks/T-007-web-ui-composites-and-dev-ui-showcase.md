---
id: T-007
title: Web UI composites and /dev/ui showcase
phase: 0
area: web-ui
status: done
owner: agent-t007
claimed_at: 2026-10-13T06:25:06.259Z
branch: task/T-007-web-ui-composites-and-dev-ui-showcase
depends_on: [T-006, T-003]
review: self
claimable_by: agent
size: M
paths: [packages/ui/src/composites/**, apps/web/src/app/dev/ui/**]
---

# T-007 — Web UI composites and /dev/ui showcase

**Phase** 0 · **Area** web-ui · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-006, T-003

## Goal

Higher-level components that enforce the 'one screen = one job' patterns.

## Scope

- PageHeader (title + exactly one primary action slot), EmptyState (icon + one sentence + action), DataTable (≤5 columns, becomes cards under `sm`, row click), Dialog, ConfirmSheet (plain-language effect summary + confirm), Toast, Stepper (multi-step form shell, max 6 fields/step guidance), Combobox (async search), LanguageSwitch (EN | हिं), HelpTip ('?' with one-sentence bilingual text).
- `/dev/ui` showcase page (only in development/preview) rendering every primitive and composite in both languages.

## Acceptance criteria

- [x] Showcase renders in EN and HI; mobile width 360px has no horizontal scroll.
- [x] Changing a token visibly changes the showcase after `pnpm tokens:build`.

## Tests required

- Component tests for DataTable card fallback and Stepper navigation.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/composites/**`
- `apps/web/src/app/dev/ui/**`

## References

PLAN §6.4, PLAN §12.2 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/ui/src/composites/*.tsx`, all exported from `@cb/ui`; `/dev/ui` in
`apps/web/src/app/dev/ui/`)

**Component APIs** (words always come from props: callers pass `t("…")`; nothing here imports next-intl)

- `PageHeader` — `title`, `description?`, `action?: ReactElement` (the **one** primary action, usually
  `<Button size="lg" icon="add">`), `back?` (slot before the title), `headingLevel?: 1 | 2` (default 1),
  `actionPlacement?: "responsive" | "inline"` (default `responsive`: right of the title from `sm` up,
  **pinned full-width to the bottom of the screen on phones**), `actionClassName?` (e.g. lift the bar above a
  bottom nav). Give the page body `PAGE_ACTION_CLEARANCE` (`pb-20 sm:pb-0`) so the pinned bar hides nothing.
  Server-component friendly.
- `EmptyState` — `icon: IconName`, `message` (one sentence), `action?` (one Button).
- `DataTable<Row>` — `columns: { id, header, cell(row), align?: "start" | "end", primary? }[]` (**max 5**,
  `DATA_TABLE_MAX_COLUMNS`; more throws), `rows`, `rowKey(row)`, `caption` (accessible name, visually hidden),
  `onRowClick?(row)` or `rowHref?(row)` + `linkAs?` (pass Next's `Link`), `empty?` (shown instead when no rows).
  Renders a `<table>` from `sm` up and a `<ul>` of cards under `sm` (pure CSS switch, `data-view="table"/"cards"`):
  the card title is the `primary` column (default: first), the other columns become label/value rows. The
  primary cell's button/link is stretched over the whole row/card (`after:absolute after:inset-0`), so the whole
  row is the click target and keyboard users get one button per row; put other controls in a cell inside
  `relative z-10`. No hooks: works in server components with `rowHref`.
- `Dialog` (client) — `title`, `description?`, `closeLabel` (required, the ✕ IconButton's name), `trigger?`
  (element, Radix `asChild`), `open?/defaultOpen?/onOpenChange?`, `children`, `footer?`. `DialogClose` (Radix
  Close, use `asChild` around a Button). Focus goes to the panel on open (not the first button), returns to the
  trigger on close; Escape / outside click close it.
- `ConfirmSheet` (client) — `title` (a question), `summary` (ReactNode: the plain-language effect with the
  numbers, PLAN §12.2), `confirmLabel`, `cancelLabel`, `confirmIcon?`, `tone?: "primary" | "danger"`,
  `onConfirm(): void | Promise<void>` (while pending: `loadingLabel` on the button, Cancel/Escape disabled;
  resolves → closes; throws → stays open, show a Toast), `trigger?`, `open?/defaultOpen?/onOpenChange?`.
  `role="alertdialog"`; outside taps don't close it. Bottom sheet on phones, centred panel from `sm`.
- `ToastProvider` (client) + `useToast()` — provider props `closeLabel`, `label` (e.g. `ui.notifications`),
  `duration?` (default 6000 ms). `useToast().toast({ variant: "success" | "pending" | "danger", title,
  description?, duration? })` → id; `dismiss(id)`. Icon + colour per variant (same as StatusPill); `danger`
  toasts stay until closed. Bottom of the screen on phones, bottom-right from `sm`. **Nobody mounts the provider
  app-wide yet: T-029 should put `<ToastProvider>` in the app shell** (it's only in `/dev/ui` now). Keep titles
  honest ("Saved on phone", "WhatsApp opened", never "Sent").
- `Stepper` (client) — `steps: { id, title, content }[]`, `step?/defaultStep?/onStepChange?`, `backLabel`,
  `nextLabel`, `finishLabel`, `finishIcon?` (default `success`), `progressLabel(current, total)` (use
  `ui.step_progress`), `onNext?(step) → boolean | Promise<boolean>` (runs after the browser's own
  `required`/`pattern` checks of that step pass; `false` stays), `finishType?: "submit" | "button"` (default
  `submit`: the last button submits the **surrounding `<form>`**, which gets every step's fields because all
  steps stay mounted and only the current one is visible), `onFinish?` (for `button`), `finishing?` +
  `finishingLabel?` (busy last button, e.g. from `useFormStatus`), `headingLevel?: 2 | 3`. Focus moves to the
  new step's heading. In development it `console.warn`s when a step has more than `STEPPER_MAX_FIELDS` (6)
  fields (`countStepFields(panel)`: inputs/selects/textareas, radio groups once).
- `Combobox` (client, async search) — `label` (visible; `hideLabel?`), `placeholder?`,
  `loadOptions(query, signal) → Promise<{ value, label, description? }[]>` (debounced `debounceMs`, default
  250; previous request aborted, stale answers ignored), `onSelect(option)`, `value?` (controlled),
  `minQueryLength?` (1), `loadingLabel`, `emptyLabel`, `errorLabel`, `resultsLabel?(count)` (use
  `ui.search_results`), `name?` (hidden input with the chosen value for forms), `id?`, `disabled?`. ARIA 1.2
  combobox (focus stays in the field, arrows + Enter, `aria-activedescendant`, a status line), list in a Radix
  Popover as wide as the field.
- `LanguageSwitch` — `options: { value, short, name }[]` (`EN`/`English`, `हिं`/`हिंदी`), `value`, `label`,
  `action(formData)` (the `setLocale` server action), `name?` (default `locale`). A `<form>` of submit buttons
  (`aria-pressed`, `lang`, accessible name = full language name); works without client JS. In apps/web use
  **`LocaleSwitch`** (`@/components/locale-switch`), which now renders this with the i18n words.
- `HelpTip` (client) — `label` (e.g. `ui.help_about` with the topic), `text` (one sentence), `translation?: {
  text, lang }` (the same sentence in the other language, shown under it with `lang`), `side?`. A round "?"
  button (touch-min) that opens a Radix Popover on tap/click/Enter (not hover-only).

**i18n**

- New namespace `ui` (`packages/i18n/messages/{en,hi}/ui.json`): generic words for the composites that every
  feature reuses — `language`, `language_short_en/hi`, `step_progress`, `searching`, `search_failed`,
  `search_results` (plural), `notifications`, `help_about`, `saving`. Plus `common` (`close`, `back`, `next`,
  `save`, `cancel`, …).
- New namespace `dev_ui` for the showcase text. All Hindi in both files is listed in `_review`.

**/dev/ui showcase** — `page.tsx` (server; `notFound()` when `VERCEL_ENV === "production"`, same rule as
`/dev/type`; title from i18n; reads the other locale's help sentence for the bilingual HelpTip) +
`showcase.tsx` (client, inside its own `ToastProvider`) + `sample-data.ts` (made-up customers, fake async
search). It renders every primitive and composite with i18n words; EN | हिं at the top switches via the
`setLocale` cookie action. Sections carry `data-section`, the DataTable views `data-view`.

**Decisions**

- Radix `react-dialog`, `react-toast`, `react-popover` `^1.3.0` (same release family as T-006's
  tooltip 1.4.0 / radio-group 1.5.0; the 1.3.1 patch was < 1 day old). Combobox and HelpTip use Popover (portal,
  positioning, dismiss, nested-layer handling inside Dialogs).
- Dialog/ConfirmSheet backdrop is the opaque `surface` token: tokens have no scrim colour and opacity utilities
  are banned, and a modal is "one screen = one job". **For H-02/design:** add a `scrim` colour token if a
  see-through backdrop is wanted.
- Widths use spacing multiples (`w-72`, `w-96`, `sm:w-128`), not Tailwind's `max-w-*` container scale (no
  container tokens). `tokens-only.test.ts` now allows Radix's measured CSS variables
  (`w-(--radix-popover-trigger-width)`) and nothing else of that shape.
- Two icons added to `icons.json` (T-003, done): `close` → `x` (Dialog/Toast close) and `next` → `arrow-right`
  (Stepper Next; glossary pairs Next with arrow-right). Regenerated `icons.generated.ts` and the Android
  `ic_cb_close.xml` / `ic_cb_next.xml`.
- HelpTip's "?" is a literal symbol (aria-hidden); its accessible name comes from `label`.
- DataTable status pills in the showcase use `success` for Active and `danger` for Stopped as a demo only;
  the customers task decides the real mapping.

**Deviations / shared files touched** (all small)

- `packages/ui/src/index.ts`: `export * from "./composites"` (Biome sorts the export lines).
- `packages/ui/package.json` + `pnpm-lock.yaml`: the three Radix packages.
- `packages/ui/src/primitives/tokens-only.test.ts` (T-006): scans `composites/` too; Radix-variable exception.
- `packages/ui/src/primitives/classes.test.tsx` (T-006): the Gallery renders every composite in every variant
  and opens the tooltip, combobox list, HelpTip, toasts, Dialog and ConfirmSheet, collecting classes after each
  step; timeout raised to 30 s (it timed out at 5 s under a busy `turbo test`).
- `packages/ui/src/primitives/test-setup.ts` (T-006): jsdom stubs for pointer capture (Radix Toast swipe).
- `apps/web/src/components/locale-switch.tsx` (T-005): now renders `LanguageSwitch` (as T-005's notes asked);
  same accessible names, `aria-pressed` and form name, so its tests and the smoke e2e pass unchanged. It now
  reads `ui.language` instead of `scaffold.home.language` (that scaffold key is unused now; T-087 can drop it).
- `apps/web/e2e/dev-ui.spec.ts` (new spec in T-088's e2e folder, requested for this task).
- `packages/design-tokens/icons.json` + generated icon files (see Decisions).

**Tests**

- `composites/DataTable.test.tsx` (7): table vs card views and their breakpoint classes; **card fallback**
  (one card per row, primary column as title, others as `dt`/`dd` in order); stretched row/card button with
  click + Enter; `rowHref` links with a custom link component in both views; plain rows; empty state; > 5
  columns throws; axe.
- `composites/Stepper.test.tsx` (7): **Next/Back navigation** (one visible step, progress text,
  `aria-current="step"`, focus on the new heading, values kept, no Back on step 1, Save only on the last);
  `required` blocks Next; `onNext` → false blocks; controlled `step`; the last button submits the surrounding
  form with every step's fields (Next never submits); `finishType="button"` busy state; field counting and the
  > 6 warning; axe.
- `composites/overlays.test.tsx` (11): Dialog (trigger, panel focus, description, Escape, focus return,
  DialogClose), ConfirmSheet (summary as description, busy confirm, Escape blocked while busy, closes on
  resolve, stays on reject, outside tap ignored, cancel), Toast (icon/colour/word, close, auto-hide vs sticky
  problem, hook outside provider), Combobox (debounced async search, arrows/Enter, tap, status line, hidden form
  value, empty/error, abort of the previous search), HelpTip (opens, translation `lang`, Escape returns focus) —
  **axe-core with zero violations** for every interactive composite.
- `composites/layout.test.tsx` (6): PageHeader (h1, pinned action classes, inline, static markup), EmptyState,
  LanguageSwitch (EN | हिं, names, `aria-pressed`, submits `locale` to the action; axe).
- apps/web `src/app/dev/ui/page.test.tsx` (5): 404 when `VERCEL_ENV=production`, renders for preview/local;
  the Showcase renders all 11 sections in EN and in HI with no raw keys.
- `e2e/dev-ui.spec.ts` (4, Playwright): EN at 360×800 (all sections, cards visible and table hidden, pinned
  action at the bottom, **no horizontal scroll**); switch to हिंदी via EN | हिं (cookie, `lang="hi"`, Hindi
  headings, **no horizontal scroll at 360px**, ConfirmSheet open still fits); desktop 1280 (table instead of
  cards, row click → toast, Stepper blocked by `required` then moves with focus on the heading, Combobox async
  search + keyboard choice, HelpTip with Hindi translation); no CSP reports.

**Verification** (Node v24.21.0, pnpm 12.11.2, `TURBO_FORCE=1`)

- `pnpm install --frozen-lockfile`, `pnpm lint` (182 files clean), `pnpm typecheck` 9/9, `pnpm test` 9/9 (ui 14
  files / 210 tests, web 7 / 59, design-tokens 10 / 109), `pnpm build` 9/9, `pnpm generate` (no diff),
  `pnpm tokens:build --check`, `pnpm icons:build --check`, `pnpm --filter @cb/i18n i18n:build --check`,
  `pnpm i18n:check`, `node scripts/tasks.mjs check --local`: all pass.
- `pnpm --filter web build && E2E_PORT=3177 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=… pnpm --filter web test:e2e`:
  9 passed (5 smoke + 4 dev-ui).
- Screenshots (full page, `next start` + Chromium) of `/dev/ui` at 360px EN, 360px HI (+ ConfirmSheet open) and
  1280px EN checked by eye: cards on phones, table on desktop, Devanagari renders, pinned primary action,
  bottom sheet with the bold month and ₹450.
- **Token criterion, done for real:** set `color.accent` to `#7C3AED` in tokens.json → `pnpm tokens:build`
  (theme.css `--color-accent: #7C3AED`) → `pnpm --filter web build` → `next start`: the primary button's
  computed `background-color` changed from `rgb(17, 17, 17)` to `rgb(124, 58, 237)` at 360px EN/HI and 1280px,
  and the screenshot showed every primary button, the selected language, Stepper dot and RadioCard border in
  violet. Reverted to `#111111`, rebuilt; `tokens:build --check` passes and git shows no token diff.

**For later tasks**

- T-029 (app shell): mount `ToastProvider` (labels `common.close`, `ui.notifications`) inside the intl
  provider; use `LocaleSwitch` in the shell; if the phone bottom nav sits at `bottom-0`, pass
  `actionClassName` to lift PageHeader's pinned action (or reserve space) and add `PAGE_ACTION_CLEARANCE`.
- Feature pages: `PageHeader` with one `action`; lists via `DataTable` + `EmptyState`; long forms via
  `Stepper` inside `<form action={serverAction}>`; money moves through `ConfirmSheet`; customer search via
  `Combobox` with a server action as `loadOptions`.

## Board log

- 2026-10-13T06:25:06.259Z claimed by agent-t007
- 2026-10-13T06:50:07.357Z completed on task/T-007-web-ui-composites-and-dev-ui-showcase
