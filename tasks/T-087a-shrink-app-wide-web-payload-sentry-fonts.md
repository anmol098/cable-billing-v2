---
id: T-087a
title: Shrink the app-wide web payload (Sentry bundle, fonts)
phase: 4
area: web
status: done
owner: agent-t087a
claimed_at: 2026-10-14T11:47:39.092Z
branch: task/T-087a-shrink-the-app-wide-web-payload-sentry-b
depends_on: [T-087]
review: self
claimable_by: agent
size: S
paths: [apps/web/next.config.ts, apps/web/src/instrumentation-client.ts, apps/web/src/app/fonts.ts, apps/web/src/lib/sentry.ts]
---

# T-087a — Shrink the app-wide web payload (Sentry bundle, fonts)

**Phase** 4 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-087

## Goal

Every web page (public pages included) scores Lighthouse mobile performance ≥ 90 reliably, by
cutting JavaScript and font bytes that every page pays for.

## Scope

Measured in T-087 (production build, `next start`, Lighthouse 12.8.2 mobile preset, simulated
throttling, on a busy 4-CPU container): scores 86–99 across `/`, `/pricing`, `/privacy`, `/terms`,
`/contact` in en/hi; `/login` scored 85. Transfer per page ~390–480 KiB, of which:

- **Sentry browser SDK: ~128 KB gzip** in one chunk, loaded on every page even when
  `NEXT_PUBLIC_SENTRY_DSN` is unset (Lighthouse "unused JavaScript" ~100 KB). Try
  `withSentryConfig` `bundleSizeOptimizations` (exclude debug, replay/iframe/shadow-DOM code we
  don't use, maybe tracing if 10 % sampling isn't needed in the browser), or lazy-load the SDK.
- **Fonts: up to ~257 KB on one page.** Inter `latin` (49 KB) always; Inter `latin-ext` (86 KB)
  on every page that shows `₹` (U+20B9 is in that subset); Noto Sans Devanagari (122 KB) on
  **English** pages too, only because the language switch shows "हिं". Options: subset Inter
  latin-ext or drop it from the stack for `₹` (Noto Sans Devanagari also has U+20B9; check the look),
  and/or render the "हिं" button so it doesn't pull the whole Devanagari face on English pages.
- T-087 already removed Zod from the browser (−33 KB gzip: `instrumentation-client.ts` no longer
  imports `@/env`).
- Minor: Lighthouse `label-content-name-mismatch` on the language switch (visible "हिं", accessible
  name "हिंदी"; T-007's `LanguageSwitch`) and the missing favicon (H-02).

## Out of scope

- Changing what Sentry collects (E-08 privacy settings stay).

## Acceptance criteria

- [ ] Lighthouse mobile performance ≥ 90 on `/`, `/pricing`, `/login`, en and hi, over 3 runs.
- [x] Hindi still renders in Noto Sans Devanagari and amounts in tabular figures (`e2e/smoke.spec.ts`).

## Tests required

- Existing smoke/e2e tests; record before/after bytes and scores in the completion notes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/next.config.ts`, `apps/web/src/instrumentation-client.ts`, `apps/web/src/app/fonts.ts`, `apps/web/src/lib/sentry.ts`

## References

PRD §11 (low-bandwidth payloads), PLAN §17, E-08 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`.

## Completion notes

**First acceptance criterion not ticked.** Every page now transfers 53–123 KiB less (table
below), and the median Lighthouse score went up on 7 of 8 page/locale pairs. But the container
was shared and very busy (load average 12–37 on 4 CPUs during the runs), so scores moved 20–40
points between identical runs. Only `/pricing` (en) reached a median of 90. "≥ 90 reliably"
could not be shown on this machine. Total Blocking Time decides the score here, and it comes
from Next.js/React running on a slowed CPU, not from our bytes. Please re-measure on a quiet
machine or against a Vercel preview (PageSpeed Insights).

**What changed**

| File | Change |
|---|---|
| `src/instrumentation-client.ts` | No static `@sentry/nextjs` import any more. It calls `startBrowserSentry(...)` and exports the hook it returns as `onRouterTransitionStart`. The SDK is loaded with `const { init, captureException, captureRouterTransitionStart } = await import("@sentry/nextjs")`. The destructuring matters: returning the whole namespace kept Replay, Feedback and the rest in the chunk (≈148 KB gzip instead of ≈52 KB). |
| `src/lib/sentry.ts` | `sentrySharedOptions` (E-08) is unchanged. New `startBrowserSentry({ dsn, environment, load, target })`. **Without a DSN** it does nothing: no listeners and no download. **With a DSN** it listens for `error` / `unhandledrejection` from the first line of client code and keeps up to `EARLY_ERROR_LIMIT` (20) errors. After the window `load` event, plus `requestIdleCallback` (timeout 3 s; a `setTimeout` fallback for Safari), it loads the SDK, runs `init({ ...sentrySharedOptions, dsn, environment })`, removes its own listeners (the SDK's global handlers take over) and sends the kept errors with `mechanism: { type: "auto.browser.global_handlers.onerror" \| "…onunhandledrejection", handled: false }`, the same as the SDK's own handlers. If the chunk fails to load, the page keeps working without Sentry. Router transitions are forwarded once the SDK is up and ignored before that. |
| `next.config.ts` | `compiler.define: { __SENTRY_DEBUG__: false }` strips the SDK's debug logger. `withSentryConfig`'s `webpack.treeshake` / `bundleSizeOptimizations` options are webpack-only and `next build` uses Turbopack, so they did nothing here. Checked: no `__SENTRY_DEBUG__` remains in any client chunk. Tracing stays (`__SENTRY_TRACING__` not set): E-08 / PLAN §16 want errors **and** performance. |
| `src/app/fonts.ts` | `₹` (U+20B9) is cut out of Inter `latin-ext`'s `unicode-range`. A new face `interRupee` covers only U+20B9, uses Noto Sans Devanagari's `latin-ext` file (13.8 KB, OFL, variable weight, from the existing Fontsource package, so no committed binaries) and is registered as family **`Inter`**, so both token stacks (`--font-sans`, and `--font-numeric`, which has no Devanagari face) use it with no CSS or token change. `size-adjust: 117%` corrects the metrics: Noto draws `₹` 0.622 em tall, Inter's sign and digits are 0.728 em (measured with fontTools), so the sign is as tall as the digits next to it again. Screenshots of `/pricing` and `/dev/type` at 360px, before and after in en and hi, checked by eye: same height, about 1 px wider at 3× scale. |
| `src/lib/sentry.test.ts` (new, next to the owned file) | 8 tests: no DSN means no load and no listeners; loads only after `load` + idle; `init` gets the E-08 `dataCollection` exactly; early error and rejection are sent after `init`, marked unhandled, and later errors are not sent twice; the 20-error cap; router hook before and after start; a failed chunk load; the Safari timer fallback. |
| `tasks/T-087b-…md` (new) | Follow-up for the two items outside these paths (below). |

**Bytes and scores.** Production build, `next start`, Lighthouse 12.8.2 mobile preset, simulated
throttling, 3 runs per page, median shown. "/home" is a signed-in owner with 2 customers and
bills. Both columns have no `NEXT_PUBLIC_SENTRY_DSN`, the same setup as T-087's numbers. Transfer
is in KiB.

| Page | Total before → after | JS | Fonts | Perf runs before (median) | Perf runs after (median) |
|---|---|---|---|---|---|
| `/` en | 500 → 378 | 207 → 154 | 251 → 182 | 83, 82, 75 (82) | 94, 79, 86 (86) |
| `/` hi | 505 → 383 | 207 → 154 | 251 → 182 | 73, 95, 48 (73) | 87, 87, 85 (87) |
| `/pricing` en | 499 → 376 | 207 → 154 | 251 → 182 | 68, 78, 71 (71) | 90, 90, 87 (90) |
| `/pricing` hi | 504 → 381 | 207 → 154 | 251 → 182 | 68, 68, 0* (68) | 82, 75, 86 (82) |
| `/login` en | 436 → 383 | 227 → 174 | 167 → 167 | 79, 82, 58 (79) | 85, 86, 82 (85) |
| `/login` hi | 441 → 388 | 227 → 174 | 167 → 167 | 93, 89, 73 (89) | 88, 85, 85 (85) |
| `/home` en | 554 → 431 | 240 → 187 | 251 → 182 | 85, 80, 82 (82) | 85, 70, 87 (85) |
| `/home` hi | 558 → 435 | 240 → 187 | 251 → 182 | 87, 73, 43 (73) | 86, 87, 79 (86) |

\* The browser tab crashed (machine load), so that run scored 0.

- **JS (−53 KiB on every page):** the Sentry browser SDK is ≈52 KB gzip after the debug-logger
  removal. The 127 KB chunk that T-087 measured also held ≈73 KB of Next.js/React runtime, which is
  still loaded. With a DSN (production), the SDK chunk is still downloaded, but only after the page
  has loaded. It no longer competes with hydration for bandwidth and the main thread.
- **Fonts (−69 KiB on every page with `₹`):** Inter `latin-ext` (85 KB) → the `₹` face (13.8 KB).
  `/login` shows no `₹`, so it is unchanged.
- **With a DSN** (build with `NEXT_PUBLIC_SENTRY_DSN` pointing at a local stand-in): initial
  JS is the same as without, and Lighthouse also counts the lazy chunk (206/227/240 KiB JS by the
  end of the trace). The medians were 81/75/67/73/76/64/85/65 for the eight rows. That run was at
  load average 27–30, which was higher than for either table above, so it can't be compared with
  them.
- **Experiment, Devanagari blocked on English pages** (what T-087b would save, 121 KB): `/` en
  82, `/pricing` en 78, so no measurable gain at this load.

**Error capture still works**: a manual check against the DSN build. A local stand-in ingest server
(`http://key@localhost:3399/1`) and a Playwright script opened `/`. The SDK was **not** present at
`domcontentloaded`, and its chunk was requested about 330 ms after the 8 page scripts. An error and
a promise rejection thrown before that, plus an error thrown after it, all arrived as envelopes. The
early error arrived as `mechanism {type: "auto.browser.global_handlers.onerror", handled: false}`
with `BrowserTracing` among the SDK integrations. There was no `user`, no cookies and no session
token in any envelope. The unit tests above cover the same logic.

**Decisions**

- **Lazy-load rather than slim the SDK down.** Tracing and the default integrations stay, as E-08
  asks. The cost is that router transitions in the first second or two aren't traced, and an error
  thrown before `instrumentation-client` runs isn't kept (the same as before).
- The DSN is still read literally (`process.env.NEXT_PUBLIC_SENTRY_DSN`), so builds without one
  never fetch the SDK.
- I didn't commit any font subset binaries (T-005 decision). The `₹` face reuses an npm file.

**Not done, outside these paths: new task T-087b**

- `label-content-name-mismatch`: T-007's `LanguageSwitch` (`packages/ui/src/composites/LanguageSwitch.tsx`)
  shows `EN` / `हिं` but has `aria-label` `English` / `हिंदी`. Lighthouse still flags it on every page.
- The Devanagari face (121 KB) still loads on English pages for the "हिं" label. `fonts.ts` alone
  can't fix this: `unicode-range` can't tell the label from Hindi content, and a "हिं"-only partial
  face would split Hindi clusters across two faces. It needs a token or a switch change (T-087b
  lists the options).
- The favicon 404 (H-02) is still open.

**Verification** (Node v24.21.0, pnpm 12.11.2, PostgreSQL 17, scratch DB `cb_t087a`)

- `pnpm lint`, `pnpm typecheck` (10/10). `pnpm test`: the first run had one failure in
  `counter-payment.test.tsx` (T-047's component test, a timeout at load average 31+). It passed
  alone and in the re-runs below.
- `pnpm generate` leaves no diff. `tokens:build --check`, `icons:build --check`, `i18n:build --check`,
  `pnpm --filter @cb/contracts openapi:build --check`, `node scripts/tasks.mjs check --local`.
- `pnpm --filter web test:e2e` (production build without a DSN, scratch DB, pre-installed Chromium):
  **95 passed**. That includes `smoke.spec.ts`: Hindi still in Noto Sans Devanagari, amounts still
  in tabular figures (`₹1,11,111` and `₹8,88,888` the same width with the new `₹` face), and no
  CSP reports. It also includes `marketing.spec.ts`: no console errors or failed requests on the
  public pages.

## Board log

- 2026-10-14T11:47:39.092Z claimed by agent-t087a
- 2026-10-14T13:16:44.344Z completed on task/T-087a-shrink-the-app-wide-web-payload-sentry-b
