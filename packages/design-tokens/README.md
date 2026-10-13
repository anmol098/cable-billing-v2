# @cb/design-tokens

`tokens.json` is the **one place** for colours, fonts, type sizes, radius, borders, spacing and
sizes (PLAN §6, D-04). A generator turns it into the files both apps use:

| Generated file (committed, never edit by hand) | Used by |
|---|---|
| `packages/ui/src/theme.css` | Web: Tailwind CSS v4 `@theme`. Import it as `@cb/ui/theme.css`. |
| `apps/android/core/designsystem/src/main/java/com/cablebilling/designsystem/generated/Tokens.kt` | Android: `Tokens.Color.Cash`, `Tokens.Type.Amount`, … |

## Change a colour

1. Edit the value in `tokens.json`, for example the brand accent:

   ```json
   "accent": { "value": "#0F766E" }
   ```

   Colours are hex: `#RRGGBB`, or `#RRGGBBAA` with alpha.
2. Regenerate from the repo root:

   ```bash
   pnpm tokens:build
   ```

   This rewrites `theme.css` and `Tokens.kt` (only the lines for that colour change).
3. Commit `tokens.json` **and** both generated files together.

CI runs `pnpm tokens:build --check`, which fails if the generated files don't match `tokens.json`.
`pnpm test` in this package checks the same thing.

## Commands

```bash
pnpm tokens:build                                   # regenerate (root shortcut)
pnpm tokens:build --check                           # exit 1 if a generated file is stale or missing
pnpm --filter @cb/design-tokens tokens:build [--check]
pnpm generate                                       # every generator in the repo (turbo), tokens included
```

## What is in `tokens.json`

| Group | Web output | Android output |
|---|---|---|
| `color.*`, `semantic.*` | `--color-<name>` → `bg-bg`, `text-cash`, `border-border` | `Tokens.Color.<Name>` (Compose `Color`) |
| `font.family.*` | `--font-<name>` → `font-sans`, `font-numeric` (with tabular figures) | `Tokens.Font.<Name>Families`, `<Name>FeatureSettings` |
| `font.weight.*` | `--font-weight-<name>` → `font-regular`, `font-strong` | `Tokens.Weight.<Name>` (`FontWeight`) |
| `type.web` / `type.android` | `--text-<step>` in rem → `text-base`, `text-amount` | `Tokens.Type.<Step>` in sp (`2xl` → `Xxl`) |
| `radius.*` | `--radius-<name>` in rem → `rounded-md` | `Tokens.Radius.<Name>` in dp |
| `border.*` | `@utility border-<name>` (+ `-x/-y/-t/-r/-b/-l`) → `border-hairline` | `Tokens.Border.<Name>` in dp |
| `space.base` | `--spacing` → every `p-*`, `gap-*`, `m-*` is a multiple | `Tokens.Space.Base` in dp |
| `size.*` (`web`/`android`) | `--spacing-<name>` → `min-h-touch-min`, `h-primary-button` | `Tokens.Size.<Name>` in dp |
| `elevation.*` | none: all shadows are removed | `Tokens.Elevation.<Name>` in dp |

Numbers are px on the web (converted to rem, 16px = 1rem; borders stay px) and dp/sp on Android.

The web theme **clears Tailwind's defaults** for colours, fonts, font weights, font sizes, radii and
shadows. `bg-red-500`, `text-xs`, `shadow-md` or `font-bold` do not exist; only tokens do. Every token
is also a CSS variable (`var(--color-cash)`) because the theme is `@theme static`.

## Rules

- Names are camelCase (`textMuted`); type steps may also be `2xl`…`9xl`. CSS gets kebab-case
  (`text-muted`), Kotlin gets PascalCase (`TextMuted`).
- The build fails on a missing required token, a non-hex colour, a negative size, an unknown key,
  a name used by both `color` and `semantic`, a colour named like a type step (`text-<name>` would
  be ambiguous), or type steps that differ between web and Android.
- Semantic colours carry fixed meanings (PLAN §2.2). Change their values, not their meaning.
- Never hard-code colours, sizes or radii in apps. Add a token here instead.

## Code

- `src/schema.ts`: Zod schema and `parseTokens()` (validation with readable errors).
- `src/transform.ts`: pure transforms (px→rem, hex→Compose `Color(0xFF…)`, dp/sp, names).
- `src/css.ts`, `src/kotlin.ts`: the two renderers. `src/outputs.ts`: output paths.
- `src/fs.ts`: reading `tokens.json`, writing and checking files (Node only).
- `scripts/build.ts`: the CLI behind `tokens:build` and `generate`.

## Icons

`icons.json` maps a **semantic name** (what the icon means: `cash`, `pending`, `whatsapp`) to a
[Lucide](https://lucide.dev) icon name. `pnpm icons:build` reads the glyphs from the installed
`lucide-static` package (no network) and writes:

| Generated file (committed, never edit by hand) | Used by |
|---|---|
| `packages/ui/src/icons/icons.generated.ts` (+ `LICENSE-lucide.txt`) | Web: `<Icon name="cash" />` from `@cb/ui` |
| `apps/android/core/designsystem/src/main/res/drawable/ic_cb_<name>.xml` | Android: `R.drawable.ic_cb_cash` |

Add an icon:

1. Find the glyph on lucide.dev and add `"<meaning>": "<lucide-name>"` to `icons.json`. Names are
   lowercase kebab-case (`log-out` becomes `ic_cb_log_out` on Android). Use Lucide's current
   name; old aliases (`home`, `check-circle`, `alert-triangle`) are rejected.
2. Run `pnpm icons:build` and commit `icons.json` with the generated files. Removing a name also
   deletes its drawable.

Rules: one meaning per name, the same glyph on web and Android (PLAN §2.2, E-09). No brand logos:
`whatsapp` is a plain speech bubble. Icons are drawn in the current text colour, so colour them
with token utilities (`text-cash`) on the web and token colours (`tint = Tokens.Color.Cash`) on
Android. CI runs `pnpm icons:build --check`, which fails on a missing, stale or left-over file.

Code: `src/icons/manifest.ts` (validation), `src/icons/svg.ts` (Lucide shapes → path data),
`src/icons/android.ts` (VectorDrawable XML), `src/icons/react.ts` (React data module),
`src/icons/outputs.ts`, `src/icons/fs.ts` (Node only), `scripts/icons.ts` (CLI).
