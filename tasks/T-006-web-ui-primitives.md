---
id: T-006
title: Web UI primitives
phase: 0
area: web-ui
status: done
owner: agent-t006
claimed_at: 2026-10-13T06:06:09.169Z
branch: task/T-006-web-ui-primitives
depends_on: [T-005]
review: self
claimable_by: agent
size: M
paths: [packages/ui/src/primitives/**, packages/ui/src/lib/**, packages/ui/package.json]
---

# T-006 — Web UI primitives

**Phase** 0 · **Area** web-ui · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-005

## Goal

Accessible, token-only building blocks for mid-literacy users.

## Scope

- shadcn/ui-style (Radix) components restyled with tokens only: Button (primary/secondary/quiet/danger, loading), IconButton (always has visible label or aria-label + tooltip), Input, Textarea, Select, Checkbox, RadioCards (big option tiles).
- AmountInput: ₹ prefix, whole rupees only, numeric keyboard on mobile, returns paise (`bigint`-safe number) – uses `@cb/domain` money helpers when available, otherwise local helper to be swapped later.
- Amount: Indian grouping (₹1,23,456), due/credit colouring, tabular figures, sizes incl. `amount`.
- StatusPill: icon + colour + word (variants from PLAN §2.2 table).
- Card, Divider, Spinner, VisuallyHidden; `cn()` helper.
- Min control height 44px; focus ring uses `focus` token; no shadows.

## Acceptance criteria

- [x] No hard-coded colours/sizes (Biome rule or grep check passes).
- [x] All interactive primitives are keyboard accessible and pass axe checks.

## Tests required

- Component tests for AmountInput (rejects decimals/negatives, paise conversion) and Amount formatting (₹0, ₹99, ₹1,00,000, negatives as credit).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/primitives/**`
- `packages/ui/src/lib/**`
- `packages/ui/package.json`

## References

PLAN §6.3, PLAN §6.4, PLAN §2.2, E-09 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/ui/src/primitives/*.tsx`, `packages/ui/src/lib/*.ts`; everything is exported
from `@cb/ui`)

- `lib/cn.ts` `cn(...classes)`: clsx + tailwind-merge configured with the token names (`THEME_COLORS`,
  `THEME_TEXT_SIZES`, `THEME_FONTS`, `THEME_FONT_WEIGHTS`, `THEME_RADII`, `THEME_SIZES`,
  `THEME_BORDER_WIDTHS`), so `cn("text-amount", "text-cash")` keeps both and `cn("border-hairline",
  "border-border")` keeps both. `cn.test.ts` fails if the lists drift from the generated `theme.css`: when a
  token is added to tokens.json, add its name there.
- `lib/money.ts` (local, `TODO(T-024)`): `parseRupeesInput(text)` → `{ ok, paise, digits }` or
  `{ ok: false, reason: "decimal" | "negative" | "invalid" | "too-large" }`; `rupeesToPaise(rupees)`;
  `formatRupees(paise: number | bigint)` → `{ text: "₹1,23,456", negative }` (absolute value; paise shown only
  when not whole, `₹12.50`); `groupIndian(digits)`; `paiseToRupeeDigits(paise)`; `MAX_RUPEE_DIGITS = 13`
  (keeps paise a safe integer). Formatting is bigint string maths, no floats, no `Intl` (same output in every
  locale).
- `lib/styles.ts`: `focusRing`, `focusWithinRing`, `fieldBase` class strings for new components (T-007).

**Component APIs** (all accept the native element props, `className`, and in React 19 `ref`)

- `Button` — `variant?: "primary" | "secondary" | "quiet" | "danger"` (default primary), `size?: "md" | "lg"`
  (`md` = `min-h-touch-min` 44px, `lg` = `min-h-primary-button` 48px for the one main action), `icon?:
  IconName` (decorative, before the word), `loading?` (spinner replaces the icon, `disabled` + `aria-busy`,
  keeps its colours), `loadingLabel?` (word shown while loading), `asChild?` (style a `<Link>`/`<a>` child;
  icon still rendered, loading props ignored). **Defaults to `type="button"`: pass `type="submit"` for form
  submit buttons.** `buttonClasses({ variant, size, loading, className })` gives the class string.
- `IconButton` — `icon`, `label` (required i18n string), `showLabel?` (icon + visible word via Button; preferred
  for low-literacy screens), else a square `size-touch-min` button with `aria-label={label}` and a Radix tooltip
  (hover + keyboard focus); `variant` (default `secondary`), `size`, `loading`, `tooltipSide`. Client component.
- `Input`, `Textarea` (`rows` default 3), `Select` — native elements with `fieldBase`; `invalid?` sets
  `aria-invalid` + danger border. `Select` is the **native `<select>`** (pass `<option>` children);
  `placeholder?` adds a disabled first option (use with `defaultValue=""`). Label them with `<label htmlFor>`.
- `Checkbox` — `label` (ReactNode, required), `description?` (announced as the description); the whole row is the
  `<label>` (touch-min tall); other props go to the native `<input type="checkbox">`.
- `RadioCards` — Radix RadioGroup tiles: `options: { value, label, description?, icon?, iconClassName?,
  disabled? }[]`, plus Root props (`value`/`defaultValue`/`onValueChange`, `name`, `required`, `aria-label` or
  `aria-labelledby` — name the group!). Default one column (`grid gap-3`); add e.g. `className="sm:grid-cols-2"`.
  Arrow keys move + select. Use it for Cash/UPI choices with `iconClassName="text-cash"` / `"text-upi"`.
- `AmountInput` — whole rupees with a `₹` prefix, `inputMode="numeric"`, `pattern="[0-9]*"`. `value?` /
  `defaultValue?` in **paise** (`number | null`), `onValueChange(paise | null)`, `onReject(reason)` (show an i18n
  message, e.g. "Whole rupees only"), `maxPaise?`, `invalid?`, `name?` → a **hidden input submits paise** under
  that name (the visible field has no name), so a server action reads `formData.get(name)` as paise. Refused
  edits leave the field unchanged; grouping commas, spaces, a leading ₹ and Devanagari digits are normalised.
  `className` styles the bordered wrapper; other props (`id`, `aria-*`) go to the `<input>`. Client component.
- `Amount` — `paise: number | bigint`, `tone?: "neutral" | "balance" | "due" | "credit"` (`balance`: > 0 due,
  0 neutral), `size?: "sm" | "base" | "lg" | "xl" | "2xl" | "amount"` (default `base`), `weight?: "regular" |
  "strong"` (default strong), `dueLabel?`, `creditLabel?` (word after the number; PLAN §2.2: pass them, never
  colour alone). **Negative = credit in every tone**: shown as the positive amount in `text-credit`, no minus
  sign. `font-numeric` (tabular figures). `data-tone` = resolved tone. `resolveAmountTone(paise, tone)` exported.
- `StatusPill` — `variant: "cash" | "upi" | "pending" | "success" | "danger"` (PLAN §2.2 rule 4: icon + colour
  from `STATUS_PILL_STYLES`), `label` (required word), `icon?` override.
- `Card` (`asChild?`), `Divider` (`orientation?`, `decorative?` default true → `aria-hidden`; `false` → `<hr>`
  separator), `Spinner` (`label?` → `role="status"` live region, else decorative; `size?: "sm" | "md" | "lg"`),
  `VisuallyHidden` (`sr-only`, `asChild?`).
- Strings: primitives contain no user-facing text; every word comes from props (callers pass `t("…")`). They
  do not import next-intl.

**Decisions**

- Radix only where it adds behaviour: `@radix-ui/react-slot` (asChild), `react-tooltip`, `react-radio-group`.
  Select and Checkbox are native: phones get their own big picker, and browser keyboard/screen-reader support is
  the most reliable for this audience (and no portal/pointer quirks). Combobox (T-007 scope per PLAN §6.4) can
  use Radix Popover/cmdk later.
- `@cb/ui` peer deps: `react` and now `react-dom` (Radix needs it), both `catalog:`. Runtime deps:
  `@radix-ui/react-slot ^1.5.0`, `@radix-ui/react-tooltip ^1.4.0`, `@radix-ui/react-radio-group ^1.5.0`
  (newest versions older than a day; 1.4.1/1.5.1 were < 1 day old), `clsx`, `tailwind-merge`.
- Focus ring: `focus-visible:outline-2 outline-offset-2 outline-focus`. The colour is the `focus` token; the
  2px width uses Tailwind's numeric outline scale because tokens.json has no outline-width token (it equals
  `border.strong`). Follow-up if wanted: emit `outline-strong` utilities from the token generator.
- Disabled = token colours (`bg-surface text-text-muted`), not opacity. A loading button keeps its colours.
- Field borders use the `border` token (#E5E5E5, ~1.3:1 against white) as PLAN §6.1/§6.3 specify. That is below
  WCAG 1.4.11's 3:1 for component boundaries; the radio circles use `text-muted` instead. **For the product
  owner / H-02:** consider a darker `border` token (or a separate `borderStrong` for inputs). jsdom axe runs
  with `color-contrast` off (no CSS layout), so contrast is not machine-checked here.

**Deviations / files outside the owned paths**

- `packages/ui/vitest.config.ts` (T-001/T-003, done): include `*.test.tsx` and a setup file
  (`src/primitives/test-setup.ts`: jest-dom matchers, RTL cleanup, a ResizeObserver stub for Radix). Component
  tests opt into jsdom with a `// @vitest-environment jsdom` docblock; other tests stay in Node.
- `packages/ui/src/index.ts`: appended `export * from "./lib"` and `export * from "./primitives"`.
- `pnpm-lock.yaml`: new deps only.

**Tests / checks** (`packages/ui`, 10 files, 167 tests)

- `lib/money.test.ts`, `primitives/Amount.test.tsx` (₹0, ₹99, ₹1,00,000, ₹1,23,456, bigint, negatives as
  credit without a minus, balance/due/neutral colouring, labels, refuses floats), `primitives/AmountInput.test.tsx`
  (types 450 → 45000 paise; `.`/decimals, negatives, letters and > `maxPaise` refused with the field unchanged;
  pasted `1,23,456` and `४५०`; cleared → null; hidden paise field in FormData; controlled mode; axe).
- `primitives/controls.test.tsx`: Button (Tab/Enter/Space, variants, sizes, loading, asChild link),
  IconButton (aria-label, tooltip on keyboard focus, showLabel), Input/Textarea/Select (Tab order, typing,
  select), Checkbox (Space, click on word, description), RadioCards (Tab into checked tile, ArrowDown moves and
  selects, disabled tile, FormData) — each runs **axe-core** (WCAG 2.0–2.2 A/AA tags) with zero violations.
  `display.test.tsx`: StatusPill (each variant's icon + colour + word), Spinner, Card, Divider, VisuallyHidden,
  and a non-vacuity check that axe does report an unlabelled input and a nameless button.
- `primitives/tokens-only.test.ts` (acceptance 1): scans every non-test file in `src/primitives` and `src/lib`
  for hex colours, CSS colour functions, CSS lengths (`px`, `rem`, `em`, …), Tailwind arbitrary values /
  properties / variants / `(--var)` shorthands, inline `style={{}}`, shadows and gradients, stock palette names,
  opacity utilities and runtime-built class names (`text-${x}`); each rule is proven to fire on a sample.
- `primitives/classes.test.tsx`: renders every primitive in every variant (and an open tooltip), collects every
  class in the DOM and asks Tailwind (`__unstable__loadDesignSystem` on the committed `theme.css`) for its CSS:
  every class must exist in the token theme (catches `bg-white`, `text-xs`, typos, which otherwise render as
  nothing); also asserts the focus ring resolves to `var(--color-focus)` and no shadow/gradient CSS is emitted.
- `lib/cn.test.ts`: merge behaviour + token lists equal the names in `theme.css`.
- Proved the checks bite: temporarily changing Button's quiet variant to `bg-white h-[44px]` failed the
  tokens-only test (3 rules) and the class-existence test; reverted.

**Verification** (Node v24.21.0, pnpm 12.11.2, `TURBO_FORCE=1`)

- `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; ui 167 tests), `pnpm build` (9/9),
  `pnpm generate` (no diff), `pnpm tokens:build --check`, `pnpm icons:build --check`,
  `pnpm --filter @cb/i18n i18n:build --check`, `node scripts/tasks.mjs check --local`: all pass.
- In the real app (temporary, uncommitted `/dev/uiprobe` page imported from `@cb/ui` in a **server component**,
  `next build` + `next start` + Playwright with the pre-installed Chromium): builds and renders with no runtime
  errors; md button / input / icon button measured 44px tall (lg 48px); primary button `rgb(17,17,17)` on white,
  `box-shadow: none`, radius 8px; keyboard focus gives a 2px solid `rgb(37,99,235)` outline; the due Amount is
  `rgb(185,28,28)`, 36px, `font-feature-settings: "tnum"`, text `₹1,23,456Due`; the icon button's tooltip
  opens on focus; typing `12.5` into AmountInput leaves `125` and the hidden field `12500`. Screenshot checked by
  eye (pills, tiles, spinner, ₹ prefix). The page and spec were deleted afterwards.

**For later tasks**

- T-007 (composites: Dialog, ConfirmSheet, Toast, Table, Stepper, PageHeader, LanguageSwitch, Combobox):
  reuse `cn`, `focusRing`, `fieldBase`, `buttonClasses`; add new primitives under `src/primitives/` so the
  tokens-only and class-existence tests cover them automatically (or extend the scanned dirs / the Gallery).
- When T-024 lands, swap `lib/money.ts` internals for `@cb/domain` (keep the exported names or re-export).
- Feature tasks: put the visible words in i18n (`common` has `due`, `cash`, `saved_on_phone`, …) and pass them
  as `label` / `dueLabel` / `creditLabel` / `loadingLabel`.

## Board log

- 2026-10-13T06:06:09.170Z claimed by agent-t006
- 2026-10-13T06:22:31.651Z completed on task/T-006-web-ui-primitives
