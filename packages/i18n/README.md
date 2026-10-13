# @cb/i18n

One bilingual (English + Hindi) message source for the web app and the Android app (D-06).
Use the plain words in [`glossary.md`](./glossary.md).

## Layout

```text
packages/i18n/messages/en/<namespace>.json   English (source language)
packages/i18n/messages/hi/<namespace>.json   Hindi, same keys, plus a `_review` list
```

- **One namespace per feature** (`bills.json`, `customers.json`, `mobile_collect.json`, …). Each task
  owns its namespace file, so parallel tasks don't conflict. `common.json` is shared: append keys,
  don't reorder.
- Namespaces and keys are `snake_case` (`[a-z][a-z0-9_]*`). Keys may be grouped one level or more
  (`{ "status": { "saved": "…" } }` → key `status.saved`).
- Values are [ICU MessageFormat](https://formatjs.github.io/docs/core-concepts/icu-syntax) strings,
  as next-intl reads them: `{name}`, `{count, number}`, `{count, plural, one {# bill} other {# bills}}`.
  An apostrophe is literal (`Don't`) unless it quotes ICU syntax (`'{'`); `''` is one apostrophe.
- **Amounts and dates are formatted in code** and passed as text (`"₹{amount} due"`), so web and
  Android show identical Indian grouping (`₹1,23,456`).
- `_review` (Hindi files only): the keys whose Hindi was drafted by an agent. Add every key you write
  in Hindi to it. The product owner reviews and removes them (D-23, H-03). It never reaches the
  generated files.

## Commands

```bash
pnpm i18n:check                              # = pnpm --filter @cb/i18n i18n:check: validate sources only
pnpm --filter @cb/i18n i18n:build            # validate, then write the generated files
pnpm --filter @cb/i18n i18n:build --check    # validate, then fail if a generated file is stale (CI)
pnpm generate                                # runs i18n:build via turbo, with the other generators
# add --fail-on-review to i18n:check or i18n:build to fail while `_review` flags remain (H-03 gate)
```

The check fails on: a namespace or key missing in one language, extra Hindi keys, invalid ICU
(including a plural/select without `other`), plural categories a language never uses (`few` in
Hindi), placeholder mismatch between English and Hindi (names and kinds must match), bad
`_review` entries, bad names, empty messages, control characters, and anything Android can't
express in `common` / `mobile_*`.

## Generated files (committed; never edit by hand)

| File | Contents |
|---|---|
| `apps/web/messages/en.json`, `hi.json` | next-intl messages: `{ "<namespace>": { "<key>": "<ICU>" } }`, all namespaces, keys sorted |
| `apps/android/app/src/main/res/values/strings_generated.xml` | English Android strings (default resource folder) |
| `apps/android/app/src/main/res/values-hi/strings_generated.xml` | Hindi Android strings (Hindi is the default *app* locale, set in code, D-06) |

Only `common` and `mobile_*` namespaces go to Android. The resource name is `<namespace>_<key>` with
groups joined by `_` (`mobile_collect` + `status.saved` → `R.string.mobile_collect_status_saved`).

Web usage (T-005): `useTranslations("common")("save")`, messages from `apps/web/messages/<locale>.json`.

## ICU → Android mapping

| ICU (source) | Android | Kotlin |
|---|---|---|
| `Save` | `<string name="common_save">Save</string>` | `stringResource(R.string.common_save)` |
| `₹{amount} from {name}` | `₹%1$s from %2$s` | `stringResource(R.string.x, amount, name)` |
| `{count, number} left` | `%1$d left` | `stringResource(R.string.x, count)` (an `Int`) |
| `{name}: {count, plural, one {# bill} other {# bills}}` | `<plurals>` with `one` = `%1$s: %2$d bill`, `other` = `%1$s: %2$d bills` | `pluralStringResource(R.plurals.x, count, name, count)` |

- **Argument numbers come from the English message**: `N` in `%N$` is the position where the
  argument first appears in English. Hindi reuses the English numbers even when it reorders words
  (`{name} से ₹{amount}` → `%2$s से ₹%1$s`), so Kotlin always passes arguments in one order. Each
  generated entry has a comment listing its arguments (`<!-- %1$s = amount, %2$s = name -->`).
- `{x}` → `%N$s`. `{x, number}` and `{x, number, integer}` → `%N$d`. A plural's count → `%N$d`.
- A message with one top-level plural becomes `<plurals>`; text around the plural is copied into each
  item and `#` becomes the count's `%N$d`. Always pass the count again as a format argument.
- **Not allowed** in `common` / `mobile_*` (check error): `select`, `selectordinal`, `date`/`time`,
  number styles/skeletons (`{x, number, ::currency/INR}`), rich-text tags (`<b>…</b>`), `=0`-style
  plural selectors, `offset`, nested or multiple plurals. Use separate keys or pre-formatted text.
  Web-only namespaces can use all of ICU.

Escaping (aapt2 + XML), handled by the generator: `\` → `\\`, `'` → `\'`, `"` → `\"`, newline →
`\n`, tab → `\t`, `&` `<` `>` → `&amp;` `&lt;` `&gt;`, a leading `@` / `?` → `\@` / `\?`, and
leading, trailing or repeated spaces → ` ` (aapt2 would trim or collapse them). A literal `%`
becomes `%%` in strings that take arguments (and in all plurals); a string without arguments keeps
`%` and gets `formatted="false"`.

## Code

`src/index.ts` (browser-safe) exports the validator and generators: `validateCatalog`,
`generateFiles`, `buildWebMessages`, `buildAndroidEntries`, `compileAndroid`, `escapeAndroid`,
`LOCALES`, `WEB_DEFAULT_LOCALE` (`en`), `ANDROID_DEFAULT_LOCALE` (`hi`), `isAndroidNamespace`.
`@cb/i18n/load` (Node only) reads the message folders. The CLI is `scripts/i18n.ts`.
