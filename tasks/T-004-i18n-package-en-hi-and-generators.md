---
id: T-004
title: i18n package (en + hi) and generators
phase: 0
area: i18n
status: done
owner: agent-t004
claimed_at: 2026-10-13T04:31:35.597Z
branch: task/T-004-i18n-package-en-hi-and-generators
depends_on: [T-001]
review: self
claimable_by: agent
size: M
paths: [packages/i18n/**, apps/web/messages/**, apps/android/app/src/main/res/values/strings_generated.xml, apps/android/app/src/main/res/values-hi/strings_generated.xml]
---

# T-004 — i18n package (en + hi) and generators

**Phase** 0 · **Area** i18n · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-001

## Goal

One bilingual message source for web and Android, organised to avoid merge conflicts between parallel tasks.

## Scope

- Source layout: `packages/i18n/messages/{en,hi}/<namespace>.json`, one namespace per feature (common, auth, customers, connections, plans, bills, payments, linemen, reports, settings, admin, mobile_*).
- `glossary.md`: the fixed term list (Bill not Invoice, Connection (VC), Saved on phone, Sent to office, …) in both languages.
- Generator: merges namespaces into `apps/web/messages/{en,hi}.json` (next-intl format) and into Android `strings_generated.xml` (keys `ns_key`, only namespaces prefixed `mobile_` + `common`).
- Checks: every key exists in both languages, no unused placeholder mismatch, ICU plural syntax valid; `--check` mode for CI.
- Seed `common` namespace (app name 'Cable Billing' / 'केबल बिलिंग', yes/no, save, cancel, back, retry, call office, amount formats).

## Acceptance criteria

- [x] Missing Hindi key fails `pnpm i18n:check`.
- [x] Generated files are deterministic (sorted keys).

## Tests required

- Unit tests for merge, placeholder parity and Android XML escaping (apostrophes, `%`, `&`).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/i18n/**`
- `apps/web/messages/**`
- `apps/android/app/src/main/res/values/strings_generated.xml`
- `apps/android/app/src/main/res/values-hi/strings_generated.xml`

## Notes

- Hindi copy is drafted by agents and reviewed by the product owner (D-23, task H-03). Mark machine-drafted strings in `hi/*.json` with a `_review` list per namespace so the reviewer can find them.

## References

D-06, PLAN §2.2 rule 5, PLAN §11.4 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

- `packages/i18n/messages/{en,hi}/common.json`: the shared `common` namespace (42 keys: app name, yes/no/OK,
  save/cancel/back/next/done/close/change/search/try again, call office, language names, the glossary nouns
  bill/receipt/customer/connection (VC)/VC number, collect/cash/UPI/due/credit, honest states saved on phone /
  sent to office / problem / WhatsApp opened / SMS opened, hand over cash, no internet, a generic error,
  amount formats `₹{amount}` / `₹{amount} due` / `₹{amount} credit`, and a `payment_count` plural).
  Every Hindi key is in `hi/common.json` `_review` (machine-drafted, D-23 / H-03).
- `packages/i18n/glossary.md`: bilingual plain-word list (core terms, money, honest states, button words,
  words never shown to users) with icon/colour pairing and "not this" columns.
- `packages/i18n/README.md`: source layout, commands, check rules, generated files and the ICU → Android mapping.
- `src/`: `locales.ts` (constants), `icu.ts` (formatjs parser wrapper, placeholder signatures, per-locale plural
  category check), `catalog.ts` (validation, merge, web output), `android.ts` (ICU → Android compile, aapt2/XML
  escaping, XML renderer), `generate.ts` (output paths + `generateFiles`), `load.ts` (Node-only file reader).
  CLI: `scripts/i18n.ts` (run with tsx).
- Generated and committed: `apps/web/messages/{en,hi}.json` (next-intl, all namespaces, keys sorted) and
  `apps/android/app/src/main/res/{values,values-hi}/strings_generated.xml` (`common` + `mobile_*` only).

**Commands**

- `pnpm i18n:check` (root) = `pnpm --filter @cb/i18n i18n:check`: validates sources only; exits 1 on any problem.
- `pnpm --filter @cb/i18n i18n:build` (also root `pnpm i18n:build`, and the package's `generate` script that
  `pnpm generate` runs through turbo): validate, then write the 4 generated files.
- `pnpm --filter @cb/i18n i18n:build --check`: validate, then exit 1 if a generated file is missing or stale
  (for T-010's generated-check). `--fail-on-review` on either command also fails while `_review` flags remain
  (an H-03 / release gate; not used in CI yet).

**Interfaces for later tasks**

- Feature tasks: add `packages/i18n/messages/en/<ns>.json` and `hi/<ns>.json` with identical keys; list every
  key whose Hindi you drafted in the Hindi file's `_review` array; run `pnpm --filter @cb/i18n i18n:build` and
  commit the regenerated files. Keys and namespaces are snake_case; nesting is allowed (`a.b` → web nested,
  Android `ns_a_b`). Format amounts/dates in code and pass them as text (`{amount}`).
- T-005 (web): import `apps/web/messages/<locale>.json` as next-intl messages; namespaces are top-level
  (`useTranslations("common")`). `@cb/i18n` exports `LOCALES`, `WEB_DEFAULT_LOCALE` (`en`), `Locale`; the entry is
  browser-safe (`@cb/i18n/load` is the Node-only reader).
- T-008 (Android): `values/strings_generated.xml` is English (default folder), `values-hi/` is Hindi; make Hindi
  the default app locale in code (`ANDROID_DEFAULT_LOCALE`). Resource names are `<namespace>_<key>`
  (`R.string.common_save`, `R.plurals.common_payment_count`). Argument `%N$` numbers come from the English
  message's order of first appearance and are listed in a comment above each entry; plurals take the count as a
  format argument too: `pluralStringResource(R.plurals.common_payment_count, n, n)`.
- In `common` / `mobile_*`, select, selectordinal, date/time, number styles, rich-text tags, `=N` selectors,
  offsets and nested/multiple plurals fail the check (Android can't express them). Web-only namespaces may use
  all of ICU.

**Decisions**

- ICU parsing uses `@formatjs/icu-messageformat-parser` 3.5.21 (the parser behind next-intl's intl-messageformat),
  with tags enabled and `other` required, so the check matches what the web will accept.
- Placeholder parity compares names *and* kinds (string/number/plural/select/date/time/tag), so a Hindi plural
  can't silently become a plain `{count}` (which would also break Android `<plurals>` vs `<string>`).
- Plural selectors the locale never produces (`few`/`many` in hi or en) are errors; `=N` is allowed on web.
- Android escaping: `\ ' "` backslash-escaped, `\n`/`\t`, `& < >` as entities, `@`/`?` escaped only when first,
  leading/trailing/repeated spaces as ` `. `%` → `%%` when the string has arguments (and in all plurals);
  arg-less strings containing `%` keep it raw and get `formatted="false"`. A test decodes the output with a model
  of aapt2's rules and checks it round-trips.
- Hindi word choices (all flagged for review): Credit = "एडवांस" (not "जमा"), Sent to office = "ऑफिस पहुँच गया",
  Try again = "फिर से करें", Share = "शेयर करें", Undo payment = "पेमेंट रद्द करें" (glossary).

**Deviations**

- Added `allowBuilds: { esbuild: false }` to root `pnpm-workspace.yaml` (T-001's file): tsx pulls in esbuild,
  and pnpm 12 fails `pnpm install --frozen-lockfile` on an undecided build script. esbuild's binary comes from its
  optional platform package, so its postinstall isn't needed. T-002 (tokens, also using tsx) needs the same entry.
- Added root scripts `i18n:build` / `i18n:check` (T-001 notes allow this). Replaced the placeholder
  `src/index.test.ts` with real tests.
- PLAN §11.4 names the Android files `strings.xml`; this task's paths say `strings_generated.xml`, which was used
  so hand-written Android strings (if ever needed) can live in `strings.xml` without being overwritten.
- `CLAUDE.md` Commands section not edited (not owned); the commands are in `packages/i18n/README.md`.

**Verification** (Node v24.21.0, pnpm 12.11.2)

- `pnpm install --frozen-lockfile`: ok. `pnpm lint`: Biome clean. `pnpm typecheck`, `pnpm test`, `pnpm build`:
  8/8 tasks successful. `@cb/i18n`: 41 tests (android escaping/placeholders/plurals/rejections + aapt2 round-trip,
  catalog validation and merge/determinism, loader, real-catalog validity and generated-file drift).
- `pnpm i18n:check`: ok (1 namespace, 42 keys, 42 flagged for review). `pnpm generate`: writes nothing new.
  `pnpm --filter @cb/i18n i18n:build --check`: "4 generated file(s) are up to date".
- Probes: deleting `back` from `hi/common.json` makes `pnpm i18n:check` exit 1 ("missing translation"); appending a
  space to `apps/web/messages/en.json` makes `i18n:build --check` exit 1 naming that file.
- No Android SDK here (dl.google.com is blocked), so the XML was not compiled with aapt2; T-008's build is the
  first real aapt2 pass over it.
- `node scripts/tasks.mjs check --local`: OK.

## Board log

- 2026-10-13T04:31:35.597Z claimed by agent-t004
- 2026-10-13T04:41:36.462Z completed on task/T-004-i18n-package-en-hi-and-generators
