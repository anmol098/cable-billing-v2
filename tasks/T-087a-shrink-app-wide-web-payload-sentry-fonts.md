---
id: T-087a
title: Shrink the app-wide web payload (Sentry bundle, fonts)
phase: 4
area: web
status: todo
owner:
claimed_at:
branch:
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
- [ ] Hindi still renders in Noto Sans Devanagari and amounts in tabular figures (`e2e/smoke.spec.ts`).

## Tests required

- Existing smoke/e2e tests; record before/after bytes and scores in the completion notes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/next.config.ts`, `apps/web/src/instrumentation-client.ts`, `apps/web/src/app/fonts.ts`, `apps/web/src/lib/sentry.ts`

## References

PRD §11 (low-bandwidth payloads), PLAN §17, E-08 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`.

## Completion notes

_The agent fills this in before opening the PR._
