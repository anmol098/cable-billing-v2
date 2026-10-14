---
id: T-087b
title: Language switch label (accessible name, Devanagari font on English pages)
phase: 4
area: web-ui
status: done
owner: agent-t087b
claimed_at: 2026-10-14T20:57:22.784Z
branch: task/T-087b-language-switch-label-accessible-name-de
depends_on: [T-087a]
review: self
claimable_by: agent
size: S
paths: [packages/ui/src/composites/LanguageSwitch.tsx, packages/ui/src/composites/layout.test.tsx, apps/web/src/components/locale-switch.tsx]
---

# T-087b — Language switch label (accessible name, Devanagari font on English pages)

**Phase** 4 · **Area** web-ui · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-087a

## Goal

The `EN | हिं` switch passes Lighthouse's `label-content-name-mismatch` audit, and English pages
stop downloading the 121 KB Noto Sans Devanagari face only to draw the three letters of "हिं".

## Scope

- **Accessible name** (found in T-087, still open after T-087a): each button's visible text is
  the short form (`EN`, `हिं`) but its `aria-label` is the full name (`English`, `हिंदी`), so
  Lighthouse flags `label-content-name-mismatch` on every page (WCAG 2.5.3 "label in name"). Make
  the accessible name contain the visible text, e.g. `aria-label="हिं, हिंदी"` or the full name in a
  visually hidden span after the short form. Keep `getByRole("button", { name: "हिंदी" })` working
  (substring match) or update the e2e callers (`smoke.spec.ts`, `marketing.spec.ts`, others that
  switch language) in the same PR.
- **Font on English pages:** the Devanagari `@font-face` is global (`apps/web/src/app/fonts.ts`),
  so any Devanagari letter on a page downloads the whole face (121 KB), and the switch puts "हिं" on
  every English page. A face cannot be chosen per locale from `fonts.ts` alone (T-087a tried:
  `unicode-range` cannot tell the switch from Hindi content, and a partial "हिं"-only face would
  split Hindi clusters across two faces). Options: a design token for a system font stack
  (`system-ui`, which is Noto Sans Devanagari on Android) used by the switch's other-script button;
  or registering the web face only when `<html lang="hi">`. Decide with the design-token owner
  (no hard-coded font names).

## Out of scope

- Changing the switch's look or its no-JavaScript form.

## Acceptance criteria

- [x] Lighthouse shows no `label-content-name-mismatch` on `/`, `/login`, `/home` in en and hi.
- [x] On English pages without Devanagari content, no Devanagari font file is requested; Hindi
      pages still render in Noto Sans Devanagari (`e2e/smoke.spec.ts`).

## Tests required

- Component test for the accessible names; an e2e check of the fonts an English page requests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/ui/src/composites/LanguageSwitch.tsx`, `packages/ui/src/composites/layout.test.tsx`, `apps/web/src/components/locale-switch.tsx`

## References

PLAN §2.2 rule 10 (language one tap away), PLAN §6.3 (fonts), T-087a completion notes (measured
cost: in T-087a's Lighthouse runs, blocking the face on English pages did not move the score
measurably on a busy machine; it is 121 KB of transfer on a first visit).

## Completion notes

Both criteria are met. English pages no longer download the 119 KiB Devanagari face, and
`label-content-name-mismatch` passes on all 8 page/locale pairs. The switch's look and its
no-JavaScript form are unchanged, apart from the font of the other language's button (below).

**What changed**

| File | Change |
|---|---|
| `packages/ui/src/composites/LanguageSwitch.tsx` | **Accessible name:** `aria-label` is now `` `${short}, ${name}` `` (`EN, English`, `हिं, हिंदी`). It starts with the visible text, so it passes WCAG 2.5.3. **Font:** the current language's button keeps `font-sans`. The other language's button uses the new `font-system` token (the device's own font, which has no `@font-face`). So on an English page, "हिं" no longer makes the browser fetch Noto Sans Devanagari. |
| `packages/design-tokens/tokens.json` → `theme.css`, `Tokens.kt` (generated) | New token `font.family.system = ["system-ui", "sans-serif"]`, giving `--font-system` / `font-system` and `Tokens.Font.SystemFamilies` (not used on Android). README row updated. |
| `packages/ui/src/lib/cn.ts` (T-006, done) | Added `"system"` to `THEME_FONTS`. Without it, tailwind-merge cannot tell `font-system` (family) from `font-strong` (weight). `cn.test.ts` checks this list against `theme.css`. |
| `packages/ui/src/composites/layout.test.tsx` | New tests: exact accessible names in both locales, each name starting with `<visible text>, `, and which button gets `font-sans` / `font-system` on an en and a hi page. |
| `apps/web/e2e/language-switch.spec.ts` (new) | `/`, `/pricing` and `/login` in en: no request matches `noto_sans_devanagari_devanagari`, no loaded `Noto Sans Devanagari` face, "हिं" computes to `system-ui…`, and "EN" stays on `Inter, "Noto Sans Devanagari"…`. `/` in hi: the face is requested exactly once and loaded, and both "हिं" and the h1 use it. The existing `smoke.spec.ts` Noto check still passes unchanged. |
| `shell.test.tsx`, `locale-switch.test.tsx`, `marketing.test.tsx`, `dev/ui/page.test.tsx` (T-029/T-005/T-087/T-007, done) | Testing Library compares `name` strings exactly, so their `"English"` / `"हिंदी"` queries now say `"EN, English"` / `"हिं, हिंदी"`. Playwright matches substrings, so no e2e caller needed a change. |

**Why `font-system` and not the other options**

- *Register the web face only on `lang="hi"`*: this would also draw Devanagari customer names on
  English pages in the system font, and it is outside these paths (`fonts.ts`).
- *A subset face for "हिं"*: needs committed font binaries (T-005 said no). T-087a also found it
  splits Hindi clusters across two faces.
- *SVG wordmark*: would tie the component to one string from i18n.
- `system-ui` is Noto Sans Devanagari on Android, Nirmala UI on Windows and Kohinoor on Apple
  devices. Only the *other* language's button uses it. On a Hindi page, "EN" is drawn in the
  device font as well, a near-identical sans; Inter is loaded there anyway, so this saves nothing,
  but it keeps one simple rule.

**Measurements.** Production build, `next start`, Lighthouse 12.8.2 mobile preset (simulated
throttling), 3 runs per page, median shown. "/home" is a signed-in owner with 2 customers. There is
no Sentry DSN, the same as T-087a. Load average was 3.5–6 during the before runs and 6–9 during the
after runs (4 CPUs), so the after runs had the busier machine.

| Page | Total KiB | Font KiB | Perf runs before (median) | Perf runs after (median) | LCP median s | a11y | `label-content-name-mismatch` |
|---|---|---|---|---|---|---|---|
| `/` en | 385 → 266 | 182 → 63 | 88, 89, 93 (89) | 94, 91, 74 (91) | 3.22 → 2.61 | 100 → 100 | fail → pass |
| `/` hi | 391 → 392 | 182 → 182 | 89, 87, 67 (87) | 89, 86, 88 (88) | 3.34 → 3.34 | 100 → 100 | fail → pass |
| `/pricing` en | 384 → 265 | 182 → 63 | 82, 89, 72 (82) | 77, 92, 82 (82) | 3.33 → 2.75 | 100 → 100 | fail → pass |
| `/pricing` hi | 390 → 390 | 182 → 182 | 91, 90, 79 (90) | 82, 88, 93 (88) | 3.22 → 2.52 | 100 → 100 | fail → pass |
| `/login` en | 391 → 272 | 167 → 48 | 90, 59, 93 (90) | 90, 83, 77 (83) | 3.25 → 2.84 | 100 → 100 | fail → pass |
| `/login` hi | 397 → 397 | 167 → 167 | 87, 93, 82 (87) | 89, 87, 90 (89) | 3.41 → 3.39 | 100 → 100 | fail → pass |
| `/home` en | 439 → 319 | 182 → 63 | 80, 84, 85 (84) | 75, 89, 83 (83) | 3.71 → 3.27 | 100 → 100 | fail → pass |
| `/home` hi | 445 → 445 | 182 → 182 | 81, 86, 75 (81) | 92, 71, 86 (86) | 3.69 → 2.89 | 100 → 100 | fail → pass |

- **Bytes:** every English page is 119–120 KiB lighter (the Devanagari face). Hindi pages are
  unchanged. The 14 KiB `noto_sans_devanagari_latin_ext` file still loads on pages with `₹`: it is
  T-087a's `₹` face, registered as `Inter`, not the Devanagari script face.
- **Scores:** the median LCP on English pages dropped by 0.4–0.6 s in every pair. The performance
  scores moved by up to 30 points between identical runs (TBT dominates, as in T-087a), so no score
  change can be claimed from these numbers. The a11y score was 100 before as well: Lighthouse gives
  `label-content-name-mismatch` a weight of 0. It showed as failed before (on the `EN` button: axe
  4.14 matches whole words, so "en" is not found in "English") and passes now.
- **Eye check:** screenshots of the switch at 360px in en and hi. "हिं" is drawn in the system face,
  cleanly, with no tofu.

**Follow-ups (not done, outside these paths)**

- The receipt page (`/r/<token>`) has its own "हिंदी" link, so English receipts still load the face.
  Moving that link to `font-system` would save the same 119 KiB there.
- Lighthouse mobile ≥ 90 still needs a quiet machine or a Vercel preview (H-01).

**Verification** (Node v24.21.0, pnpm 12.11.2, PostgreSQL 17, scratch DB `cb_t087b`, since dropped)

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
  `TURBO_FORCE=1 pnpm test --concurrency=1`, `pnpm build`.
- `pnpm generate` leaves no diff. `tokens:build --check`, `icons:build --check`, `i18n:build --check`,
  `openapi:build --check`, `node scripts/tasks.mjs check --local`.
- `pnpm --filter web test:e2e` on a fresh scratch DB (production build, pre-installed Chromium):
  **127 passed**, including the 4 new `language-switch.spec.ts` tests and `smoke.spec.ts`.
- All of the above were run again after rebasing onto `feature/mvp` at `d3e0d22`. Android: only
  the generated `Tokens.kt` gained one `val`, and Gradle was not run locally (CI's `Android` job
  covers it).

## Board log

- 2026-10-14T20:57:22.794Z claimed by agent-t087b
- 2026-10-14T21:26:21.496Z completed on task/T-087b-language-switch-label-accessible-name-de
