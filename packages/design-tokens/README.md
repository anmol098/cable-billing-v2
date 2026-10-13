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
